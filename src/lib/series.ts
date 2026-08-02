import { desc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accountEntries, balanceSnapshots, externalAccounts } from "@/db/schema";
import { monthEnd } from "./format";
import type { Entry } from "./metrics";

// ---------------------------------------------------------------------------
// Month-end resolution — the historical counterpart to resolve().
//
// resolve() answers "what is this account worth *now*" by choosing between
// sources. Until this existed, the month-end series never asked that question:
// it read account_entries directly, so an account with no monthly close simply
// did not exist in any chart, and the headline (which did resolve) disagreed
// with every visualization beneath it.
//
// Here the same idea runs per account per month. The priority is the reverse
// of the live one, deliberately:
//
//   live_balance   monarch -> fred   freshness wins; a close is month-end
//   month-end      fred -> monarch   the close wins for a month it covers,
//                                    because it carries the flow breakdown a
//                                    provider balance cannot
//
// What a provider balance cannot supply is *why* it changed. Those months
// report their movement as `unknown` rather than inventing a split between
// contributions and growth.
// ---------------------------------------------------------------------------

export type BalanceOrigin = "close" | "provider";

export type MonthPointForAccount = {
  /** Month-end ISO date. */
  date: string;
  balance: number;
  origin: BalanceOrigin;
  /** The close entry behind this point, when origin is "close". */
  entry?: Entry;
};

export type AccountHistory = {
  accountId: number;
  /** Ascending by month. */
  points: MonthPointForAccount[];
  /** First month any source knows about this account. */
  firstMonth: string | null;
};

/** How stale a provider snapshot may be and still stand in for a month-end.
 *  A feed that died in March shouldn't keep asserting a balance in December;
 *  beyond this the account simply has no point for that month. */
const SNAPSHOT_CARRY_DAYS = 45;

const dayDiff = (a: string, b: string) =>
  Math.round(
    (Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000,
  );

/** Every month-end from `from` to `to`, inclusive. */
export function monthEndsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ly, lm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  while (y < ly || (y === ly && m <= lm)) {
    out.push(monthEnd(y, m));
    if (m === 12) {
      y++;
      m = 1;
    } else m++;
  }
  return out;
}

/**
 * Load every account's month-end balance history, resolved across sources.
 *
 * `asOf` extends the series through the current, partial month using the most
 * recent evidence available — which is what makes the last point of the chart
 * equal to the net-worth headline instead of trailing it by however long it
 * has been since the last close.
 */
export async function loadAccountHistories(
  accountIds: number[],
  asOf: string,
  /**
   * Today's resolved balance per account, from loadHousehold(). Supplying it
   * makes the final point of the series *be* the net-worth headline rather
   * than an independent re-derivation that lands near it: the headline applies
   * source priority and distrusts broken feeds, and re-reading raw snapshots
   * here would quietly disagree with all of that. Without it the current month
   * falls back to snapshots, which is fine for callers that only want history.
   */
  liveBalances: Map<number, number> = new Map(),
): Promise<Map<number, AccountHistory>> {
  const result = new Map<number, AccountHistory>();
  if (accountIds.length === 0) return result;

  const [entries, externals] = await Promise.all([
    db
      .select()
      .from(accountEntries)
      .where(inArray(accountEntries.accountId, accountIds))
      .orderBy(accountEntries.statementDate),
    db.select().from(externalAccounts),
  ]);

  // Provider rows that count as evidence, grouped by the account they describe.
  const extByAccount = new Map<number, number[]>();
  for (const x of externals) {
    if (!x.linkedAccountId) continue;
    if (x.matchStatus !== "auto" && x.matchStatus !== "confirmed") continue;
    if (!accountIds.includes(x.linkedAccountId)) continue;
    const list = extByAccount.get(x.linkedAccountId) ?? [];
    list.push(x.id);
    extByAccount.set(x.linkedAccountId, list);
  }

  const extIds = [...new Set([...extByAccount.values()].flat())];
  const snapshots = extIds.length
    ? await db
        .select()
        .from(balanceSnapshots)
        .where(inArray(balanceSnapshots.externalAccountId, extIds))
        .orderBy(desc(balanceSnapshots.date))
    : [];

  const snapsByExt = new Map<number, { date: string; balance: number }[]>();
  for (const s of snapshots) {
    const list = snapsByExt.get(s.externalAccountId) ?? [];
    list.push({ date: s.date, balance: s.balance });
    snapsByExt.set(s.externalAccountId, list);
  }

  const entriesByAccount = new Map<number, Entry[]>();
  for (const e of entries) {
    const list = entriesByAccount.get(e.accountId) ?? [];
    list.push(e);
    entriesByAccount.set(e.accountId, list);
  }

  for (const accountId of accountIds) {
    const accEntries = entriesByAccount.get(accountId) ?? [];
    const extList = extByAccount.get(accountId) ?? [];

    // A provider "balance" for one account may be several rows summed (an HSA
    // split into cash and investments, say), so a month is only covered when
    // every part has a usable point — otherwise the total would silently drop
    // a component and read as a withdrawal.
    const providerAt = (target: string): number | null => {
      if (extList.length === 0) return null;
      let total = 0;
      for (const extId of extList) {
        const list = snapsByExt.get(extId) ?? []; // newest first
        const hit = list.find((s) => s.date <= target);
        if (!hit) return null;
        if (dayDiff(target, hit.date) > SNAPSHOT_CARRY_DAYS) return null;
        total += hit.balance;
      }
      return Math.round(total * 100) / 100;
    };

    // Span: from the earliest thing any source knows, to asOf.
    const firstEntry = accEntries[0]?.statementDate ?? null;
    let firstSnapshot: string | null = null;
    for (const extId of extList) {
      const list = snapsByExt.get(extId) ?? [];
      const earliest = list[list.length - 1]?.date ?? null;
      if (earliest && (!firstSnapshot || earliest < firstSnapshot)) {
        firstSnapshot = earliest;
      }
    }
    const start =
      firstEntry && firstSnapshot
        ? firstEntry < firstSnapshot
          ? firstEntry
          : firstSnapshot
        : (firstEntry ?? firstSnapshot);

    if (!start) {
      result.set(accountId, { accountId, points: [], firstMonth: null });
      continue;
    }

    const entryByMonth = new Map(accEntries.map((e) => [e.statementDate.slice(0, 7), e]));
    const points: MonthPointForAccount[] = [];

    const currentMonth = asOf.slice(0, 7);

    for (const me of monthEndsBetween(start, asOf)) {
      const ym = me.slice(0, 7);
      const entry = entryByMonth.get(ym);
      if (entry) {
        points.push({ date: me, balance: entry.balance, origin: "close", entry });
        continue;
      }
      // The month still in progress takes the headline's own answer, so the
      // chart's last point and the net-worth figure are the same number by
      // construction rather than by coincidence.
      if (ym === currentMonth && liveBalances.has(accountId)) {
        points.push({
          date: me,
          balance: liveBalances.get(accountId)!,
          origin: "provider",
        });
        continue;
      }
      // The current month is still running, so its "month-end" is today.
      const target = me > asOf ? asOf : me;
      const provider = providerAt(target);
      if (provider !== null) {
        points.push({ date: me, balance: provider, origin: "provider" });
        continue;
      }
      // Neither source covers this month. Carry the last known balance rather
      // than punching a hole in the middle of a series — the sheets' original
      // VLOOKUP(...,TRUE) behaviour, and still the right answer for a gap
      // between two known points.
      const prev = points[points.length - 1];
      if (prev) points.push({ date: me, balance: prev.balance, origin: prev.origin });
    }

    result.set(accountId, {
      accountId,
      points,
      firstMonth: points[0]?.date.slice(0, 7) ?? null,
    });
  }

  return result;
}
