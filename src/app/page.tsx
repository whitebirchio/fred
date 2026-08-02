import Link from "next/link";
import {
  loadAccounts,
  loadHouse,
  houseMonthly,
  portfolioSeries,
  annualOverlays,
} from "@/lib/metrics";
import {
  isExcluded,
  loadHousehold,
  needsAttention,
  rollup,
  weightFor,
} from "@/lib/household";
import { loadAccountHistories } from "@/lib/series";
import { getScope, scopeLabel } from "@/lib/scope";
import { CATEGORY_META, CATEGORY_ORDER } from "@/lib/categories";
import { money, moneyDelta, monthLabel, pct } from "@/lib/format";
import { Card, PageHeader, StatTile } from "@/components/ui";
import { AllocationDonut, TimeSeriesChart } from "@/components/charts";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const scope = await getScope();
  const [accts, house, hh] = await Promise.all([
    loadAccounts(),
    loadHouse(),
    loadHousehold(),
  ]);
  const houseMonths = house ? houseMonthly(house) : [];
  // Resolved month-end balances for every account, so the chart covers the
  // same accounts the headline does — including the ones Fred has no close for.
  const histories = await loadAccountHistories(
    accts.map((a) => a.id),
    hh.asOf,
    new Map(
      hh.accounts
        .filter((a) => a.balance.value != null)
        .map((a) => [a.id, a.isActive ? a.balance.value! : 0]),
    ),
  );
  const series = portfolioSeries(
    accts,
    houseMonths,
    scope,
    hh.primaryPersonId,
    histories,
  );
  const { months, byCategory } = series;

  // The headline is today's resolved balance, from the same rollup /household
  // renders — not the tail of the month-end series, which lags by however
  // long it has been since the last close.
  const totals = rollup(hh.accounts, scope, hh.primaryPersonId);
  const attention = needsAttention(hh.accounts);

  if (months.length === 0) {
    return <p className="text-ink-2">No data yet — run the seed importer.</p>;
  }

  const latest = months[months.length - 1];
  const prevMonth = months[months.length - 2];
  const yearStart = months.filter((m) => m.date < `${latest.date.slice(0, 4)}-01-01`).at(-1);
  // The month household coverage becomes complete — before it, the total is
  // real but only covers the accounts Fred knew about then.
  const coverageFrom = months.find((m) => m.fullCoverage)?.date ?? null;
  const partialMonths = months.filter((m) => !m.fullCoverage).length;
  const overlays = annualOverlays(months);
  const curYear = Number(latest.date.slice(0, 4));
  const ytdRow = (o: (typeof overlays)["savings"]) => {
    const vals = o.rows
      .map((r) => r[String(curYear)])
      .filter((v): v is number => typeof v === "number");
    return vals.length ? vals[vals.length - 1] : null;
  };
  const ytdSavings = ytdRow(overlays.savings);
  const ytdRate = ytdRow(overlays.savingsRate);
  const lastHouse = houseMonths.at(-1);

  const catSeries = CATEGORY_ORDER.filter((c) =>
    byCategory.some((row) => (row[c] as number) > 0),
  ).map((c) => ({ key: c, name: CATEGORY_META[c].name, color: CATEGORY_META[c].color }));

  // Balances shown here are the live resolved ones, so a row can't disagree
  // with the same account on /household.
  const accountRows = hh.accounts
    .filter((a) => {
      if (isExcluded(a, scope)) return false;
      if (weightFor(a, scope, hh.primaryPersonId) === 0) return false;
      return a.isActive || Math.abs(a.signedBalance) > 0.5;
    })
    .map((a) => ({
      account: a,
      value: a.signedBalance * weightFor(a, scope, hh.primaryPersonId),
    }))
    .sort((x, y) => Math.abs(y.value) - Math.abs(x.value));

  const label = scopeLabel(scope, hh.people);
  const homeExcluded = totals.excluded.find((e) => e.reason === "primary_residence");
  // Distinct from "not excluded": a household with no property account at all
  // shouldn't be told its home equity is included.
  const hasHome = hh.accounts.some((a) => a.exclusion === "primary_residence");


  // "Current allocation" means current: built from the same live balances as
  // the table beside it, not from the last month-end row of the series.
  const byCategoryNow = new Map<string, number>();
  for (const { account, value } of accountRows) {
    if (value <= 0) continue; // a donut can only show positive slices
    byCategoryNow.set(
      account.category,
      (byCategoryNow.get(account.category) ?? 0) + value,
    );
  }
  const allocation = CATEGORY_ORDER.filter((c) => (byCategoryNow.get(c) ?? 0) > 0.5)
    .map((c) => ({
      name: CATEGORY_META[c].name,
      color: CATEGORY_META[c].color,
      value: byCategoryNow.get(c)!,
    }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Overview"
        subtitle={`${label} net worth · balances as of today · history through ${monthLabel(latest.date)}`}
      />

      {/* The series now covers the same accounts as the headline, so the two
          share a basis and differencing them is meaningful again. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Net worth"
          value={money(totals.net)}
          delta={prevMonth ? moneyDelta(latest.balance - prevMonth.balance) : undefined}
          deltaGood={prevMonth ? latest.balance >= prevMonth.balance : undefined}
          sub={`${totals.counted} accounts · vs last month`}
        />
        <StatTile label="Assets" value={money(totals.assets)} />
        <StatTile
          label="Liabilities"
          value={totals.liabilities ? `−${money(totals.liabilities)}` : "$0"}
          deltaGood={totals.liabilities ? false : undefined}
        />
        <StatTile
          label="YTD change"
          value={yearStart ? moneyDelta(latest.balance - yearStart.balance) : "–"}
          deltaGood={yearStart ? latest.balance >= yearStart.balance : undefined}
        />
        <StatTile
          label="YTD savings"
          value={ytdSavings != null ? money(ytdSavings) : "–"}
          sub="contributions − withdrawals"
        />
        <StatTile
          label="YTD savings rate"
          value={ytdRate != null ? pct(ytdRate) : "–"}
          sub="of contributions kept"
        />
      </div>

      {/* Say what a total leaves out, rather than quietly dropping it. */}
      {homeExcluded && lastHouse && (
        <Card>
          <p className="text-xs text-ink-2">
            Home equity of {money(lastHouse.equity)} ({money(lastHouse.marketValue)}{" "}
            market less {money(lastHouse.loanBalance)} owed) is{" "}
            <span className="text-ink">not counted</span> above — you always need
            somewhere to live. Use the Home equity toggle to include it.
          </p>
        </Card>
      )}

      {attention.length > 0 && (
        <Card
          title="Needs attention"
          subtitle="These balances are the last thing a source knew, not today's truth"
        >
          <ul className="space-y-1 text-sm">
            {attention.slice(0, 5).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3">
                <Link href={`/accounts/${a.slug}`} className="text-ink hover:underline">
                  {a.name}
                </Link>
                <span className="text-xs text-ink-3">
                  {a.staleness!.connectionStatus === "broken"
                    ? "connection broken"
                    : `${a.staleness!.days}d old`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Net worth over time"
        subtitle={`Month-end balances by category${hasHome && !homeExcluded ? ", home equity included" : ""} · through ${monthLabel(latest.date)}`}
      >
        <TimeSeriesChart data={byCategory} series={catSeries} stacked height={320} />
        {coverageFrom && partialMonths > 0 && (
          <p className="mt-3 text-xs text-ink-3">
            Every account in view is covered from{" "}
            <span className="text-ink-2">{monthLabel(coverageFrom)}</span>, when
            the last of them first reported a balance. The {partialMonths} earlier
            month{partialMonths === 1 ? "" : "s"} are real but partial — they show
            only the accounts Fred knew about at the time, which is why the line
            steps up there rather than because anything was earned.
          </p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Current allocation">
          <AllocationDonut data={allocation} />
        </Card>
        <Card title="Accounts" subtitle="Live balance and where it came from">
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-left text-xs text-ink-3">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Account</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Balance</th>
                  <th className="py-1.5 text-right font-medium">As of</th>
                </tr>
              </thead>
              <tbody>
                {accountRows.map(({ account, value }) => (
                  <tr key={account.id} className="border-t border-edge">
                    <td className="py-1.5 pr-2">
                      <Link
                        href={`/accounts/${account.slug}`}
                        className="flex items-center gap-2 text-ink hover:underline"
                      >
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: CATEGORY_META[account.category].color }}
                        />
                        {account.name}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(value)}
                    </td>
                    <td
                      className={`py-1.5 text-right text-xs ${account.staleness ? "text-bad" : "text-ink-3"}`}
                      title={account.balance.reason}
                    >
                      {account.balance.observedAt
                        ? monthLabel(account.balance.observedAt)
                        : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
