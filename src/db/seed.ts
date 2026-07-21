// ---------------------------------------------------------------------------
// One-time bootstrap. See docs/SEED.md.
//
// This populates an EMPTY database from data/seed/*.json — committed snapshots
// extracted once from the original workbooks by scripts/extract_seed.py. The
// workbooks themselves are not read here and are not needed to run this: once
// seeded, Fred owns the data and the monthly close is what adds to it.
//
// It is deliberately not idempotent-safe-by-default: re-running it would
// destroy every monthly close entered since. A non-empty database is refused
// unless --force is passed.
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { isNotNull, sql } from "drizzle-orm";
import { db } from "./index";
import {
  accountEntries,
  accounts,
  appConfig,
  contributionLimits,
  employers,
  externalAccounts,
  paychecks,
  persons,
  properties,
  propertyPayments,
  propertyPaymentShares,
  propertyValuations,
} from "./schema";

const seedDir = path.join(process.cwd(), "data", "seed");
const force = process.argv.includes("--force");

/** Where are we about to write? Host only — never print the credentials. */
function describeTarget(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return "embedded PGlite at .data/pglite (local dev)";
  try {
    const u = new URL(url);
    return `Postgres at ${u.host}${u.pathname} (DATABASE_URL)`;
  } catch {
    return "Postgres (DATABASE_URL — unparseable, check the connection string)";
  }
}

/** Row counts for everything the seed would overwrite. */
async function existingCounts(): Promise<Record<string, number>> {
  const tables = {
    persons,
    accounts,
    account_entries: accountEntries,
    properties,
    property_payments: propertyPayments,
    employers,
    paychecks,
  };
  const out: Record<string, number> = {};
  for (const [label, table] of Object.entries(tables)) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
    if (row.n > 0) out[label] = row.n;
  }
  return out;
}

function load<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(seedDir, name), "utf8"));
}

type SeedEntry = {
  statementDate: string;
  contributionsPretax: number;
  contributionsRoth: number;
  contributionsAfterTax: number;
  employerContributions: number;
  transfersIn: number;
  growth: number;
  withdrawals: number;
  transfersOut: number;
  balance: number;
  detail: Record<string, number> | null;
};

type SeedAccount = {
  slug: string;
  name: string;
  institution: string;
  category: "cash" | "retirement" | "hsa" | "brokerage" | "crypto" | "property" | "other";
  taxTreatment: "taxable" | "traditional" | "roth" | "hsa" | "pension" | "na";
  owner: string;
  isActive: boolean;
  includeInNetWorth: boolean;
  taxLotGroup: string | null;
  sortOrder: number;
  entries: SeedEntry[];
};

type SeedProperty = {
  slug: string;
  name: string;
  address: string;
  purchasePrice: number;
  purchaseDate: string;
  originalLoan: number;
  equityShare: number;
  payments: {
    date: string;
    type: "down_payment" | "mortgage" | "hoa" | "fees" | "escrow" | "other";
    typeRaw: string;
    scott: number;
    kate: number;
    principal: number;
    interest: number;
    escrow: number;
    hoa: number;
    fees: number;
    loanBalanceAfter: number;
    notes: string | null;
  }[];
  valuations: { date: string; marketValue: number }[];
};

type SeedEmployer = {
  slug: string;
  name: string;
  person: string;
  paychecks: {
    paymentDate: string;
    payBeginDate: string | null;
    payEndDate: string | null;
    annualSalary: number;
    totalIncome: number;
    netPay: number;
    federalTax: number;
    totalTaxes: number;
    retirement401k: number;
    hsa: number;
    bonus: number;
    items: unknown;
  }[];
};

async function main() {
  console.log(`Target: ${describeTarget()}`);
  console.log(`Source: data/seed/*.json\n`);

  const existing = await existingCounts();
  if (Object.keys(existing).length > 0) {
    const summary = Object.entries(existing)
      .map(([t, n]) => `${t} ${n.toLocaleString()}`)
      .join(" · ");
    if (!force) {
      console.error(`This database already has data:\n  ${summary}\n`);
      console.error(
        "Refusing to overwrite. The seed is a one-time bootstrap — re-running it\n" +
          "would delete every monthly close entered since.\n\n" +
          "  To reset this database anyway:  npm run db:seed -- --force",
      );
      process.exit(1);
    }
    console.log(`--force: wiping existing data first:\n  ${summary}\n`);
    // external_accounts.linked_account_id has no ON DELETE rule, so links must
    // be cleared before accounts can go — otherwise the wipe fails halfway and
    // leaves a half-destroyed database. Unlinking (rather than deleting) keeps
    // the synced provider records and returns them to the review queue.
    const relinked = await db
      .update(externalAccounts)
      .set({ linkedAccountId: null, matchStatus: "pending" })
      .where(isNotNull(externalAccounts.linkedAccountId))
      .returning({ id: externalAccounts.id });
    if (relinked.length > 0) {
      console.log(
        `  unlinked ${relinked.length} external account(s) — they return to the review queue\n`,
      );
    }
  }

  console.log("Seeding database…");

  // wipe in dependency order
  await db.delete(propertyPaymentShares);
  await db.delete(propertyPayments);
  await db.delete(propertyValuations);
  await db.delete(properties);
  await db.delete(accountEntries);
  await db.delete(accounts);
  await db.delete(paychecks);
  await db.delete(employers);
  await db.delete(contributionLimits);
  await db.delete(appConfig);
  await db.delete(persons);

  const [scott] = await db
    .insert(persons)
    .values({ slug: "scott", name: "Scott", isPrimary: true })
    .returning();
  const [kate] = await db
    .insert(persons)
    .values({ slug: "kate", name: "Kate", isPrimary: false })
    .returning();
  const personId: Record<string, number> = { scott: scott.id, kate: kate.id };

  // ------------------------------------------------------------------ accounts
  const seedAccounts = load<SeedAccount[]>("accounts.json");
  for (const a of seedAccounts) {
    const [row] = await db
      .insert(accounts)
      .values({
        slug: a.slug,
        name: a.name,
        institution: a.institution,
        category: a.category,
        taxTreatment: a.taxTreatment,
        ownerPersonId: personId[a.owner],
        isJoint: false,
        ownershipShare: 1,
        isActive: a.isActive,
        includeInNetWorth: a.includeInNetWorth,
        taxLotGroup: a.taxLotGroup,
        sortOrder: a.sortOrder,
      })
      .returning();
    const rows = a.entries.map((e) => ({
      accountId: row.id,
      statementDate: e.statementDate,
      contributionsPretax: e.contributionsPretax,
      contributionsRoth: e.contributionsRoth,
      contributionsAfterTax: e.contributionsAfterTax,
      employerContributions: e.employerContributions,
      transfersIn: e.transfersIn,
      growth: e.growth,
      withdrawals: e.withdrawals,
      transfersOut: e.transfersOut,
      balance: e.balance,
      detail: e.detail,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(accountEntries).values(rows.slice(i, i + 500));
    }
    console.log(`  account ${a.slug}: ${rows.length} entries`);
  }

  // ------------------------------------------------------------------ property
  const prop = load<SeedProperty>("property.json");
  const [property] = await db
    .insert(properties)
    .values({
      slug: prop.slug,
      name: prop.name,
      address: prop.address,
      purchasePrice: prop.purchasePrice,
      purchaseDate: prop.purchaseDate,
      originalLoan: prop.originalLoan,
      equityShare: prop.equityShare,
    })
    .returning();

  for (const p of prop.payments) {
    const [pay] = await db
      .insert(propertyPayments)
      .values({
        propertyId: property.id,
        date: p.date,
        type: p.type,
        principal: p.principal,
        interest: p.interest,
        escrow: p.escrow,
        hoa: p.hoa,
        fees: p.fees,
        loanBalanceAfter: p.loanBalanceAfter,
        notes: p.notes,
      })
      .returning();
    const shares = [];
    if (p.scott) shares.push({ paymentId: pay.id, personId: scott.id, amount: p.scott });
    if (p.kate) shares.push({ paymentId: pay.id, personId: kate.id, amount: p.kate });
    if (shares.length) await db.insert(propertyPaymentShares).values(shares);
  }
  await db.insert(propertyValuations).values(
    prop.valuations.map((v) => ({
      propertyId: property.id,
      date: v.date,
      marketValue: v.marketValue,
    })),
  );
  console.log(
    `  property ${prop.slug}: ${prop.payments.length} payments, ${prop.valuations.length} valuations`,
  );

  // ------------------------------------------------------------------ income
  const seedEmployers = load<SeedEmployer[]>("paychecks.json");
  for (const e of seedEmployers) {
    const [row] = await db
      .insert(employers)
      .values({
        slug: e.slug,
        name: e.name,
        personId: personId[e.person],
        isActive: e.slug === "lm",
      })
      .returning();
    const rows = e.paychecks.map((c) => ({
      employerId: row.id,
      paymentDate: c.paymentDate,
      payBeginDate: c.payBeginDate,
      payEndDate: c.payEndDate,
      annualSalary: c.annualSalary || null,
      totalIncome: c.totalIncome,
      netPay: c.netPay,
      federalTax: c.federalTax,
      totalTaxes: c.totalTaxes,
      retirement401k: c.retirement401k,
      hsa: c.hsa,
      bonus: c.bonus,
      items: c.items,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(paychecks).values(rows.slice(i, i + 500));
    }
    console.log(`  employer ${e.slug}: ${rows.length} paychecks`);
  }

  // ------------------------------------------------------------------ planning
  // 2026 401(k) limit from the "401(k) + HSA Contributions" planner sheet.
  await db.insert(contributionLimits).values([
    { year: 2026, planType: "401k", amount: 24500 },
  ]);
  await db.insert(appConfig).values([
    { key: "planner", value: { paychecksPerYear: 26, traditionalPct: 0.09, rothPct: 0 } },
  ]);

  const seeded = await existingCounts();
  console.log(
    "\nDone. " +
      Object.entries(seeded)
        .map(([t, n]) => `${t} ${n.toLocaleString()}`)
        .join(" · "),
  );
  console.log("Fred owns this data now — add to it via the monthly close.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
