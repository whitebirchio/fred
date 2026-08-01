import type { AccountWithEntries, Entry } from "./metrics";
import { individualTotal } from "./metrics";
import { monthEnd } from "./format";
import {
  DEFAULT_SCOPE,
  isExcluded,
  weightFor,
  type HouseholdAccount,
  type Scope,
} from "./household";

// ---------------------------------------------------------------------------
// Tax-lot engine
//
// Tax character is a property of dollars, not accounts. This module resolves
// every dollar of investable net worth into one of five buckets:
//
//   taxable  — brokerage/cash/crypto; accessible any time, cap-gains rates
//   pretax   — traditional 401(k)/IRA/SEP/pension; taxed at withdrawal
//   roth     — Roth 401(k)/IRA; tax-free forever
//   afterTax — after-tax 401(k) basis (basis tax-free, growth pre-tax-like)
//   hsa      — triple-tax-advantaged
//
// Single-bucket accounts resolve at the account level. Mixed accounts
// (anything with a taxLotGroup) are simulated: accounts in the same group are
// one plan lineage (e.g. the LM→HS→LM 401(k) rollover chain), merged
// chronologically with intra-group transfers ignored, each month's growth
// allocated proportionally to the running sub-balances, and the simulated
// total rescaled to the actual statement balance so the output always ties
// out (the pre-scale residual is reported as drift).
// ---------------------------------------------------------------------------

export const TAX_BUCKETS = [
  "taxable",
  "pretax",
  "roth",
  "afterTax",
  "hsa",
] as const;
export type TaxBucket = (typeof TAX_BUCKETS)[number];

export type BucketBalances = Record<TaxBucket, number>;

export type BucketPoint = { date: string; total: number } & BucketBalances;

export type TaxLotUnit = {
  name: string;
  slugs: string[];
  mixed: boolean;
  buckets: BucketBalances;
  balance: number;
};

export type TaxLotResult = {
  series: BucketPoint[]; // portfolio-wide, monthly
  current: BucketBalances;
  units: TaxLotUnit[]; // per account / lineage group, current snapshot
  drift: { name: string; amount: number }[]; // cumulative pre-scale residuals
};

const round2 = (v: number) => Math.round(v * 100) / 100;

const zeroBuckets = (): BucketBalances => ({
  taxable: 0,
  pretax: 0,
  roth: 0,
  afterTax: 0,
  hsa: 0,
});

/** Bucket for a single-bucket account. */
export function accountBucket(a: {
  taxTreatment: string;
  category: string;
}): TaxBucket {
  switch (a.taxTreatment) {
    case "roth":
      return "roth";
    case "traditional":
    case "pension":
      return "pretax";
    case "hsa":
      return "hsa";
    default:
      return "taxable";
  }
}

/**
 * Which entry-form contribution field an account's individual contributions
 * belong in; "mixed" means the form should expose all three.
 */
export function contributionFieldFor(a: {
  taxLotGroup: string | null;
  taxTreatment: string;
}): "mixed" | "contributionsPretax" | "contributionsRoth" | "contributionsAfterTax" {
  if (a.taxLotGroup) return "mixed";
  switch (a.taxTreatment) {
    case "roth":
      return "contributionsRoth";
    case "taxable":
      return "contributionsAfterTax";
    default:
      return "contributionsPretax";
  }
}

type MonthKey = string; // month-end ISO

function monthGrid(accts: AccountWithEntries[]): MonthKey[] {
  let min = "9999-12-31";
  let max = "0000-01-01";
  for (const a of accts) {
    if (!a.entries.length) continue;
    if (a.entries[0].statementDate < min) min = a.entries[0].statementDate;
    const last = a.entries[a.entries.length - 1].statementDate;
    if (last > max) max = last;
  }
  if (min > max) return [];
  const grid: MonthKey[] = [];
  let [y, m] = [Number(min.slice(0, 4)), Number(min.slice(5, 7))];
  const [ly, lm] = [Number(max.slice(0, 4)), Number(max.slice(5, 7))];
  while (y < ly || (y === ly && m <= lm)) {
    grid.push(monthEnd(y, m));
    if (m === 12) {
      y++;
      m = 1;
    } else {
      m++;
    }
  }
  return grid;
}

type Unit = {
  name: string;
  slugs: string[];
  mixed: boolean;
  members: AccountWithEntries[];
  bucket: TaxBucket | null; // for single-bucket units
};

function buildUnits(
  accts: AccountWithEntries[],
  scope: Scope,
  primaryPersonId: number | null,
): Unit[] {
  // Tax character is derived from *flows* — contributions split by character,
  // growth allocated across them. An account with no close history has no
  // flows, so it cannot form lots here; those balances are classified by
  // account type instead (see bucketBalanceOnly).
  const included = accts.filter(
    (a) =>
      a.entries.length > 0 &&
      !isExcluded(a, scope) &&
      weightFor(a, scope, primaryPersonId) > 0,
  );
  const groups = new Map<string, AccountWithEntries[]>();
  const singles: AccountWithEntries[] = [];
  for (const a of included) {
    if (a.taxLotGroup) {
      const list = groups.get(a.taxLotGroup) ?? [];
      list.push(a);
      groups.set(a.taxLotGroup, list);
    } else {
      singles.push(a);
    }
  }
  const units: Unit[] = [];
  for (const [group, members] of groups) {
    units.push({
      name: `${group} (${members.map((m) => m.name).join(" + ")})`,
      slugs: members.map((m) => m.slug),
      mixed: true,
      members,
      bucket: null,
    });
  }
  for (const a of singles) {
    units.push({
      name: a.name,
      slugs: [a.slug],
      mixed: false,
      members: [a],
      bucket: accountBucket(a),
    });
  }
  return units;
}

export function taxLotSeries(
  accts: AccountWithEntries[],
  scope: Scope = DEFAULT_SCOPE,
  primaryPersonId: number | null = null,
): TaxLotResult {
  const units = buildUnits(accts, scope, primaryPersonId);
  const grid = monthGrid(units.flatMap((u) => u.members));
  const series: BucketPoint[] = [];
  const drift = new Map<string, number>();

  // per-unit state
  type UnitState = {
    cursor: Map<number, number>; // accountId -> entry index
    lastBalance: Map<number, number>; // accountId -> last statement balance
    sub: BucketBalances; // simulated sub-balances (mixed units)
    current: BucketBalances; // resolved buckets after tie-out
  };
  const states = new Map<Unit, UnitState>();
  for (const u of units) {
    states.set(u, {
      cursor: new Map(),
      lastBalance: new Map(),
      sub: zeroBuckets(),
      current: zeroBuckets(),
    });
  }

  for (const date of grid) {
    for (const u of units) {
      const st = states.get(u)!;
      const monthEntries: Entry[] = [];
      for (const m of u.members) {
        let i = st.cursor.get(m.id) ?? 0;
        while (i < m.entries.length && m.entries[i].statementDate <= date) {
          monthEntries.push(m.entries[i]);
          st.lastBalance.set(m.id, m.entries[i].balance);
          i++;
        }
        st.cursor.set(m.id, i);
      }
      const actual = u.members.reduce(
        (s, m) => s + (st.lastBalance.get(m.id) ?? 0),
        0,
      );

      if (!u.mixed) {
        st.current = zeroBuckets();
        st.current[u.bucket!] = actual;
        continue;
      }

      // Mixed unit: advance the simulation with this month's flows.
      for (const e of monthEntries) {
        st.sub.pretax += e.contributionsPretax + e.employerContributions;
        st.sub.roth += e.contributionsRoth;
        st.sub.afterTax += e.contributionsAfterTax;
        // Intra-group transfers are internal moves — ignored by design.
        const growthAndWithdrawals = e.growth - e.withdrawals;
        const simTotal = st.sub.pretax + st.sub.roth + st.sub.afterTax;
        if (simTotal > 0 && growthAndWithdrawals !== 0) {
          const f = growthAndWithdrawals / simTotal;
          st.sub.pretax += st.sub.pretax * f;
          st.sub.roth += st.sub.roth * f;
          st.sub.afterTax += st.sub.afterTax * f;
        }
      }
      // Tie out to the statements: keep simulated proportions, actual level.
      const simTotal = st.sub.pretax + st.sub.roth + st.sub.afterTax;
      st.current = zeroBuckets();
      if (simTotal > 0 && actual > 0) {
        const scale = actual / simTotal;
        st.current.pretax = st.sub.pretax * scale;
        st.current.roth = st.sub.roth * scale;
        st.current.afterTax = st.sub.afterTax * scale;
        drift.set(u.name, round2(actual - simTotal));
      } else if (actual > 0) {
        st.current.pretax = actual; // no contribution history — assume pre-tax
      }
    }

    const point: BucketPoint = { date, total: 0, ...zeroBuckets() };
    for (const u of units) {
      const cur = states.get(u)!.current;
      for (const b of TAX_BUCKETS) point[b] += cur[b];
    }
    for (const b of TAX_BUCKETS) point[b] = round2(point[b]);
    point.total = round2(
      TAX_BUCKETS.reduce((s, b) => s + point[b], 0),
    );
    series.push(point);
  }

  const last = series[series.length - 1];
  const current = last
    ? {
        taxable: last.taxable,
        pretax: last.pretax,
        roth: last.roth,
        afterTax: last.afterTax,
        hsa: last.hsa,
      }
    : zeroBuckets();

  const unitSnapshots: TaxLotUnit[] = units
    .map((u) => {
      const cur = states.get(u)!.current;
      const buckets = Object.fromEntries(
        TAX_BUCKETS.map((b) => [b, round2(cur[b])]),
      ) as BucketBalances;
      return {
        name: u.name,
        slugs: u.slugs,
        mixed: u.mixed,
        buckets,
        balance: round2(TAX_BUCKETS.reduce((s, b) => s + buckets[b], 0)),
      };
    })
    .filter((u) => u.balance > 0.5)
    .sort((a, b) => b.balance - a.balance);

  return {
    series,
    current,
    units: unitSnapshots,
    drift: [...drift.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .filter((d) => Math.abs(d.amount) > 1),
  };
}

/**
 * Tax bucket for an account Fred has no flow history for.
 *
 * The lot engine above derives character from contributions; with none to
 * read, the only honest classifier left is what kind of account it is. That
 * is weaker — it can't distinguish a 401(k)'s Roth sub-balance from its
 * pre-tax one — so these balances are reported separately from simulated
 * lots rather than blended in silently.
 */
export function bucketForAccount(a: {
  taxTreatment?: string | null;
  category: string;
  name?: string;
}): TaxBucket | null {
  switch (a.taxTreatment) {
    case "taxable":
      return "taxable";
    case "traditional":
    case "pension":
      return "pretax";
    case "roth":
      return "roth";
    case "hsa":
      return "hsa";
  }

  // `na` is the default for accounts added from a provider feed, where nobody
  // has declared a treatment. Category alone would call every retirement
  // account pre-tax — turning a Roth IRA into a taxable-at-withdrawal balance,
  // which is the single most consequential thing to get wrong here. The name
  // is the only remaining evidence, and Roth accounts are near-universally
  // labelled as such. Order matters: "Roth IRA" must not fall into the IRA
  // rule below it.
  const n = (a.name ?? "").toLowerCase();
  if (/\broth\b/.test(n)) return "roth";
  if (/\bhsa\b|health savings/.test(n)) return "hsa";
  if (/pension|traditional|\btrad\b|\bsep\b|401\s*\(?k\)?|\bira\b|403\s*\(?b\)?/.test(n))
    return "pretax";

  switch (a.category) {
    case "cash":
    case "brokerage":
    case "crypto":
      return "taxable";
    case "retirement":
      return "pretax";
    case "hsa":
      return "hsa";
    default:
      return null; // property and liabilities aren't investable dollars
  }
}

export type BalanceOnlyBuckets = {
  buckets: BucketBalances;
  total: number;
  accounts: { name: string; bucket: TaxBucket; value: number }[];
};

/**
 * Classify in-scope accounts that carry a balance but no close history —
 * Kate's accounts and anything else riding purely on a provider feed — so
 * they reach the allocation without being invented into the flow series.
 */
export function bucketBalanceOnly(
  accts: HouseholdAccount[],
  scope: Scope,
  primaryPersonId: number | null,
  hasCloseHistory: (accountId: number) => boolean,
): BalanceOnlyBuckets {
  const buckets = zeroBuckets();
  const out: BalanceOnlyBuckets["accounts"] = [];
  for (const a of accts) {
    if (hasCloseHistory(a.id)) continue;
    if (isExcluded(a, scope)) continue;
    if (!a.isActive) continue;
    const w = weightFor(a, scope, primaryPersonId);
    if (w === 0) continue;
    const bucket = bucketForAccount(a);
    if (!bucket) continue;
    const value = round2(a.signedBalance * w);
    if (value <= 0) continue; // liabilities aren't investable dollars either
    buckets[bucket] += value;
    out.push({ name: a.name, bucket, value });
  }
  for (const b of TAX_BUCKETS) buckets[b] = round2(buckets[b]);
  return {
    buckets,
    total: round2(TAX_BUCKETS.reduce((s, b) => s + buckets[b], 0)),
    accounts: out.sort((x, y) => y.value - x.value),
  };
}

export const BUCKET_META: Record<
  TaxBucket,
  { name: string; color: string; note: string }
> = {
  taxable: {
    name: "Taxable",
    color: "var(--series-1)",
    note: "Accessible any time; long-term capital-gains rates",
  },
  pretax: {
    name: "Pre-tax",
    color: "var(--series-3)",
    note: "401(k)/IRA/SEP/pension — ordinary income tax at withdrawal, RMDs later",
  },
  roth: {
    name: "Roth",
    color: "var(--series-2)",
    note: "Tax-free growth and withdrawals",
  },
  afterTax: {
    name: "After-tax 401(k)",
    color: "var(--series-7)",
    note: "Basis withdraws tax-free; growth taxed like pre-tax",
  },
  hsa: {
    name: "HSA",
    color: "var(--series-4)",
    note: "Triple tax-advantaged for medical (ordinary income + penalty otherwise before 65)",
  },
};

/** Individual + employer contributions for an entry (savings attribution). */
export const entryContributions = (e: Entry): number =>
  individualTotal(e) + e.employerContributions;
