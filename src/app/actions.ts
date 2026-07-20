"use server";

import { and, desc, eq, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
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

export async function syncNow() {
  const { getProvider } = await import("@/lib/providers");
  const { runSync } = await import("@/lib/sync");
  await runSync(getProvider());
  revalidatePath("/sync");
  revalidatePath("/monthly");
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
