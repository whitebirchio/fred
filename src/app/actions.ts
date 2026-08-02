"use server";

import { and, desc, eq, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { db } from "@/db";
import { SCOPE_COOKIE } from "@/lib/scope";
import { monthEnd } from "@/lib/format";
import {
  accountEntries,
  accounts,
  appConfig,
  paychecks,
  propertyPayments,
  propertyPaymentShares,
  propertyValuations,
  persons,
} from "@/db/schema";

const num = (v: FormDataEntryValue | null) => {
  const n = parseFloat(String(v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/**
 * Persist the viewing scope (whose money, and whether the home counts).
 *
 * Stored in a cookie rather than the database because it is a property of
 * how you're *looking* right now, not of the household — and read
 * server-side so every route renders the same slice without each page
 * having to remember to ask.
 */
export async function setScope(formData: FormData) {
  const who = String(formData.get("who") ?? "all");
  const includeHome = formData.get("includeHome") === "1";
  const valid = who === "all" || who === "joint" || /^\d+$/.test(who);
  const store = await cookies();
  store.set(SCOPE_COOKIE, `${valid ? who : "all"}:${includeHome ? 1 : 0}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  // Every page's totals depend on this, so refresh the whole tree.
  revalidatePath("/", "layout");
}

/**
 * Add or update a monthly statement entry. Growth is derived as the plug that
 * makes the balance identity hold against the previous month's balance —
 * the user types the statement balance and the flows; the math is automated.
 */
export async function upsertEntry(formData: FormData) {
  const accountId = Number(formData.get("accountId"));
  const submitted = String(formData.get("statementDate"));
  if (!accountId || !/^\d{4}-\d{2}-\d{2}$/.test(submitted)) {
    throw new Error("Missing account or statement date");
  }
  // A close is a month-end figure by definition, so the month is the only part
  // of the submitted date that carries meaning — snap it to that month's last
  // day. Enforcing it here rather than trusting the form means one month can
  // only ever have one row, whatever a client sends.
  const [sy, sm] = submitted.split("-").map(Number);
  const statementDate = monthEnd(sy, sm);
  const balance = num(formData.get("balance"));
  const contributionsPretax = num(formData.get("contributionsPretax"));
  const contributionsRoth = num(formData.get("contributionsRoth"));
  const contributionsAfterTax = num(formData.get("contributionsAfterTax"));
  const employerContributions = num(formData.get("employerContributions"));
  const individualContributions =
    contributionsPretax + contributionsRoth + contributionsAfterTax;
  const transfersIn = num(formData.get("transfersIn"));
  const withdrawals = num(formData.get("withdrawals"));
  const transfersOut = num(formData.get("transfersOut"));

  const [prev] = await db
    .select()
    .from(accountEntries)
    .where(
      and(
        eq(accountEntries.accountId, accountId),
        lt(accountEntries.statementDate, statementDate),
      ),
    )
    .orderBy(desc(accountEntries.statementDate))
    .limit(1);
  const prevBalance = prev?.balance ?? 0;
  const growth =
    Math.round(
      (balance -
        prevBalance -
        individualContributions -
        employerContributions -
        transfersIn +
        withdrawals +
        transfersOut) *
        100,
    ) / 100;

  await db
    .insert(accountEntries)
    .values({
      accountId,
      statementDate,
      balance,
      contributionsPretax,
      contributionsRoth,
      contributionsAfterTax,
      employerContributions,
      transfersIn,
      growth,
      withdrawals,
      transfersOut,
      notes: String(formData.get("notes") ?? "") || null,
    })
    .onConflictDoUpdate({
      target: [accountEntries.accountId, accountEntries.statementDate],
      set: {
        balance,
        contributionsPretax,
        contributionsRoth,
        contributionsAfterTax,
        employerContributions,
        transfersIn,
        growth,
        withdrawals,
        transfersOut,
      },
    });

  revalidatePath("/", "layout");
}

export async function deleteEntry(formData: FormData) {
  const id = Number(formData.get("entryId"));
  if (id) await db.delete(accountEntries).where(eq(accountEntries.id, id));
  revalidatePath("/", "layout");
}

/**
 * Permanently delete a household account and its statement history.
 * Irreversible — the confirming UI requires typing the account name.
 *
 * Statement entries cascade at the database level (accountEntries.accountId
 * -> accounts.id ON DELETE CASCADE). Any synced source linked to this account
 * is explicitly sent back to the review queue first, the same way
 * unlinkSource does it — a synced Monarch account is evidence about a hub,
 * never the hub itself, so deleting the hub must not delete or orphan it.
 */
export async function deleteAccount(formData: FormData) {
  const { externalAccounts } = await import("@/db/schema");
  const accountId = Number(formData.get("accountId"));
  if (!accountId) throw new Error("Missing account id");

  await db
    .update(externalAccounts)
    .set({ linkedAccountId: null, matchStatus: "pending", matchNote: null })
    .where(eq(externalAccounts.linkedAccountId, accountId));

  await db.delete(accounts).where(eq(accounts.id, accountId));

  revalidatePath("/household");
  revalidatePath("/", "layout");
}

export async function addHousePayment(formData: FormData) {
  const propertyId = Number(formData.get("propertyId"));
  const date = String(formData.get("date"));
  const type = String(formData.get("type")) as
    | "down_payment"
    | "mortgage"
    | "hoa"
    | "fees"
    | "escrow"
    | "other";
  if (!propertyId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Missing property or date");
  }

  const [payment] = await db
    .insert(propertyPayments)
    .values({
      propertyId,
      date,
      type,
      principal: num(formData.get("principal")),
      interest: num(formData.get("interest")),
      escrow: num(formData.get("escrow")),
      hoa: num(formData.get("hoa")),
      fees: num(formData.get("fees")),
      loanBalanceAfter: formData.get("loanBalanceAfter")
        ? num(formData.get("loanBalanceAfter"))
        : null,
      notes: String(formData.get("notes") ?? "") || null,
    })
    .returning();

  const people = await db.select().from(persons);
  const shares = [];
  for (const p of people) {
    const amount = num(formData.get(`share_${p.slug}`));
    if (amount) shares.push({ paymentId: payment.id, personId: p.id, amount });
  }
  if (shares.length) await db.insert(propertyPaymentShares).values(shares);
  revalidatePath("/", "layout");
}

export async function addValuation(formData: FormData) {
  const propertyId = Number(formData.get("propertyId"));
  const date = String(formData.get("date"));
  const marketValue = num(formData.get("marketValue"));
  if (!propertyId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !marketValue) {
    throw new Error("Missing property, date or value");
  }
  await db
    .insert(propertyValuations)
    .values({ propertyId, date, marketValue, source: "manual" })
    .onConflictDoUpdate({
      target: [propertyValuations.propertyId, propertyValuations.date],
      set: { marketValue },
    });
  revalidatePath("/", "layout");
}

export async function addPaycheck(formData: FormData) {
  const employerId = Number(formData.get("employerId"));
  const paymentDate = String(formData.get("paymentDate"));
  if (!employerId || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    throw new Error("Missing employer or date");
  }
  const totalIncome = num(formData.get("totalIncome"));
  const netPay = num(formData.get("netPay"));
  await db.insert(paychecks).values({
    employerId,
    paymentDate,
    annualSalary: formData.get("annualSalary") ? num(formData.get("annualSalary")) : null,
    totalIncome,
    netPay,
    federalTax: num(formData.get("federalTax")),
    totalTaxes: num(formData.get("totalTaxes")),
    retirement401k: num(formData.get("retirement401k")),
    hsa: num(formData.get("hsa")),
    bonus: num(formData.get("bonus")),
  });
  revalidatePath("/", "layout");
}

export async function savePlanAssumptions(formData: FormData) {
  const value = {
    annualSpending: num(formData.get("annualSpending")),
    swr: num(formData.get("swr")),
    expectedReal: num(formData.get("expectedReal")),
    conservativeReal: num(formData.get("conservativeReal")),
    optimisticReal: num(formData.get("optimisticReal")),
    monthlySavings: num(formData.get("monthlySavings")),
    pretaxTaxRate: num(formData.get("pretaxTaxRate")),
  };
  await db
    .insert(appConfig)
    .values({ key: "plan", value })
    .onConflictDoUpdate({ target: appConfig.key, set: { value } });
  revalidatePath("/plan");
}

// ---------------------------------------------------------------------------
// Household review queue (docs/HOUSEHOLD.md)
// ---------------------------------------------------------------------------

/** Attach a source record to an existing household account (the dedup path). */
export async function linkSource(formData: FormData) {
  const { externalAccounts } = await import("@/db/schema");
  const externalId = Number(formData.get("externalAccountId"));
  const accountId = Number(formData.get("accountId"));
  if (!externalId || !accountId) throw new Error("Missing ids");
  await db
    .update(externalAccounts)
    .set({ linkedAccountId: accountId, matchStatus: "confirmed", matchNote: null })
    .where(eq(externalAccounts.id, externalId));
  revalidatePath("/household");
  revalidatePath("/", "layout");
}

/**
 * Promote a source record into a new household account (the additive path).
 * Creates the hub row, copies identity from the source as a starting point,
 * and links the source to it — after this the account is indistinguishable in
 * shape from a seeded one, which is the point of the model.
 */
export async function promoteSource(formData: FormData) {
  const { externalAccounts, accounts: accountsTable, persons: personsTable } =
    await import("@/db/schema");
  const { inferOwnerToken } = await import("@/lib/household");
  const externalId = Number(formData.get("externalAccountId"));
  if (!externalId) throw new Error("Missing external account id");

  const [ext] = await db
    .select()
    .from(externalAccounts)
    .where(eq(externalAccounts.id, externalId));
  if (!ext) throw new Error("External account not found");

  // Map the provider's account type onto Fred's categories.
  const CATEGORY: Record<string, string> = {
    checking: "cash",
    savings: "cash",
    brokerage: "brokerage",
    retirement: "retirement",
    crypto: "crypto",
    credit: "credit",
    mortgage: "loan",
    loan: "loan",
    real_estate: "property",
  };
  let category = CATEGORY[ext.accountType ?? ""] ?? "other";
  // Provider types are coarse: Monarch files 401(k)s and IRAs as "brokerage"
  // and HSAs as "checking". Names carry the real intent.
  const n = ext.name.toLowerCase();
  if (/401\(?k\)?|ira|pension|403b|457/.test(n)) category = "retirement";
  else if (/hsa/.test(n)) category = "hsa";
  else if (/529/.test(n)) category = "other";
  if (!ext.isAsset && category !== "credit") category = "loan";

  // Owner inferred from the provider's naming convention; unmatched people
  // (e.g. children) are left unassigned for the user to set.
  const people = await db.select().from(personsTable);
  const token = inferOwnerToken(ext.name);
  const matched =
    token && token !== "joint"
      ? people.find((p) => p.name.toLowerCase() === token)
      : undefined;

  const baseSlug = ext.name
    .toLowerCase()
    .replace(/\(\.\.\.[^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const existing = await db.select().from(accountsTable);
  const taken = new Set(existing.map((a) => a.slug));
  let slug = baseSlug || `account-${externalId}`;
  let i = 2;
  while (taken.has(slug)) slug = `${baseSlug}-${i++}`;

  const [hub] = await db
    .insert(accountsTable)
    .values({
      slug,
      name: ext.name,
      institution: ext.institution,
      category: category as "cash",
      ownerPersonId: matched?.id ?? null,
      isJoint: token === "joint",
      ownershipShare: token === "joint" ? 0.5 : 1,
      isActive: ext.isActive,
      // Counted by default — exclusion is a deliberate act, and an unreviewed
      // source is held out by its match_status, not by this.
      exclusion: null,
      // It arrived from a feed, so it has no statement history and the close
      // shouldn't ask for one.
      tracksMonthlyClose: false,
      sortOrder: 500,
    })
    .returning();

  await db
    .update(externalAccounts)
    .set({ linkedAccountId: hub.id, matchStatus: "confirmed", matchNote: null })
    .where(eq(externalAccounts.id, externalId));

  revalidatePath("/household");
  revalidatePath("/", "layout");
}

/** Exclude a source from the household with a recorded reason. */
export async function ignoreSource(formData: FormData) {
  const { externalAccounts } = await import("@/db/schema");
  const externalId = Number(formData.get("externalAccountId"));
  if (!externalId) throw new Error("Missing external account id");
  await db
    .update(externalAccounts)
    .set({
      matchStatus: "ignored",
      linkedAccountId: null,
      matchNote: String(formData.get("note") ?? "") || "Ignored by user",
    })
    .where(eq(externalAccounts.id, externalId));
  revalidatePath("/household");
  revalidatePath("/", "layout");
}

/** Send an ignored/linked source back to the review queue. */
export async function unlinkSource(formData: FormData) {
  const { externalAccounts } = await import("@/db/schema");
  const externalId = Number(formData.get("externalAccountId"));
  if (!externalId) throw new Error("Missing external account id");
  await db
    .update(externalAccounts)
    .set({ linkedAccountId: null, matchStatus: "pending", matchNote: null })
    .where(eq(externalAccounts.id, externalId));
  revalidatePath("/household");
  revalidatePath("/", "layout");
}

/** Household-level settings on a hub account. */
export async function updateHouseholdAccount(formData: FormData) {
  const { accounts: accountsTable } = await import("@/db/schema");
  const id = Number(formData.get("accountId"));
  if (!id) throw new Error("Missing account id");
  const ownerRaw = String(formData.get("ownerPersonId") ?? "");
  const isJoint = ownerRaw === "joint";
  const exclusionRaw = String(formData.get("exclusion") ?? "");
  const exclusion = ["primary_residence", "unvested", "other"].includes(exclusionRaw)
    ? exclusionRaw
    : null;
  // Identity is editable too: accounts get renamed in the real world (an
  // employer changes, a plan is rolled over), and a hand-created account needs
  // its typos fixed. Absent fields leave the existing value alone, so callers
  // that only send household settings keep working.
  const rawName = String(formData.get("name") ?? "").trim();
  const rawCategory = String(formData.get("category") ?? "");
  const rawTax = String(formData.get("taxTreatment") ?? "");
  const identity: Record<string, unknown> = {};
  if (rawName) identity.name = rawName;
  if (formData.has("institution")) {
    identity.institution = String(formData.get("institution") ?? "").trim() || null;
  }
  if ((CATEGORIES as readonly string[]).includes(rawCategory)) {
    identity.category = rawCategory;
  }
  if ((TAX_TREATMENTS as readonly string[]).includes(rawTax)) {
    identity.taxTreatment = rawTax;
  }

  await db
    .update(accountsTable)
    .set({
      ...identity,
      exclusion,
      tracksMonthlyClose: formData.get("tracksMonthlyClose") === "on",
      ownerPersonId: isJoint || !ownerRaw ? null : Number(ownerRaw),
      isJoint,
      // Joint means shared, so the default split is even — matching how the
      // house has always been treated. Individually-owned accounts belong
      // wholly to their owner.
      ownershipShare: isJoint ? 0.5 : 1,
    })
    .where(eq(accountsTable.id, id));
  revalidatePath("/household");
  revalidatePath("/", "layout");
}

export async function syncNow() {
  const { getProvider } = await import("@/lib/providers");
  const { runSync } = await import("@/lib/sync");
  const { autoMatchConfident } = await import("@/lib/household");
  await runSync(await getProvider());
  // Keep the review queue small: confident duplicates match themselves, so a
  // fresh sync never dumps a wall of obvious pairs on the user.
  await autoMatchConfident();
  revalidatePath("/sync");
  revalidatePath("/monthly");
  revalidatePath("/household");
  revalidatePath("/", "layout");
}

/** Run auto-match on demand (the /household "Auto-match confident" affordance
 *  and the one-time pass over an existing backlog). */
export async function autoMatchNow() {
  const { autoMatchConfident } = await import("@/lib/household");
  await autoMatchConfident();
  revalidatePath("/household");
  revalidatePath("/", "layout");
}

/* updateExternalAccount removed (2026-08-02).
 *
 * It backed the editing controls on /sync's external-account rows. Three of
 * the four fields it wrote — include_in_household, ownership_share and
 * owner_person_id on external_accounts — stopped being read when ownership
 * moved onto the hub account, so saving them changed nothing anywhere. The
 * fourth set linked_account_id without match_status, which could leave a
 * source looking linked while still counting toward nothing.
 *
 * Linking now goes through /household's review (linkSource / promoteSource /
 * ignoreSource / unlinkSource), which sets both fields together.
 */

/**
 * Archive an account, or bring it back.
 *
 * Archiving is the non-destructive counterpart to deleteAccount: the account
 * stops contributing to today's net worth and drops out of the monthly close,
 * but every statement it ever had stays exactly where it is, so history and
 * past-year figures are untouched. That is what makes it the right tool for
 * "I closed this in 2027" — deleting would take fifteen years of statements
 * with it.
 *
 * Any linked provider sources are deliberately left alone. A feed that keeps
 * reporting a balance for an account you say is closed is a discrepancy worth
 * seeing on /household, not something to paper over here.
 */
export async function setAccountArchived(formData: FormData) {
  const id = Number(formData.get("accountId"));
  const archived = String(formData.get("archived")) === "true";
  if (!id) throw new Error("Missing account id");
  await db
    .update(accounts)
    .set({
      isActive: !archived,
      archivedAt: archived ? new Date().toISOString().slice(0, 10) : null,
    })
    .where(eq(accounts.id, id));
  revalidatePath("/household");
  revalidatePath("/monthly");
  revalidatePath("/", "layout");
}

const CATEGORIES = [
  "cash",
  "retirement",
  "hsa",
  "brokerage",
  "crypto",
  "property",
  "other",
  "credit",
  "loan",
] as const;
const TAX_TREATMENTS = [
  "taxable",
  "traditional",
  "roth",
  "hsa",
  "pension",
  "na",
] as const;

/**
 * Create an account by hand.
 *
 * The guided review on /household can only mint accounts that a provider
 * already knows about. Plenty won't be: a new employer's plan the feed can't
 * reach, a paper I-bond, a private note. Without this the only way to track
 * one was to edit the database directly.
 */
export async function createAccount(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Name is required");

  const rawCategory = String(formData.get("category") ?? "other");
  const category = (CATEGORIES as readonly string[]).includes(rawCategory)
    ? rawCategory
    : "other";
  const rawTax = String(formData.get("taxTreatment") ?? "na");
  const taxTreatment = (TAX_TREATMENTS as readonly string[]).includes(rawTax)
    ? rawTax
    : "na";

  const ownerRaw = String(formData.get("ownerPersonId") ?? "");
  const isJoint = ownerRaw === "joint";

  // Slugs are the account's URL, so they must be unique and stable; same
  // derivation the provider path uses.
  const baseSlug =
    name
      .toLowerCase()
      .replace(/\(\.\.\.[^)]*\)/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "account";
  const taken = new Set((await db.select().from(accounts)).map((a) => a.slug));
  let slug = baseSlug;
  let i = 2;
  while (taken.has(slug)) slug = `${baseSlug}-${i++}`;

  const [created] = await db
    .insert(accounts)
    .values({
      slug,
      name,
      institution: String(formData.get("institution") ?? "").trim() || null,
      category: category as (typeof CATEGORIES)[number],
      taxTreatment: taxTreatment as (typeof TAX_TREATMENTS)[number],
      ownerPersonId: isJoint || !ownerRaw ? null : Number(ownerRaw),
      isJoint,
      ownershipShare: isJoint ? 0.5 : 1,
      isActive: true,
      exclusion: null,
      // A hand-made account has no feed behind it, so the monthly close is the
      // only way it will ever get a balance.
      tracksMonthlyClose: true,
      sortOrder: 500,
    })
    .returning();

  // An opening balance is optional but usual — without one the account exists
  // with no value and shows as "no source has data for this account".
  const openingBalance = formData.get("openingBalance");
  const openingMonth = String(formData.get("openingMonth") ?? "");
  if (openingBalance != null && String(openingBalance).trim() !== "") {
    const [oy, om] = openingMonth.split("-").map(Number);
    if (oy && om) {
      await db.insert(accountEntries).values({
        accountId: created.id,
        statementDate: monthEnd(oy, om),
        balance: num(openingBalance),
        notes: "Opening balance",
      });
    }
  }

  revalidatePath("/household");
  revalidatePath("/monthly");
  revalidatePath("/", "layout");
}
