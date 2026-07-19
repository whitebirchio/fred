import Link from "next/link";
import {
  loadAccounts,
  loadHouse,
  houseMonthly,
  portfolioSeries,
  annualOverlays,
} from "@/lib/metrics";
import { CATEGORY_META, CATEGORY_ORDER } from "@/lib/categories";
import { money, moneyDelta, monthLabel, pct } from "@/lib/format";
import { Card, PageHeader, StatTile } from "@/components/ui";
import { AllocationDonut, TimeSeriesChart } from "@/components/charts";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [accts, house] = await Promise.all([loadAccounts(), loadHouse()]);
  const houseMonths = house ? houseMonthly(house) : [];
  const series = portfolioSeries(accts, houseMonths);
  const { months, byCategory } = series;
  if (months.length === 0) {
    return <p className="text-ink-2">No data yet — run the seed importer.</p>;
  }

  const latest = months[months.length - 1];
  const prev = months[months.length - 2];
  const yearStart = months.filter((m) => m.date < `${latest.date.slice(0, 4)}-01-01`).at(-1);
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

  const allocation = catSeries
    .map((c) => ({
      name: c.name,
      color: c.color,
      value: (byCategory[byCategory.length - 1][c.key] as number) ?? 0,
    }))
    .filter((d) => d.value > 0.5)
    .sort((a, b) => b.value - a.value);

  const accountRows = series.perAccount
    .filter((a) => a.current > 0.5 || a.account.isActive)
    .sort((a, b) => b.current - a.current);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Overview"
        subtitle={`Individual net worth · data through ${monthLabel(latest.date)}`}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Net worth"
          value={money(latest.balance)}
          delta={prev ? moneyDelta(latest.balance - prev.balance) : undefined}
          deltaGood={prev ? latest.balance >= prev.balance : undefined}
          sub="vs last month"
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
        <StatTile
          label="House equity (½)"
          value={lastHouse ? money(lastHouse.equityShare) : "–"}
          sub={lastHouse ? `market ${money(lastHouse.marketValue)}` : undefined}
        />
      </div>

      <Card
        title="Net worth over time"
        subtitle="Month-end balances by category, house as even-split equity"
      >
        <TimeSeriesChart data={byCategory} series={catSeries} stacked height={320} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Current allocation">
          <AllocationDonut data={allocation} />
        </Card>
        <Card title="Accounts" subtitle="Current balance and last statement">
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-left text-xs text-ink-3">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Account</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Balance</th>
                  <th className="py-1.5 text-right font-medium">Last entry</th>
                </tr>
              </thead>
              <tbody>
                {accountRows.map(({ account, current, lastEntry }) => (
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
                      {money(current)}
                    </td>
                    <td className="py-1.5 text-right text-xs text-ink-3">
                      {lastEntry ? monthLabel(lastEntry) : "–"}
                    </td>
                  </tr>
                ))}
                {lastHouse && (
                  <tr className="border-t border-edge">
                    <td className="py-1.5 pr-2">
                      <Link
                        href="/house"
                        className="flex items-center gap-2 text-ink hover:underline"
                      >
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: CATEGORY_META.property.color }}
                        />
                        House equity (even split)
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(lastHouse.equityShare)}
                    </td>
                    <td className="py-1.5 text-right text-xs text-ink-3">
                      {monthLabel(lastHouse.date)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
