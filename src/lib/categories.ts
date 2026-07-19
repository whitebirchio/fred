// Fixed entity→color assignment (never re-ranked when a filter changes).
export const CATEGORY_META: Record<string, { name: string; color: string }> = {
  cash: { name: "Cash", color: "var(--series-1)" },
  retirement: { name: "Retirement", color: "var(--series-2)" },
  hsa: { name: "HSA", color: "var(--series-3)" },
  brokerage: { name: "Brokerage", color: "var(--series-4)" },
  crypto: { name: "Crypto", color: "var(--series-5)" },
  property: { name: "House equity", color: "var(--series-6)" },
  other: { name: "Other", color: "var(--series-8)" },
};

export const CATEGORY_ORDER = [
  "cash",
  "retirement",
  "hsa",
  "brokerage",
  "crypto",
  "property",
  "other",
];
