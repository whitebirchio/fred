import {
  loadAccounts,
  loadHouse,
  houseMonthly,
  portfolioSeries,
  annualOverlays,
} from "@/lib/metrics";
import { loadHousehold } from "@/lib/household";
import { loadAccountHistories } from "@/lib/series";
import { monthLabel } from "@/lib/format";
import { getScope } from "@/lib/scope";
import { Card, PageHeader } from "@/components/ui";
import {
  MonthlyBarChart,
  TimeSeriesChart,
  YearOverlayChart,
} from "@/components/charts";

export const dynamic = "force-dynamic";

export default async function SavingsPage() {
  const scope = await getScope();
  const [accts, house, hh] = await Promise.all([
    loadAccounts(),
    loadHouse(),
    loadHousehold(),
  ]);
  const houseMonths = house ? houseMonthly(house) : [];
  const histories = await loadAccountHistories(
    accts.map((a) => a.id),
    hh.asOf,
    new Map(
      hh.accounts
        .filter((a) => a.balance.value != null)
        .map((a) => [a.id, a.isActive ? a.balance.value! : 0]),
    ),
  );
  const { months } = portfolioSeries(
    accts,
    houseMonths,
    scope,
    hh.primaryPersonId,
    histories,
  );
  if (months.length === 0) return <p className="text-ink-2">No data yet.</p>;

  // Every account now contributes a balance; what varies is whether we can
  // explain the movement. Months resolved from a provider land in `unknown`.
  const unknownTotal = months.reduce((s, m) => s + Math.abs(m.unknown), 0);
  const coverageFrom = months.find((m) => m.fullCoverage)?.date ?? null;

  // cumulative series: balance, contributions, growth, savings, unknown
  const cumulative: {
    date: string;
    balance: number;
    contributions: number;
    growth: number;
    withdrawals: number;
    savings: number;
    unknown: number;
  }[] = [];
  {
    let cc = 0,
      cg = 0,
      cw = 0,
      cu = 0;
    for (const m of months) {
      cc += m.contributions;
      cg += m.growth;
      cw += m.withdrawals;
      cu += m.unknown;
      cumulative.push({
        date: m.date,
        balance: m.balance,
        contributions: Math.round(cc * 100) / 100,
        growth: Math.round(cg * 100) / 100,
        withdrawals: Math.round(cw * 100) / 100,
        savings: Math.round((cc - cw) * 100) / 100,
        unknown: Math.round(cu * 100) / 100,
      });
    }
  }

  const monthly = months.map((m) => ({
    date: m.date,
    savings: m.savings,
    unknown: m.unknown,
  }));
  const overlays = annualOverlays(months);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Savings & growth"
        subtitle="Savings = contributions − withdrawals; growth = market change. Transfers between accounts are excluded."
      />

      {unknownTotal > 0.5 && (
        <Card>
          <p className="text-xs text-ink-2">
            Every account in view is charted below. Where a month&apos;s balance
            came from the monthly close, its movement is split into
            contributions, growth and withdrawals. Where it came from a synced
            source, all we know is that the balance moved — a provider reports
            what an account is worth, never why. That movement is charted as{" "}
            <span className="text-ink">Unknown</span> rather than guessed into
            savings or growth
            {coverageFrom
              ? `, and every account is represented from ${monthLabel(coverageFrom)} onward`
              : ""}
            . Closing a month replaces its Unknown with the real breakdown.
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Savings vs growth"
          subtitle="Cumulative: what you saved, what the market added, and what we can't attribute"
        >
          <TimeSeriesChart
            data={cumulative}
            series={[
              { key: "savings", name: "Savings", color: "var(--series-1)" },
              { key: "growth", name: "Growth", color: "var(--series-2)" },
              { key: "unknown", name: "Unknown", color: "var(--series-8)" },
            ]}
          />
        </Card>
        <Card
          title="Cumulative flows"
          subtitle="Contributions, withdrawals and net balance"
        >
          <TimeSeriesChart
            data={cumulative}
            series={[
              { key: "balance", name: "Balance", color: "var(--series-1)" },
              { key: "contributions", name: "Contributions", color: "var(--series-2)" },
              { key: "withdrawals", name: "Withdrawals", color: "var(--series-6)" },
              { key: "unknown", name: "Unknown", color: "var(--series-8)" },
            ]}
          />
        </Card>
      </div>

      <Card
        title="Monthly savings"
        subtitle="Contributions − withdrawals, by month, with unattributable movement alongside"
      >
        <MonthlyBarChart
          data={monthly}
          series={[
            { key: "savings", name: "Savings", color: "var(--series-1)" },
            { key: "unknown", name: "Unknown", color: "var(--series-8)" },
          ]}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Annual net balance change"
          subtitle="Year-to-date change in net worth, by month — one line per year"
        >
          <YearOverlayChart rows={overlays.netBalance.rows} years={overlays.netBalance.years} />
        </Card>
        <Card title="Annual contributions" subtitle="Year-to-date, by month">
          <YearOverlayChart
            rows={overlays.contributions.rows}
            years={overlays.contributions.years}
          />
        </Card>
        <Card title="Annual growth" subtitle="Year-to-date market growth, by month">
          <YearOverlayChart rows={overlays.growth.rows} years={overlays.growth.years} />
        </Card>
        <Card title="Annual savings" subtitle="Year-to-date, by month">
          <YearOverlayChart rows={overlays.savings.rows} years={overlays.savings.years} />
        </Card>
      </div>

      <Card
        title="Annual savings rate"
        subtitle="Year-to-date savings ÷ year-to-date contributions"
      >
        <YearOverlayChart
          rows={overlays.savingsRate.rows}
          years={overlays.savingsRate.years}
          isPercent
        />
      </Card>
    </div>
  );
}
