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
  timestamp,
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

// Asset categories, then liability categories. Liability balances are stored
// as positive magnitudes; the sign is applied at rollup (see isLiability in
// src/lib/household.ts) so a card balance can never be mistaken for an asset.
export const accountCategory = pgEnum("account_category", [
  "cash",
  "retirement",
  "hsa",
  "brokerage",
  "crypto",
  "property",
  "other",
  // liabilities
  "credit",
  "loan",
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
  // Some holdings (e.g. unvested RSUs, ESPP) are tracked but held out of the
  // net-worth rollup. Seeded from how the original workbook treated them.
  includeInNetWorth: boolean("include_in_net_worth").notNull().default(true),
  // Accounts sharing a group are one plan lineage (e.g. the LM→HS→LM 401(k)
  // rollover chain): the tax-lot engine merges their flows chronologically and
  // treats intra-group transfers as internal. Group presence also marks the
  // account as mixed-bucket (tax character varies per contribution rather
  // than per account).
  taxLotGroup: text("tax_lot_group"),
  // Household lens: whether this account counts toward household rollups.
  // Distinct from include_in_net_worth, which is the individual (Scott) lens.
  // Default true — "everything in" — because exclusion is a deliberate act;
  // unreviewed *sources* are held out separately via
  // external_accounts.match_status, not via this flag.
  includeInHousehold: boolean("include_in_household").notNull().default(true),
  // Optional per-domain source priority override, e.g.
  //   { "live_balance": ["fred", "monarch"] }
  // Absent (the norm) = household default order; see src/lib/household.ts.
  resolution: jsonb("resolution"),
  sortOrder: integer("sort_order").notNull().default(0),
  notes: text("notes"),
});

const money = (name: string) =>
  numeric(name, { precision: 14, scale: 2, mode: "number" });

/**
 * One row per account per statement month — Fred's own record, written by the
 * monthly close and seeded once from the original workbooks. Balance identity:
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
    // Individual contributions split by tax character — the dimension that
    // makes Roth-vs-traditional analysis possible. Single-bucket accounts use
    // the column matching their nature (Roth IRA → roth, Trad IRA → pretax,
    // taxable brokerage → after-tax dollars); mixed accounts (401(k)s) split
    // per statement. Employer money is its own source dimension (pre-tax by
    // definition; bucket resolution happens in the tax-lot engine).
    contributionsPretax: money("contributions_pretax").notNull().default(0),
    contributionsRoth: money("contributions_roth").notNull().default(0),
    contributionsAfterTax: money("contributions_after_tax").notNull().default(0),
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
// Income — employers and per-paycheck detail
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

// ---------------------------------------------------------------------------
// External sync (Monarch today, anything tomorrow)
//
// Everything below is provider-agnostic: rows are keyed by (provider,
// external id) so syncs are idempotent, and all fields are Fred's own shape —
// the provider's original payload survives only in `raw` as an escape hatch
// that application logic must never read. Statement-based `account_entries`
// remain the system of record for the monthly close; synced data verifies,
// prefills, and extends (household, spending, holdings) but never overwrites.
// ---------------------------------------------------------------------------

export const externalAccounts = pgTable(
  "external_accounts",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    institution: text("institution"),
    accountType: text("account_type"), // provider-normalized: checking, brokerage, mortgage…
    isAsset: boolean("is_asset").notNull().default(true),
    currentBalance: money("current_balance").notNull().default(0),
    balanceAsOf: date("balance_as_of"),
    isActive: boolean("is_active").notNull().default(true),
    // The spoke→hub pointer: which household account this row is evidence
    // about. Every source record resolves through its hub; it is never itself
    // an account.
    linkedAccountId: integer("linked_account_id").references(() => accounts.id),
    // The state machine that makes dedup safe (docs/HOUSEHOLD.md):
    //   pending   — discovered, awaiting review; NEVER counted
    //   auto      — machine-matched to a hub account, unconfirmed; counted
    //   confirmed — user-confirmed link; counted
    //   ignored   — deliberately excluded (e.g. Zestimate/mortgage, already
    //               represented by the property ledger); NEVER counted
    // Only rows with a linkedAccountId AND status auto|confirmed contribute
    // to any number, which is what keeps a duplicate from inflating totals
    // while the review queue is being worked.
    matchStatus: text("match_status").notNull().default("pending"),
    // Why an account was ignored — kept so "ignored" never reads as
    // "uninteresting" when the real reason is "counted elsewhere".
    matchNote: text("match_note"),
    ownerPersonId: integer("owner_person_id").references(() => persons.id),
    // DEPRECATED (hub-owned now): household inclusion and ownership live on
    // `accounts`. Retained so the migration is non-destructive; no longer read.
    includeInHousehold: boolean("include_in_household").notNull().default(false),
    ownershipShare: numeric("ownership_share", {
      precision: 5,
      scale: 4,
      mode: "number",
    })
      .notNull()
      .default(1),
    raw: jsonb("raw"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("external_accounts_provider_idx").on(t.provider, t.externalId)],
);

export const balanceSnapshots = pgTable(
  "balance_snapshots",
  {
    id: serial("id").primaryKey(),
    externalAccountId: integer("external_account_id")
      .notNull()
      .references(() => externalAccounts.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    balance: money("balance").notNull(),
  },
  (t) => [
    uniqueIndex("balance_snapshots_idx").on(t.externalAccountId, t.date),
  ],
);

export const externalTransactions = pgTable(
  "external_transactions",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    externalAccountId: integer("external_account_id")
      .notNull()
      .references(() => externalAccounts.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    // Provider convention preserved after normalization: negative = outflow.
    amount: money("amount").notNull(),
    pending: boolean("pending").notNull().default(false),
    merchant: text("merchant"),
    category: text("category"),
    categoryGroup: text("category_group"),
    notes: text("notes"),
    tags: jsonb("tags"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("external_transactions_provider_idx").on(t.provider, t.externalId),
    index("external_transactions_date_idx").on(t.date),
    index("external_transactions_account_idx").on(t.externalAccountId, t.date),
  ],
);

export const holdings = pgTable(
  "holdings",
  {
    id: serial("id").primaryKey(),
    externalAccountId: integer("external_account_id")
      .notNull()
      .references(() => externalAccounts.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    ticker: text("ticker"),
    name: text("name").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 6, mode: "number" }),
    price: money("price"),
    value: money("value").notNull(),
  },
  (t) => [uniqueIndex("holdings_idx").on(t.externalAccountId, t.asOf, t.name)],
);

export const syncRuns = pgTable("sync_runs", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  status: text("status").notNull().default("running"), // running | success | error
  stats: jsonb("stats"),
  error: text("error"),
});
