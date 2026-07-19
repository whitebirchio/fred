import fs from "fs";
import path from "path";
import { db } from "./index";
import {
  accountEntries,
  accounts,
  appConfig,
  contributionLimits,
  employers,
  paychecks,
  persons,
  properties,
  propertyPayments,
  propertyPaymentShares,
  propertyValuations,
} from "./schema";

const seedDir = path.join(process.cwd(), "data", "seed");

function load<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(seedDir, name), "utf8"));
}

type SeedEntry = {
  statementDate: string;
  individualContributions: number;
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
  console.log("Seeding database…");

  // wipe in dependency order (idempotent re-seed)
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
        sortOrder: a.sortOrder,
      })
      .returning();
    const rows = a.entries.map((e) => ({
      accountId: row.id,
      statementDate: e.statementDate,
      individualContributions: e.individualContributions,
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

  console.log("Done.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
