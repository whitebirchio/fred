// Fixed entity→color assignment (never re-ranked when a filter changes).
// Must stay exhaustive over the accountCategory enum (src/db/schema.ts) —
// an account whose category has no entry here throws at render time in
// every place that indexes this map directly (most call sites do; only
// household-client.tsx guards with a fallback). credit/loan were added to
// the enum for household liabilities without updating this map, which is
// exactly the class of bug this comment exists to prevent next time.
export const CATEGORY_META: Record<string, { name: string; color: string }> = {
  cash: { name: "Cash", color: "var(--series-1)" },
  retirement: { name: "Retirement", color: "var(--series-2)" },
  hsa: { name: "HSA", color: "var(--series-3)" },
  brokerage: { name: "Brokerage", color: "var(--series-4)" },
  crypto: { name: "Crypto", color: "var(--series-5)" },
  property: { name: "House equity", color: "var(--series-6)" },
  other: { name: "Other", color: "var(--series-8)" },
  // Liabilities — share one color family, distinct from series-6 (property).
  credit: { name: "Credit card", color: "var(--series-7)" },
  loan: { name: "Loan", color: "var(--series-7)" },
};

export const CATEGORY_ORDER = [
  "cash",
  "retirement",
  "hsa",
  "brokerage",
  "crypto",
  "property",
  "other",
  "credit",
  "loan",
];
