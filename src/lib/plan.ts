import type { MonthPoint } from "./metrics";
import type { BucketBalances, BucketPoint } from "./taxlots";

// ---------------------------------------------------------------------------
// FI (financial independence) projection — pure functions, usable client-side
// so assumption sliders recompute live. Every number here is driven by an
// explicit assumption; nothing is hidden.
//
// Conventions (documented on the page):
// - FI assets = investable buckets only; house equity is excluded (it doesn't
//   produce spendable income).
// - "Spendable" applies an effective-tax haircut to pre-tax dollars. Taxable-
//   account gains tax is ignored (basis untracked — future refinement).
// - Returns are real (inflation-adjusted), so the FI number stays in today's
//   dollars.
// - New savings are credited 1:1 to spendable assets (a slight overstatement
//   for the pre-tax share of contributions).
// ---------------------------------------------------------------------------

export type PlanAssumptions = {
  annualSpending: number;
  swr: number; // safe withdrawal rate
  expectedReal: number; // real annual return, expected case
  conservativeReal: number;
  optimisticReal: number;
  monthlySavings: number;
  pretaxTaxRate: number; // effective tax on pre-tax withdrawals
};

export const round2 = (v: number) => Math.round(v * 100) / 100;

/** Data-derived starting assumptions (user can override any of them). */
export function defaultAssumptions(months: MonthPoint[]): PlanAssumptions {
  const t12 = months.slice(-12);
  const avgSavings = t12.length
    ? t12.reduce((s, m) => s + m.savings, 0) / t12.length
    : 0;
  const avgWithdrawals = t12.length
    ? t12.reduce((s, m) => s + m.withdrawals, 0) / t12.length
    : 0;
  return {
    annualSpending: Math.max(24000, Math.round((avgWithdrawals * 12) / 1000) * 1000),
    swr: 0.04,
    expectedReal: 0.05,
    conservativeReal: 0.03,
    optimisticReal: 0.07,
    monthlySavings: Math.round(avgSavings / 100) * 100,
    pretaxTaxRate: 0.15,
  };
}

export function spendable(b: BucketBalances, pretaxTaxRate: number): number {
  return round2(
    b.taxable + b.roth + b.hsa + b.afterTax + b.pretax * (1 - pretaxTaxRate),
  );
}

export function spendableHistory(
  series: BucketPoint[],
  pretaxTaxRate: number,
): { date: string; actual: number }[] {
  return series.map((p) => ({ date: p.date, actual: spendable(p, pretaxTaxRate) }));
}

export type ProjectionPoint = {
  date: string;
  actual: number | null;
  expected: number | null;
  conservative: number | null;
  optimistic: number | null;
};

function addMonths(iso: string, n: number): string {
  const [y, m] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7))];
  const d = new Date(Date.UTC(y, m - 1 + n + 1, 0));
  return d.toISOString().slice(0, 10);
}

function projectSeries(
  start: number,
  monthlySavings: number,
  annualReal: number,
  months: number,
): number[] {
  const r = Math.pow(1 + annualReal, 1 / 12) - 1;
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < months; i++) {
    v = v * (1 + r) + monthlySavings;
    out.push(v);
  }
  return out;
}

export type PlanResult = {
  fiNumber: number;
  spendableNow: number;
  progress: number; // 0..1+
  fiDates: {
    expected: string | null;
    conservative: string | null;
    optimistic: string | null;
  };
  coastDate: string | null; // expected return, zero further savings
  chart: ProjectionPoint[];
};

const MAX_MONTHS = 480; // 40-year horizon cap

export function buildPlan(
  history: { date: string; actual: number }[],
  a: PlanAssumptions,
): PlanResult {
  const fiNumber = a.swr > 0 ? round2(a.annualSpending / a.swr) : Infinity;
  const lastActual = history[history.length - 1];
  const spendableNow = lastActual?.actual ?? 0;
  const startDate = lastActual?.date ?? new Date().toISOString().slice(0, 10);

  const scenarios = {
    expected: projectSeries(spendableNow, a.monthlySavings, a.expectedReal, MAX_MONTHS),
    conservative: projectSeries(spendableNow, a.monthlySavings, a.conservativeReal, MAX_MONTHS),
    optimistic: projectSeries(spendableNow, a.monthlySavings, a.optimisticReal, MAX_MONTHS),
  };

  const crossing = (vals: number[]): number | null => {
    if (spendableNow >= fiNumber) return 0;
    const i = vals.findIndex((v) => v >= fiNumber);
    return i === -1 ? null : i + 1;
  };
  const cross = {
    expected: crossing(scenarios.expected),
    conservative: crossing(scenarios.conservative),
    optimistic: crossing(scenarios.optimistic),
  };

  const coastVals = projectSeries(spendableNow, 0, a.expectedReal, MAX_MONTHS);
  const coastCross = crossing(coastVals);

  // Chart: trailing actual history + projections to the latest crossing
  // (or 15 years if nothing crosses), padded a year for context.
  const horizon = Math.min(
    MAX_MONTHS,
    Math.max(
      ...[cross.expected, cross.conservative, cross.optimistic].map((c) => c ?? 15 * 12),
    ) + 12,
  );
  const trailing = history.slice(-120); // last 10y of actuals
  const chart: ProjectionPoint[] = trailing.map((h) => ({
    date: h.date,
    actual: h.actual,
    expected: null,
    conservative: null,
    optimistic: null,
  }));
  if (chart.length) {
    // anchor projections at the last actual point so lines connect
    const anchor = chart[chart.length - 1];
    anchor.expected = anchor.conservative = anchor.optimistic = anchor.actual;
  }
  for (let i = 0; i < horizon; i++) {
    chart.push({
      date: addMonths(startDate, i + 1),
      actual: null,
      expected: round2(scenarios.expected[i]),
      conservative: round2(scenarios.conservative[i]),
      optimistic: round2(scenarios.optimistic[i]),
    });
  }

  return {
    fiNumber,
    spendableNow,
    progress: fiNumber > 0 ? spendableNow / fiNumber : 0,
    fiDates: {
      expected: cross.expected != null ? addMonths(startDate, cross.expected) : null,
      conservative:
        cross.conservative != null ? addMonths(startDate, cross.conservative) : null,
      optimistic:
        cross.optimistic != null ? addMonths(startDate, cross.optimistic) : null,
    },
    coastDate: coastCross != null ? addMonths(startDate, coastCross) : null,
    chart,
  };
}
