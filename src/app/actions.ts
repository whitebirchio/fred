"use server";

import { and, desc, eq, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { db } from "@/db";
import { SCOPE_COOKIE } from "@/lib/scope";
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
  const statementDate = String(formData.get("statementDate"));
  if (!accountId || !/^\d{4}-\d{2}-\d{2}$/.test(statementDate)) {
    throw new Error("Missing account or statement date");
  }
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
      isActive: ext.isActive,
      // Household-included by default ("everything in"); the individual
      // net-worth lens stays opt-in so this can't disturb existing figures.
      includeInHousehold: true,
      includeInNetWorth: false,
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
  await db
    .update(accountsTable)
    .set({
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

export async function updateExternalAccount(formData: FormData) {
  const { externalAccounts } = await import("@/db/schema");
  const id = Number(formData.get("externalAccountId"));
  if (!id) throw new Error("Missing external account id");
  const linkedRaw = String(formData.get("linkedAccountId") ?? "");
  const ownerRaw = String(formData.get("ownerPersonId") ?? "");
  const share = num(formData.get("ownershipShare"));
  await db
    .update(externalAccounts)
    .set({
      linkedAccountId: linkedRaw ? Number(linkedRaw) : null,
      ownerPersonId: ownerRaw ? Number(ownerRaw) : null,
      includeInHousehold: formData.get("includeInHousehold") === "on",
      ownershipShare: share > 0 && share <= 1 ? share : 1,
    })
    .where(eq(externalAccounts.id, id));
  revalidatePath("/sync");
  revalidatePath("/monthly");
}

export async function toggleAccountActive(formData: FormData) {
  const id = Number(formData.get("accountId"));
  const isActive = String(formData.get("isActive")) === "true";
  if (id) await db.update(accounts).set({ isActive }).where(eq(accounts.id, id));
  revalidatePath("/", "layout");
}
