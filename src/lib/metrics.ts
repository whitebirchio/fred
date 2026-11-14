import { asc } from "drizzle-orm";
import { db } from "@/db";
import {
  accountEntries,
  accounts,
  paychecks,
  employers,
  properties,
  propertyPayments,
  propertyPaymentShares,
  propertyValuations,
  persons,
  contributionLimits,
  appConfig,
} from "@/db/schema";
import { monthEnd } from "./format";
import { SECTIONS, type Section, type StubItems } from "./paystubs";
import type { AccountHistory, MonthPointForAccount } from "./series";
import {
  DEFAULT_SCOPE,
  isExcluded,
  isLiability,
  signedValue,
  weightFor,
  type Scope,
} from "./household";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Flow = {
  contributions: number; // individual + employer (matches the sheets' CONTRIBUTIONS)
  transfersIn: number;
  growth: number;
  withdrawals: number;
  transfersOut: number;
  /** Balance movement we can see but cannot explain: months whose figure came
   *  from a provider, which reports what an account is worth but never why it
   *  changed. Reported as its own quantity rather than being guessed into
   *  contributions or growth — the honest answer to a real gap in the data. */
  unknown: number;
};

export type MonthPoint = Flow & {
  date: string; // month-end ISO
  balance: number;
  savings: number; // contributions - withdrawals
  /** True once every account that depends on a provider for its history is
   *  represented. Those are the accounts that were invisible in the charts
   *  before month-end resolution existed, so this marks where the household
   *  picture becomes complete rather than merely partial.
   *
   *  Deliberately not "every account has data": an account opened last year
   *  legitimately has no history before it existed, and letting the newest
   *  account define the boundary would put it in the recent past and say
   *  nothing useful. */
  fullCoverage: boolean;
};

export type AccountWithEntries = typeof accounts.$inferSelect & {
  entries: (typeof accountEntries.$inferSelect)[];
};

export type Entry = typeof accountEntries.$inferSelect;

/** Individual (non-employer) contributions across the three tax characters. */
export const individualTotal = (e: Entry): number =>
  e.contributionsPretax + e.contributionsRoth + e.contributionsAfterTax;

export type HouseMonth = {
  date: string;
  marketValue: number;
  loanBalance: number;
  equity: number; // market - loan
  equityShare: number; // primary person's share of equity (even split)
  cumScott: number;
  cumKate: number;
  cumPrincipal: number;
  cumInterest: number;
  cumEscrow: number;
  cumHoa: number;
  cumFees: number;
};

// ---------------------------------------------------------------------------
// Data loading (one round of queries, then in-memory computation)
// ---------------------------------------------------------------------------

export async function loadAccounts(): Promise<AccountWithEntries[]> {
  const accts = await db
    .select()
    .from(accounts)
    .orderBy(asc(accounts.sortOrder));
  const entries = await db
    .select()
    .from(accountEntries)
    .orderBy(asc(accountEntries.statementDate));
  const byAccount = new Map<number, (typeof accountEntries.$inferSelect)[]>();
  for (const e of entries) {
    const list = byAccount.get(e.accountId) ?? [];
    list.push(e);
    byAccount.set(e.accountId, list);
  }
  return accts.map((a) => ({ ...a, entries: byAccount.get(a.id) ?? [] }));
}

export async function loadHouse() {
  const [property] = await db.select().from(properties);
  if (!property) return null;
  const payments = await db
    .select()
    .from(propertyPayments)
    .orderBy(asc(propertyPayments.date), asc(propertyPayments.id));
  const shares = await db.select().from(propertyPaymentShares);
  const valuations = await db
    .select()
    .from(propertyValuations)
    .orderBy(asc(propertyValuations.date));
  const people = await db.select().from(persons);
  return { property, payments, shares, valuations, people };
}

// ---------------------------------------------------------------------------
// Pay-stub entry vocabulary
// ---------------------------------------------------------------------------

export type CatalogLine = {
  name: string;
  /** How many stubs this line has ever appeared on. */
  seen: number;
  lastSeen: string;
  /** What it was on the most recent stub that had it — the entry default. */
  lastValue: number;
  /** On the newest stub for this employer, so still a live payroll line. */
  current: boolean;
};

export type EmployerCatalog = {
  employerId: number;
  slug: string;
  name: string;
  isActive: boolean;
  lines: Record<Section, CatalogLine[]>;
  /** The newest stub, for "copy last stub" and for the cadence hint. */
  last:
    | {
        paymentDate: string;
        payBeginDate: string | null;
        payEndDate: string | null;
        annualSalary: number | null;
        netPay: number;
      }
    | undefined;
};

/**
 * The line items each employer actually uses, learned from the stubs already
 * stored rather than from a table someone has to maintain.
 *
 * `items` has carried the full four-section breakdown since the seed, so the
 * vocabulary is already in the database — LM has 33 distinct lines across its
 * history but only ~13 on a current cheque. The form leans on `current` to
 * show today's payroll and tuck the retired lines (Vision, Group Life, the
 * commuter benefits) out of the way without losing them.
 */
export async function loadPaycheckCatalog(): Promise<EmployerCatalog[]> {
  const emps = await db.select().from(employers);
  const checks = await db
    .select()
    .from(paychecks)
    .orderBy(asc(paychecks.paymentDate), asc(paychecks.id));

  return emps
    .map((e) => {
      const mine = checks.filter((c) => c.employerId === e.id);
      const newest = mine.at(-1);
      const lines = {} as Record<Section, CatalogLine[]>;

      for (const section of SECTIONS) {
        const acc = new Map<string, CatalogLine>();
        for (const c of mine) {
          const items = (c.items ?? {}) as Partial<StubItems>;
          for (const [name, value] of Object.entries(items[section] ?? {})) {
            if (typeof value !== "number") continue;
            const prev = acc.get(name);
            // `mine` is in date order, so a later stub simply overwrites the
            // defaults — lastValue/lastSeen end up describing the newest
            // appearance without a second pass.
            acc.set(name, {
              name,
              seen: (prev?.seen ?? 0) + 1,
              lastSeen: c.paymentDate,
              lastValue: value,
              current: false,
            });
          }
        }
        const onNewest = new Set(
          Object.keys(
            ((newest?.items ?? {}) as Partial<StubItems>)[section] ?? {},
          ),
        );
        lines[section] = [...acc.values()]
          .map((l) => ({ ...l, current: onNewest.has(l.name) }))
          // current lines first, then whatever was used most often
          .sort(
            (a, b) =>
              Number(b.current) - Number(a.current) ||
              b.lastSeen.localeCompare(a.lastSeen) ||
              b.seen - a.seen,
          );
      }

      return {
        employerId: e.id,
        slug: e.slug,
        name: e.name,
        isActive: e.isActive,
        lines,
        last: newest
          ? {
              paymentDate: newest.paymentDate,
              payBeginDate: newest.payBeginDate,
              payEndDate: newest.payEndDate,
              annualSalary:
                newest.annualSalary === null ? null : Number(newest.annualSalary),
              netPay: Number(newest.netPay),
            }
          : undefined,
      };
    })
    // active employers first; you enter stubs for the job you have
    .sort(
      (a, b) =>
        Number(b.isActive) - Number(a.isActive) ||
        (b.last?.paymentDate ?? "").localeCompare(a.last?.paymentDate ?? ""),
    );
}

export async function loadIncome() {
  const emps = await db.select().from(employers);
  const checks = await db
    .select()
    .from(paychecks)
    .orderBy(asc(paychecks.paymentDate), asc(paychecks.id));
  const limits = await db.select().from(contributionLimits);
  const config = await db.select().from(appConfig);
  return { employers: emps, paychecks: checks, limits, config };
}

// ---------------------------------------------------------------------------
// House series (replicates the 13 Charron Cir Analysis tab)
// ---------------------------------------------------------------------------

export function houseMonthly(
  house: NonNullable<Awaited<ReturnType<typeof loadHouse>>>,
): HouseMonth[] {
  const { property, payments, shares, valuations, people } = house;
  const scottId = people.find((p) => p.isPrimary)?.id;
  const shareByPayment = new Map<number, { personId: number; amount: number }[]>();
  for (const s of shares) {
    const list = shareByPayment.get(s.paymentId) ?? [];
    list.push({ personId: s.personId, amount: s.amount });
    shareByPayment.set(s.paymentId, list);
  }

  if (payments.length === 0) return [];
  const first = payments[0].date;
  const last = valuations.length
    ? valuations[valuations.length - 1].date
    : payments[payments.length - 1].date;

  const months: HouseMonth[] = [];
  let pi = 0;
  let vi = 0;
  // The ledger starts at the full purchase price; down payments walk it down.
  let loan = property.purchasePrice;
  let market = property.purchasePrice;
  let cumScott = 0,
    cumKate = 0,
    cumPrincipal = 0,
    cumInterest = 0,
    cumEscrow = 0,
    cumHoa = 0,
    cumFees = 0;

  const [fy, fm] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm); m === 12 ? (y++, (m = 1)) : m++) {
    const end = monthEnd(y, m);
    while (pi < payments.length && payments[pi].date <= end) {
      const p = payments[pi];
      cumPrincipal += p.principal;
      cumInterest += p.interest;
      cumEscrow += p.escrow;
      cumHoa += p.hoa;
      cumFees += p.fees;
      if (p.loanBalanceAfter != null) loan = p.loanBalanceAfter;
      for (const s of shareByPayment.get(p.id) ?? []) {
        if (s.personId === scottId) cumScott += s.amount;
        else cumKate += s.amount;
      }
      pi++;
    }
    while (vi < valuations.length && valuations[vi].date <= end) {
      market = valuations[vi].marketValue;
      vi++;
    }
    const equity = market - loan;
    months.push({
      date: end,
      marketValue: market,
      loanBalance: loan,
      equity,
      equityShare: equity * property.equityShare,
      cumScott: round2(cumScott),
      cumKate: round2(cumKate),
      cumPrincipal: round2(cumPrincipal),
      cumInterest: round2(cumInterest),
      cumEscrow: round2(cumEscrow),
      cumHoa: round2(cumHoa),
      cumFees: round2(cumFees),
    });
  }
  return months;
}

// ---------------------------------------------------------------------------
// Portfolio series (replicates the Finances Analysis sheet)
// ---------------------------------------------------------------------------

const round2 = (v: number) => Math.round(v * 100) / 100;

export type PortfolioSeries = {
  months: MonthPoint[]; // totals per month, house included
  byCategory: { date: string; [category: string]: number | string }[];
  perAccount: {
    account: AccountWithEntries;
    current: number;
    prev: number;
    lastEntry: string | null;
  }[];
  houseMonths: HouseMonth[];
};

/**
 * Monthly totals, built from resolved month-end balances.
 *
 * Every account contributes, whether or not Fred holds a monthly close for it:
 * a close supplies the balance *and* its flow breakdown, a provider snapshot
 * supplies the balance alone and its movement is reported as `unknown`. That
 * is what stops the charts from disagreeing with the headline — they are now
 * the same resolution, evaluated at each month instead of only today.
 *
 * The house participates as even-split equity from the property ledger:
 * Δ(payments) counts as a transfer in, the rest of the equity change as growth.
 */
export function portfolioSeries(
  accts: AccountWithEntries[],
  houseMonths: HouseMonth[],
  scope: Scope = DEFAULT_SCOPE,
  primaryPersonId: number | null = null,
  histories: Map<number, AccountHistory> = new Map(),
): PortfolioSeries {
  // Same membership rules as the live rollup in src/lib/household.ts, applied
  // to the month-end record instead of today's balances. Anything that
  // diverged here is precisely what made Overview and Household disagree.
  const weights = new Map<number, number>();
  const included = accts.filter((a) => {
    if (isExcluded(a, scope)) return false;
    const w = weightFor(a, scope, primaryPersonId);
    if (w === 0) return false;
    weights.set(a.id, w);
    return true;
  });
  const weightOf = (id: number) => weights.get(id) ?? 1;

  // The house's month-by-month value comes from the property ledger, not from
  // statements, so it is driven by its account's flags rather than its
  // (nonexistent) entries. Before that account exists, fall back to the
  // scope's own home setting.
  const houseAccount = accts.find(
    (a) => a.propertyId != null && !isLiability(a.category),
  );
  const houseWeight = houseAccount
    ? weightFor(houseAccount, scope, primaryPersonId)
    : scope.who === "all"
      ? 1
      : 0.5;
  const includeHouse = houseAccount
    ? !isExcluded(houseAccount, scope) && houseWeight > 0
    : scope.includeHome && houseWeight > 0;
  // Span every month any in-scope account has evidence for. Falling back to
  // statement dates keeps this working when no histories are supplied (the
  // fixture pipeline, and any caller that only wants close data).
  let min = "9999-12-31";
  let max = "0000-01-01";
  for (const a of included) {
    const pts = histories.get(a.id)?.points;
    const first = pts?.length ? pts[0].date : a.entries[0]?.statementDate;
    const last = pts?.length
      ? pts[pts.length - 1].date
      : a.entries[a.entries.length - 1]?.statementDate;
    if (!first || !last) continue;
    if (first < min) min = first;
    if (last > max) max = last;
  }
  if (includeHouse && houseMonths.length) {
    const hLast = houseMonths[houseMonths.length - 1].date;
    max = hLast > max ? hLast : max;
  }
  if (min > max) return { months: [], byCategory: [], perAccount: [], houseMonths };

  const [fy, fm] = [Number(min.slice(0, 4)), Number(min.slice(5, 7))];
  const [ly, lm] = [Number(max.slice(0, 4)), Number(max.slice(5, 7))];

  const cursors = new Map<number, number>();
  const lastBalance = new Map<number, number>();
  const houseByDate = new Map(houseMonths.map((h) => [h.date, h]));
  let prevHouse: HouseMonth | null = null;

  // Per-account month lookup, and the month each one first has any evidence —
  // an account appearing for the first time is an opening position, not an
  // inflow, or every account would read as a giant deposit in its first month.
  const pointByMonth = new Map<number, Map<string, MonthPointForAccount>>();
  for (const [id, h] of histories) {
    pointByMonth.set(id, new Map(h.points.map((p) => [p.date, p])));
  }

  // Accounts with no monthly close of their own rely entirely on a provider
  // for history — Kate's and the joint accounts. The month the last of them
  // starts reporting is the month this chart stops understating the household.
  const providerOnly = included.filter((a) => a.entries.length === 0);
  const coverageMonth = providerOnly.reduce<string | null>((latest, a) => {
    const first = histories.get(a.id)?.points[0]?.date ?? null;
    if (!first) return latest;
    return !latest || first > latest ? first : latest;
  }, null);

  const months: MonthPoint[] = [];
  const byCategory: PortfolioSeries["byCategory"] = [];

  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm); m === 12 ? (y++, (m = 1)) : m++) {
    const end = monthEnd(y, m);
    const flow: Flow = {
      contributions: 0,
      transfersIn: 0,
      growth: 0,
      withdrawals: 0,
      transfersOut: 0,
      unknown: 0,
    };
    const catRow: { [k: string]: number | string } = { date: end };
    let total = 0;

    for (const a of included) {
      const w = weightOf(a.id);
      const point = pointByMonth.get(a.id)?.get(end);

      if (point) {
        const prevBalance = lastBalance.get(a.id);
        if (point.origin === "close" && point.entry) {
          const e = point.entry;
          flow.contributions += (individualTotal(e) + e.employerContributions) * w;
          flow.transfersIn += e.transfersIn * w;
          flow.growth += e.growth * w;
          flow.withdrawals += e.withdrawals * w;
          flow.transfersOut += e.transfersOut * w;
        } else if (prevBalance !== undefined) {
          // A provider tells us the balance, never why it moved.
          flow.unknown += signedValue(a.category, point.balance - prevBalance) * w;
        }
        lastBalance.set(a.id, point.balance);
      } else {
        // No history supplied for this account: fall back to walking its
        // entries, so callers that pass no histories still get the old series.
        let i = cursors.get(a.id) ?? 0;
        while (i < a.entries.length && a.entries[i].statementDate <= end) {
          const e = a.entries[i];
          flow.contributions += (individualTotal(e) + e.employerContributions) * w;
          flow.transfersIn += e.transfersIn * w;
          flow.growth += e.growth * w;
          flow.withdrawals += e.withdrawals * w;
          flow.transfersOut += e.transfersOut * w;
          lastBalance.set(a.id, e.balance);
          i++;
        }
        cursors.set(a.id, i);
      }

      // Liabilities are stored as positive magnitudes; without this sign a
      // credit-card balance would *add* to net worth.
      const bal = signedValue(a.category, lastBalance.get(a.id) ?? 0) * w;
      total += bal;
      // A debt secured against a property belongs on that property's line, so
      // the band reads as *equity* — market value less what is owed, the same
      // figure /house calls "Total equity". Charting the house gross with its
      // mortgage in a separate band shows a house nobody owns outright.
      const band = a.propertyId != null ? "property" : a.category;
      catRow[band] = ((catRow[band] as number) ?? 0) + bal;
    }

    // The house rides on the property ledger rather than statements, and only
    // participates when the scope asks for it. Its weight follows the same
    // rule as any joint account.
    // Once the mortgage is its own account, the ledger must contribute the
    // *market value* only — contributing equity would net the loan a second
    // time, on top of the mortgage account already carrying it. Only the
    // legacy path (no house account yet) still uses equity.
    const houseValueOf = (h: HouseMonth) =>
      (houseAccount ? h.marketValue : h.equity) * houseWeight;

    const house = includeHouse ? houseByDate.get(end) : undefined;
    if (house) {
      const value = houseValueOf(house);
      total += value;
      catRow["property"] = ((catRow["property"] as number) ?? 0) + value;
      const dPaid =
        (house.cumScott +
          house.cumKate -
          (prevHouse ? prevHouse.cumScott + prevHouse.cumKate : 0)) *
        houseWeight;
      const dValue = value - (prevHouse ? houseValueOf(prevHouse) : 0);
      flow.transfersIn += dPaid;
      flow.growth += dValue - dPaid;
      prevHouse = house;
    } else if (includeHouse && prevHouse) {
      const value = houseValueOf(prevHouse);
      total += value;
      catRow["property"] = ((catRow["property"] as number) ?? 0) + value;
    }

    months.push({
      date: end,
      balance: round2(total),
      contributions: round2(flow.contributions),
      transfersIn: round2(flow.transfersIn),
      growth: round2(flow.growth),
      withdrawals: round2(flow.withdrawals),
      transfersOut: round2(flow.transfersOut),
      unknown: round2(flow.unknown),
      savings: round2(flow.contributions - flow.withdrawals),
      fullCoverage: coverageMonth === null || end >= coverageMonth,
    });
    for (const k of Object.keys(catRow)) {
      if (k !== "date") catRow[k] = round2(catRow[k] as number);
    }
    // The net line, carried alongside the bands. A stacked area chart piles
    // positives up from zero and negatives down, so the top edge of the stack
    // is assets, not net worth — on a chart called "net worth" the actual
    // figure has to be drawn, not inferred from where the colours stop.
    catRow.net = round2(total);
    byCategory.push(catRow as PortfolioSeries["byCategory"][number]);
  }

  const perAccount = included.map((account) => {
    const n = account.entries.length;
    const w = weightOf(account.id);
    const at = (i: number) =>
      round2(signedValue(account.category, account.entries[i].balance) * w);
    return {
      account,
      current: n ? at(n - 1) : 0,
      prev: n > 1 ? at(n - 2) : 0,
      lastEntry: n ? account.entries[n - 1].statementDate : null,
    };
  });

  return { months, byCategory, perAccount, houseMonths };
}

// ---------------------------------------------------------------------------
// Annual YTD pivots (the sheets' ANNUAL NET * blocks: value at month M is the
// cumulative Jan..M figure for that year; savings rate = YTD savings / YTD
// contributions)
// ---------------------------------------------------------------------------

export type YearOverlay = {
  metric: string;
  years: number[];
  // rows[monthIndex] = { month: "Jan", [year]: value }
  rows: { month: string; [year: string]: number | string | null }[];
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function annualOverlays(months: MonthPoint[]): {
  netBalance: YearOverlay;
  contributions: YearOverlay;
  growth: YearOverlay;
  savings: YearOverlay;
  savingsRate: YearOverlay;
} {
  const years = [...new Set(months.map((m) => Number(m.date.slice(0, 4))))];
  const byYear = new Map<number, MonthPoint[]>();
  for (const m of months) {
    const y = Number(m.date.slice(0, 4));
    const list = byYear.get(y) ?? [];
    list.push(m);
    byYear.set(y, list);
  }
  const decBalance = new Map<number, number>();
  for (const m of months) {
    if (m.date.slice(5, 7) === "12") decBalance.set(Number(m.date.slice(0, 4)), m.balance);
  }

  const make = (fn: (pts: MonthPoint[], year: number, upTo: number) => number | null, metric: string): YearOverlay => {
    const rows = MONTHS.map((label, mi) => {
      const row: YearOverlay["rows"][number] = { month: label };
      for (const y of years) {
        const pts = (byYear.get(y) ?? []).filter(
          (p) => Number(p.date.slice(5, 7)) <= mi + 1,
        );
        row[String(y)] =
          pts.length && Number(pts[pts.length - 1].date.slice(5, 7)) === mi + 1
            ? fn(pts, y, mi + 1)
            : null;
      }
      return row;
    });
    return { metric, years, rows };
  };

  const sum = (pts: MonthPoint[], key: keyof Flow | "savings") =>
    round2(pts.reduce((s, p) => s + (p[key] as number), 0));

  return {
    netBalance: make((pts, y) => {
      const base = decBalance.get(y - 1);
      const last = pts[pts.length - 1].balance;
      return base == null ? null : round2(last - base);
    }, "Net balance change"),
    contributions: make((pts) => sum(pts, "contributions"), "Contributions"),
    growth: make((pts) => sum(pts, "growth"), "Growth"),
    savings: make((pts) => sum(pts, "savings"), "Savings"),
    savingsRate: make((pts) => {
      const c = sum(pts, "contributions");
      const s = sum(pts, "savings");
      return c ? round2((s / c) * 1000) / 1000 : null;
    }, "Savings rate"),
  };
}

// ---------------------------------------------------------------------------
// Income metrics — employers, paychecks, withholding
// ---------------------------------------------------------------------------

export type IncomeYear = {
  year: number;
  gross: number;
  net: number;
  bonus: number;
  taxes: number;
  federalTax: number;
  retirement401k: number;
  hsa: number;
  effectiveRate: number;
};

export function incomeByYear(checks: (typeof paychecks.$inferSelect)[]): IncomeYear[] {
  const map = new Map<number, IncomeYear>();
  for (const c of checks) {
    const y = Number(c.paymentDate.slice(0, 4));
    const row =
      map.get(y) ??
      ({
        year: y,
        gross: 0,
        net: 0,
        bonus: 0,
        taxes: 0,
        federalTax: 0,
        retirement401k: 0,
        hsa: 0,
        effectiveRate: 0,
      } as IncomeYear);
    row.gross += c.totalIncome;
    row.net += c.netPay;
    row.bonus += c.bonus;
    row.taxes += c.totalTaxes;
    row.federalTax += c.federalTax;
    row.retirement401k += c.retirement401k;
    row.hsa += c.hsa;
    map.set(y, row);
  }
  return [...map.values()]
    .map((r) => ({
      ...r,
      gross: round2(r.gross),
      net: round2(r.net),
      bonus: round2(r.bonus),
      taxes: round2(r.taxes),
      federalTax: round2(r.federalTax),
      retirement401k: round2(r.retirement401k),
      hsa: round2(r.hsa),
      effectiveRate: r.gross ? round2((r.taxes / r.gross) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => a.year - b.year);
}

export type PlannerResult = {
  year: number;
  limit: number;
  ytd: number;
  remaining: number;
  remainingChecks: number;
  perCheck: number;
  pctOfSalary: number | null;
  lastCheckDate: string | null;
  currentSalary: number | null;
};

/**
 * The "401(k) + HSA Contributions" planner sheet, automated: YTD comes from
 * imported paychecks, remaining paydays are extrapolated on the observed
 * biweekly cadence, and the per-check amount needed to exactly hit the IRS
 * limit is derived.
 */
export function plannerFor(
  checks: (typeof paychecks.$inferSelect)[],
  limits: (typeof contributionLimits.$inferSelect)[],
  today: Date,
): PlannerResult | null {
  const year = today.getUTCFullYear();
  const limit = limits.find((l) => l.year === year && l.planType === "401k");
  if (!limit) return null;
  const thisYear = checks.filter((c) => c.paymentDate.startsWith(String(year)));
  const ytd = round2(thisYear.reduce((s, c) => s + c.retirement401k, 0));
  const last = checks[checks.length - 1] ?? null;
  const lastDate = last ? new Date(last.paymentDate + "T00:00:00Z") : null;

  let remainingChecks = 0;
  if (lastDate) {
    const d = new Date(lastDate);
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    while (d <= yearEnd) {
      d.setUTCDate(d.getUTCDate() + 14);
      if (d > today && d <= yearEnd) remainingChecks++;
    }
  }
  const remaining = round2(limit.amount - ytd);
  const perCheck = remainingChecks > 0 ? round2(remaining / remainingChecks) : 0;
  const salary = last?.annualSalary ?? null;
  return {
    year,
    limit: limit.amount,
    ytd,
    remaining,
    remainingChecks,
    perCheck,
    pctOfSalary: salary ? round2((perCheck / (salary / 26)) * 10000) / 10000 : null,
    lastCheckDate: last?.paymentDate ?? null,
    currentSalary: salary,
  };
}

export type SalaryPoint = { date: string; salary: number; employer: string };

export function salaryTimeline(
  checks: (typeof paychecks.$inferSelect)[],
  emps: (typeof employers.$inferSelect)[],
): SalaryPoint[] {
  const empName = new Map(emps.map((e) => [e.id, e.name]));
  const points: SalaryPoint[] = [];
  for (const c of checks) {
    if (!c.annualSalary) continue;
    const prev = points[points.length - 1];
    if (!prev || prev.salary !== c.annualSalary || prev.employer !== empName.get(c.employerId)) {
      points.push({
        date: c.paymentDate,
        salary: c.annualSalary,
        employer: empName.get(c.employerId) ?? "?",
      });
    }
  }
  return points;
}
