/**
 * The pay-stub vocabulary, and the arithmetic that turns a stub's line items
 * into the denormalised columns on `paychecks`.
 *
 * Deliberately free of database imports: the entry form is a Client Component
 * and the server action runs on the server, and both have to agree about what
 * "gross" means. Two implementations of that would drift, which is how a
 * number on a form ends up meaning something different from the same number
 * in a chart.
 *
 * Every rule below is lifted from the Pay Stubs workbook that seeded Fred, so
 * stubs typed in from here on stay consistent with the 417 already stored:
 *
 *   Total Income    =SUM(E:M)               income, EXCLUDING imputed lines
 *   Calculated Net  =SUM(E:M)-SUM(O:AK)     total income − every deduction
 *   Checksum        =(Net Pay = Calc Net)   the tie-out the form shows live
 *   401k            =SUM(S,AE,AF)           traditional + Roth + after-tax
 *   Tax Rate        =SUM(Y:AB)/SUM(E:N)     taxes over income INCLUDING imputed
 */

export const SECTIONS = ["income", "preTax", "taxes", "postTax"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<Section, string> = {
  income: "Income",
  preTax: "Pre-tax deductions",
  taxes: "Taxes",
  postTax: "Post-tax deductions",
};

/** What a stub's `items` column holds: amounts keyed by line-item name. */
export type StubItems = Record<Section, Record<string, number>>;

export const emptyItems = (): StubItems => ({
  income: {},
  preTax: {},
  taxes: {},
  postTax: {},
});

/**
 * Income that is taxed but never paid out — imputed income, which payroll adds
 * to the taxable base and then leaves out of the cheque.
 *
 * This cannot be inferred from a line's name. The workbook encodes it by
 * position (Total Income sums E:M and stops one column short of Group Life
 * Adj), and employers differ: at LM, Group Life Adj is imputed, while at HS
 * the comparable GTL and LTD lines ARE inside Total Income and get cancelled
 * by matching post-tax "Offset" lines instead. Checked against all 417 stored
 * stubs — LM's stored gross is short by exactly its Group Life Adj on every
 * one of 363 stubs, HS's and Trellis's by nothing.
 */
export const IMPUTED_INCOME: Record<string, string[]> = {
  lm: ["Group Life Adj"],
};

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** Tolerant money parsing: "$1,234.50", "1234.5", "" → 1234.5 / 1234.5 / 0. */
export function parseMoney(v: unknown): number {
  const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? r2(n) : 0;
}

const sumOf = (o: Record<string, number> | undefined) =>
  r2(Object.values(o ?? {}).reduce((a, b) => a + b, 0));

/** Which tax-character bucket a 401(k) line belongs to. */
export function k401Bucket(name: string): "roth" | "afterTax" | "traditional" {
  if (/roth/i.test(name)) return "roth";
  if (/after\s*tax/i.test(name)) return "afterTax";
  return "traditional";
}

export type StubTotals = {
  /** Gross as the rest of Fred means it: paid income, imputed lines removed. */
  totalIncome: number;
  /** The base payroll withholds against — includes imputed income. */
  taxableIncome: number;
  imputed: number;
  preTaxTotal: number;
  taxesTotal: number;
  postTaxTotal: number;
  /** The workbook's Calculated Net: what net pay has to equal. */
  computedNet: number;
  federalTax: number;
  retirement401k: number;
  /** The three tax characters the tax-lot engine models, kept apart. */
  k401Split: { traditional: number; roth: number; afterTax: number };
  hsa: number;
  bonus: number;
};

/**
 * Derive every stored aggregate from the line items alone, exactly as
 * `scripts/extract_seed.py` did for the seeded stubs.
 */
export function deriveStub(items: StubItems, employerSlug: string): StubTotals {
  const income = items.income ?? {};
  const imputedNames = IMPUTED_INCOME[employerSlug] ?? [];
  const imputed = r2(
    imputedNames.reduce((a, name) => a + (income[name] ?? 0), 0),
  );

  const taxableIncome = sumOf(income);
  const totalIncome = r2(taxableIncome - imputed);
  const preTaxTotal = sumOf(items.preTax);
  const taxesTotal = sumOf(items.taxes);
  const postTaxTotal = sumOf(items.postTax);

  const federalTax = r2(
    Object.entries(items.taxes ?? {})
      .filter(([k]) => /fed(eral)?/i.test(k))
      .reduce((a, [, v]) => a + v, 0),
  );

  const k401Split = { traditional: 0, roth: 0, afterTax: 0 };
  for (const section of ["preTax", "postTax"] as const) {
    for (const [name, v] of Object.entries(items[section] ?? {})) {
      if (/401k/i.test(name)) k401Split[k401Bucket(name)] += v;
    }
  }
  for (const k of ["traditional", "roth", "afterTax"] as const) {
    k401Split[k] = r2(k401Split[k]);
  }

  return {
    totalIncome,
    taxableIncome,
    imputed,
    preTaxTotal,
    taxesTotal,
    postTaxTotal,
    computedNet: r2(totalIncome - preTaxTotal - taxesTotal - postTaxTotal),
    federalTax,
    retirement401k: r2(
      k401Split.traditional + k401Split.roth + k401Split.afterTax,
    ),
    k401Split,
    hsa: r2(items.preTax?.["HSA"] ?? 0),
    bonus: r2(
      Object.entries(income)
        .filter(([k]) => /bonus/i.test(k))
        .reduce((a, [, v]) => a + v, 0),
    ),
  };
}

/** Form field name for one line item, and the parser for it. */
export const itemFieldName = (section: Section, name: string) =>
  `item:${section}:${name}`;

export function itemsFromFormData(fd: Iterable<[string, FormDataEntryValue]>): StubItems {
  const items = emptyItems();
  for (const [key, raw] of fd) {
    if (!key.startsWith("item:")) continue;
    // name may itself contain ":" — only the first two segments are structural
    const [, section, ...rest] = key.split(":");
    const name = rest.join(":").trim();
    if (!name || !(SECTIONS as readonly string[]).includes(section)) continue;
    const v = parseMoney(raw);
    // Zero-valued lines are omitted, matching the seeded stubs: `items` lists
    // what happened on this cheque, not every line the employer could print.
    if (v !== 0) items[section as Section][name] = v;
  }
  return items;
}
