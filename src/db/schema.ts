import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const persons = pgTable("persons", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
});

// ---------------------------------------------------------------------------
// Accounts + monthly statement entries
// ---------------------------------------------------------------------------

export const accountCategory = pgEnum("account_category", [
  "cash",
  "retirement",
  "hsa",
  "brokerage",
  "crypto",
  "property",
  "other",
]);

export const taxTreatment = pgEnum("tax_treatment", [
  "taxable",
  "traditional",
  "roth",
  "hsa",
  "pension",
  "na",
]);

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  institution: text("institution"),
  category: accountCategory("category").notNull(),
  taxTreatment: taxTreatment("tax_treatment").notNull().default("na"),
  // Owner of the account. Null + isJoint=true means jointly held.
  ownerPersonId: integer("owner_person_id").references(() => persons.id),
  isJoint: boolean("is_joint").notNull().default(false),
  // Fraction of this account's value counted toward the primary person's
  // individual net worth (e.g. 0.5 for an evenly split joint asset).
  ownershipShare: numeric("ownership_share", {
    precision: 5,
    scale: 4,
    mode: "number",
  })
    .notNull()
    .default(1),
  isActive: boolean("is_active").notNull().default(true),
  // The Finances workbook excludes some holdings (e.g. unvested RSUs, ESPP)
  // from the net-worth rollup while still tracking them.
  includeInNetWorth: boolean("include_in_net_worth").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  notes: text("notes"),
});

const money = (name: string) =>
  numeric(name, { precision: 14, scale: 2, mode: "number" });

/**
 * One row per account per statement month (mirrors one row of an account tab
 * in the Finances workbook). Balance identity:
 *   balance = prev balance + individual + employer + transfersIn + growth
 *             - withdrawals - transfersOut
 * Growth is normally derived as the plug from the entered statement balance.
 */
export const accountEntries = pgTable(
  "account_entries",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    statementDate: date("statement_date").notNull(),
    individualContributions: money("individual_contributions")
      .notNull()
      .default(0),
    employerContributions: money("employer_contributions").notNull().default(0),
    transfersIn: money("transfers_in").notNull().default(0),
    growth: money("growth").notNull().default(0),
    withdrawals: money("withdrawals").notNull().default(0),
    transfersOut: money("transfers_out").notNull().default(0),
    balance: money("balance").notNull(),
    // Account-specific extras, e.g. Roth/Traditional/After-tax split for a
    // 401(k), units + price for crypto, cash vs invested for an HSA.
    detail: jsonb("detail"),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("account_entries_account_date_idx").on(
      t.accountId,
      t.statementDate,
    ),
    index("account_entries_date_idx").on(t.statementDate),
  ],
);

// ---------------------------------------------------------------------------
// Property (13 Charron Cir) — shared ledger with per-person payment shares
// ---------------------------------------------------------------------------

export const properties = pgTable("properties", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  address: text("address"),
  purchasePrice: money("purchase_price").notNull(),
  purchaseDate: date("purchase_date").notNull(),
  originalLoan: money("original_loan").notNull(),
  // Fraction of equity counted toward the primary person's net worth.
  equityShare: numeric("equity_share", {
    precision: 5,
    scale: 4,
    mode: "number",
  })
    .notNull()
    .default(0.5),
  notes: text("notes"),
});

export const propertyPaymentType = pgEnum("property_payment_type", [
  "down_payment",
  "mortgage",
  "hoa",
  "fees",
  "escrow",
  "other",
]);

export const propertyPayments = pgTable(
  "property_payments",
  {
    id: serial("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    date: date("date").notNull(),
    type: propertyPaymentType("type").notNull(),
    principal: money("principal").notNull().default(0),
    interest: money("interest").notNull().default(0),
    escrow: money("escrow").notNull().default(0),
    hoa: money("hoa").notNull().default(0),
    fees: money("fees").notNull().default(0),
    // Running loan balance after this payment, as reported by the lender.
    loanBalanceAfter: money("loan_balance_after"),
    notes: text("notes"),
  },
  (t) => [index("property_payments_date_idx").on(t.propertyId, t.date)],
);

export const propertyPaymentShares = pgTable(
  "property_payment_shares",
  {
    id: serial("id").primaryKey(),
    paymentId: integer("payment_id")
      .notNull()
      .references(() => propertyPayments.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => persons.id),
    amount: money("amount").notNull(),
  },
  (t) => [uniqueIndex("payment_share_idx").on(t.paymentId, t.personId)],
);

export const propertyValuations = pgTable(
  "property_valuations",
  {
    id: serial("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    date: date("date").notNull(),
    marketValue: money("market_value").notNull(),
    source: text("source"),
  },
  (t) => [uniqueIndex("property_valuations_idx").on(t.propertyId, t.date)],
);

// ---------------------------------------------------------------------------
// Income — employers and per-paycheck detail (Pay Stubs workbook)
// ---------------------------------------------------------------------------

export const employers = pgTable("employers", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  personId: integer("person_id")
    .notNull()
    .references(() => persons.id),
  isActive: boolean("is_active").notNull().default(true),
});

export const paychecks = pgTable(
  "paychecks",
  {
    id: serial("id").primaryKey(),
    employerId: integer("employer_id")
      .notNull()
      .references(() => employers.id),
    paymentDate: date("payment_date").notNull(),
    payBeginDate: date("pay_begin_date"),
    payEndDate: date("pay_end_date"),
    annualSalary: money("annual_salary"),
    totalIncome: money("total_income").notNull(),
    netPay: money("net_pay").notNull(),
    // Commonly-charted aggregates, denormalized from `items`.
    federalTax: money("federal_tax").notNull().default(0),
    totalTaxes: money("total_taxes").notNull().default(0),
    retirement401k: money("retirement_401k").notNull().default(0),
    hsa: money("hsa").notNull().default(0),
    bonus: money("bonus").notNull().default(0),
    // Full line-item breakdown, keyed by section:
    // { income: {...}, preTax: {...}, taxes: {...}, postTax: {...} }
    items: jsonb("items"),
  },
  (t) => [index("paychecks_date_idx").on(t.employerId, t.paymentDate)],
);

// ---------------------------------------------------------------------------
// Planning — IRS limits and app configuration
// ---------------------------------------------------------------------------

export const contributionLimits = pgTable(
  "contribution_limits",
  {
    id: serial("id").primaryKey(),
    year: integer("year").notNull(),
    planType: text("plan_type").notNull(), // '401k' | 'hsa_individual' | 'hsa_family' | 'ira'
    amount: money("amount").notNull(),
  },
  (t) => [uniqueIndex("contribution_limits_idx").on(t.year, t.planType)],
);

export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});
