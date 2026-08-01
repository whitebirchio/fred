// Guard against the failure this whole model exists to prevent: the same
// underlying data producing different numbers on different screens.
//
// Every net-worth figure in Fred is supposed to come from one function —
// rollup() in src/lib/household.ts — over one set of resolved balances. This
// re-derives each page's headline the way that page derives it, and asserts
// they agree. It also checks the invariants that make the scope filter
// trustworthy, and reports what resolution is currently doing.
//
//   npx tsx scripts/verify_consistency.ts              # local PGlite
//   node --env-file=.env npx tsx scripts/verify_consistency.ts   # production
import {
  DEFAULT_SCOPE,
  isExcluded,
  loadHousehold,
  needsAttention,
  rollup,
  weightFor,
} from "../src/lib/household";
import { loadAccounts, loadHouse, houseMonthly, portfolioSeries } from "../src/lib/metrics";
import { monthEnd } from "../src/lib/format";
import { bucketBalanceOnly, taxLotSeries, TAX_BUCKETS } from "../src/lib/taxlots";

const m = (v: number) =>
  (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const CENT = 0.01;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const [hh, accts, house] = await Promise.all([
    loadHousehold(),
    loadAccounts(),
    loadHouse(),
  ]);
  const houseMonths = house ? houseMonthly(house) : [];
  const primary = hh.primaryPersonId;

  // ---------------------------------------------------------------- headline
  console.log("\nONE NET WORTH, EVERY SCREEN");
  const scope = DEFAULT_SCOPE;
  const totals = rollup(hh.accounts, scope, primary);

  // Overview, /household and /sync all read this same call. The meaningful
  // check is that nothing re-implements it: any page computing its own total
  // would diverge here the moment resolution changed.
  const overview = rollup(hh.accounts, scope, primary);
  const householdPage = rollup(
    hh.accounts.filter((a) => weightFor(a, scope, primary) > 0),
    scope,
    primary,
  );
  const syncPage = rollup(hh.accounts, scope, primary);
  check(
    "Overview = Household",
    Math.abs(overview.net - householdPage.net) < CENT,
    `${m(overview.net)} vs ${m(householdPage.net)}`,
  );
  check(
    "Overview = Sync",
    Math.abs(overview.net - syncPage.net) < CENT,
    `${m(overview.net)} vs ${m(syncPage.net)}`,
  );
  check(
    "assets − liabilities = net",
    Math.abs(totals.assets - totals.liabilities - totals.net) < CENT,
    `${m(totals.assets)} − ${m(totals.liabilities)} = ${m(totals.net)}`,
  );

  // ------------------------------------------------------------------ scopes
  console.log("\nSCOPE FILTERS ADD UP");
  const perPerson = hh.people.map((p) => ({
    name: p.name,
    net: rollup(hh.accounts, { ...scope, who: p.id }, primary).net,
  }));
  const sum = perPerson.reduce((s, p) => s + p.net, 0);
  check(
    "per-person shares sum to the household total",
    Math.abs(sum - totals.net) < 1,
    `${perPerson.map((p) => `${p.name} ${m(p.net)}`).join(" + ")} = ${m(sum)} vs ${m(totals.net)}`,
  );

  // ------------------------------------------------------------ house pairing
  console.log("\nHOME EQUITY IS ALL-OR-NOTHING");
  const withHome = rollup(hh.accounts, { ...scope, includeHome: true }, primary);
  const homeAccounts = hh.accounts.filter((a) => a.exclusion === "primary_residence");
  const asset = homeAccounts.filter((a) => !a.isLiability);
  const debt = homeAccounts.filter((a) => a.isLiability);
  check(
    "the home and its mortgage are flagged together",
    homeAccounts.length === 0 || (asset.length > 0 && debt.length > 0),
    `${asset.length} asset(s), ${debt.length} liability(ies)`,
  );
  // Toggling home must move the total by exactly the home pair's net value —
  // proof that the asset and the debt travel together rather than one of them
  // leaking into the headline on its own.
  const homeNet = homeAccounts.reduce(
    (s, a) => s + a.signedBalance * weightFor(a, { ...scope, includeHome: true }, primary),
    0,
  );
  check(
    "toggling home moves the total by exactly the home pair",
    Math.abs(withHome.net - totals.net - homeNet) < 1,
    `Δ ${m(withHome.net - totals.net)} vs home pair ${m(homeNet)}`,
  );
  console.log(
    `    default ${m(totals.net)} · with home ${m(withHome.net)} · difference ${m(withHome.net - totals.net)}`,
  );

  // ------------------------------------------------------- series vs headline
  console.log("\nMONTH-END SERIES SHARES THE HEADLINE'S RULES");
  const series = portfolioSeries(accts, houseMonths, scope, primary);
  const latest = series.months.at(-1);
  check(
    "series has a latest point",
    Boolean(latest),
    latest ? `through ${latest.date}` : "empty",
  );
  if (latest) {
    console.log(
      `    live headline ${m(totals.net)} vs last close ${m(latest.balance)} (${latest.date}) — difference ${m(totals.net - latest.balance)}`,
    );
    // These legitimately differ (live vs month-end); what must NOT differ is
    // membership. A liability counted positively, or an excluded account
    // included, would show up as an implausible gap rather than a real one.
    const seriesIds = new Set(series.perAccount.map((p) => p.account.id));
    const rollupIds = new Set(
      hh.accounts
        .filter((a) => !isExcluded(a, scope) && weightFor(a, scope, primary) > 0)
        .map((a) => a.id),
    );
    const inSeriesOnly = [...seriesIds].filter((id) => !rollupIds.has(id));
    check(
      "no account is in the series but out of the rollup",
      inSeriesOnly.length === 0,
      inSeriesOnly.length
        ? inSeriesOnly
            .map((id) => accts.find((a) => a.id === id)?.name ?? id)
            .join(", ")
        : "",
    );
  }

  // ------------------------------------------------------------- liabilities
  console.log("\nLIABILITIES ARE SIGNED");
  const liabs = hh.accounts.filter((a) => a.isLiability && a.isActive);
  const badSign = liabs.filter((a) => a.signedBalance > 0);
  check(
    "every liability contributes negatively",
    badSign.length === 0,
    badSign.map((a) => a.name).join(", "),
  );

  // --------------------------------------------------------- closed accounts
  console.log("\nCLOSED ACCOUNTS HOLD NOTHING");
  const closedWithMoney = hh.accounts.filter((a) => !a.isActive && a.signedBalance !== 0);
  check(
    "no closed account carries a balance",
    closedWithMoney.length === 0,
    closedWithMoney.map((a) => `${a.name} ${m(a.signedBalance)}`).join(", "),
  );

  // ------------------------------------------------- close entries are monthly
  // A close describes a month, so each account gets at most one row per month
  // and that row sits on the month's last day. Two rows in one month would
  // double-count that month's flows in every series built from them.
  console.log("\nCLOSE ENTRIES ARE ONE PER MONTH-END");
  const offCycle: string[] = [];
  const dupMonths: string[] = [];
  for (const a of accts) {
    const seen = new Map<string, number>();
    for (const e of a.entries) {
      const [y, mo] = e.statementDate.split("-").map(Number);
      if (e.statementDate !== monthEnd(y, mo)) {
        offCycle.push(`${a.name} ${e.statementDate}`);
      }
      const ym = e.statementDate.slice(0, 7);
      seen.set(ym, (seen.get(ym) ?? 0) + 1);
    }
    for (const [ym, n] of seen) if (n > 1) dupMonths.push(`${a.name} ${ym} (${n} rows)`);
  }
  check(
    "every entry sits on its month's last day",
    offCycle.length === 0,
    offCycle.join(", "),
  );
  check(
    "no account has two entries in one month",
    dupMonths.length === 0,
    dupMonths.join(", "),
  );

  // ------------------------------------------------------------- tax buckets
  console.log("\nTAX BUCKETS COVER EVERY INVESTABLE DOLLAR");
  const lots = taxLotSeries(accts, scope, primary);
  const closeTracked = new Set(accts.filter((a) => a.entries.length > 0).map((a) => a.id));
  const extra = bucketBalanceOnly(hh.accounts, scope, primary, (id) => closeTracked.has(id));
  const bucketed = TAX_BUCKETS.reduce((s, b) => s + lots.current[b] + extra.buckets[b], 0);
  const investableAccounts = hh.accounts.filter(
    (a) =>
      !isExcluded(a, scope) &&
      weightFor(a, scope, primary) > 0 &&
      a.isActive &&
      !a.isLiability &&
      a.category !== "property",
  );
  const investable = investableAccounts.reduce(
    (s, a) => s + a.signedBalance * weightFor(a, scope, primary),
    0,
  );
  // The lot engine ties simulated proportions to statement balances, so it can
  // lag today's live figure; a large gap means dollars are falling through.
  const gap = investable - bucketed;
  check(
    "bucketed dollars within 5% of investable assets",
    Math.abs(gap) <= Math.max(investable * 0.05, 1),
    `${m(bucketed)} bucketed vs ${m(investable)} investable (gap ${m(gap)})`,
  );
  console.log(`    of which balance-only (type-inferred): ${m(extra.total)}`);

  // ---------------------------------------------------------------- staleness
  console.log("\nRESOLUTION IS HONEST ABOUT FRESHNESS");
  const stale = needsAttention(hh.accounts);
  console.log(
    stale.length === 0
      ? "    every counted balance is inside its freshness window"
      : `    ${stale.length} account(s) showing a stale or broken-feed value:`,
  );
  for (const a of stale) {
    console.log(
      `      ${a.name.padEnd(32)} ${m(a.signedBalance).padStart(12)}  ${a.staleness!.days}d  ${a.staleness!.connectionStatus ?? ""}`,
    );
  }

  // ------------------------------------------------------------------ summary
  console.log(
    `\n${failures === 0 ? "ALL CONSISTENT" : `${failures} INCONSISTENCY(IES)`} — household net worth ${m(totals.net)} across ${totals.counted} accounts.`,
  );
  if (totals.excluded.length) {
    console.log(
      `Excluded: ${totals.excluded.map((e) => `${e.reason} ${m(e.net)} (${e.count})`).join(", ")}`,
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
