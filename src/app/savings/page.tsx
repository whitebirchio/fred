import {
  loadAccounts,
  loadHouse,
  houseMonthly,
  portfolioSeries,
  annualOverlays,
} from "@/lib/metrics";
import { Card, PageHeader } from "@/components/ui";
import {
  MonthlyBarChart,
  TimeSeriesChart,
  YearOverlayChart,
} from "@/components/charts";

export const dynamic = "force-dynamic";

export default async function SavingsPage() {
  const [accts, house] = await Promise.all([loadAccounts(), loadHouse()]);
  const houseMonths = house ? houseMonthly(house) : [];
  const { months } = portfolioSeries(accts, houseMonths);
  if (months.length === 0) return <p className="text-ink-2">No data yet.</p>;

  // cumulative series (the workbook's Balance/Contributions/Growth/Savings tabs)
  const cumulative: {
    date: string;
    balance: number;
    contributions: number;
    growth: number;
    withdrawals: number;
    savings: number;
  }[] = [];
  {
    let cc = 0,
      cg = 0,
      cw = 0;
    for (const m of months) {
      cc += m.contributions;
      cg += m.growth;
      cw += m.withdrawals;
      cumulative.push({
        date: m.date,
        balance: m.balance,
        contributions: Math.round(cc * 100) / 100,
        growth: Math.round(cg * 100) / 100,
        withdrawals: Math.round(cw * 100) / 100,
        savings: Math.round((cc - cw) * 100) / 100,
      });
    }
  }

  const monthly = months.map((m) => ({ date: m.date, savings: m.savings }));
  const overlays = annualOverlays(months);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Savings & growth"
        subtitle="Savings = contributions − withdrawals; growth = market change. Transfers between accounts are excluded."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Savings vs growth"
          subtitle="Cumulative: what you saved vs what the market added"
        >
          <TimeSeriesChart
            data={cumulative}
            series={[
              { key: "savings", name: "Savings", color: "var(--series-1)" },
              { key: "growth", name: "Growth", color: "var(--series-2)" },
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
            ]}
          />
        </Card>
      </div>

      <Card title="Monthly savings" subtitle="Contributions − withdrawals, by month">
        <MonthlyBarChart
          data={monthly}
          series={[{ key: "savings", name: "Savings", color: "var(--series-1)" }]}
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
