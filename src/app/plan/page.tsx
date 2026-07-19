import { eq } from "drizzle-orm";
import Link from "next/link";
import { db, appConfig } from "@/db";
import {
  loadAccounts,
  loadHouse,
  houseMonthly,
  portfolioSeries,
} from "@/lib/metrics";
import { taxLotSeries, TAX_BUCKETS, BUCKET_META } from "@/lib/taxlots";
import {
  defaultAssumptions,
  spendableHistory,
  type PlanAssumptions,
} from "@/lib/plan";
import { money, monthLabel, pct } from "@/lib/format";
import { Card, PageHeader } from "@/components/ui";
import { AllocationDonut, TimeSeriesChart } from "@/components/charts";
import { PlanClient } from "@/components/plan-client";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const [accts, house, savedRows] = await Promise.all([
    loadAccounts(),
    loadHouse(),
    db.select().from(appConfig).where(eq(appConfig.key, "plan")),
  ]);
  const houseMonths = house ? houseMonthly(house) : [];
  const { months } = portfolioSeries(accts, houseMonths);
  const lots = taxLotSeries(accts);
  if (months.length === 0 || lots.series.length === 0) {
    return <p className="text-ink-2">No data yet.</p>;
  }

  const defaults = defaultAssumptions(months);
  const saved = (savedRows[0]?.value ?? null) as Partial<PlanAssumptions> | null;
  const assumptions: PlanAssumptions = { ...defaults, ...saved };

  const history = spendableHistory(lots.series, assumptions.pretaxTaxRate);

  const investable = TAX_BUCKETS.reduce((s, b) => s + lots.current[b], 0);
  const donut = TAX_BUCKETS.map((b) => ({
    name: BUCKET_META[b].name,
    color: BUCKET_META[b].color,
    value: lots.current[b],
  })).filter((d) => d.value > 0.5);

  const bucketSeriesDef = TAX_BUCKETS.map((b) => ({
    key: b,
    name: BUCKET_META[b].name,
    color: BUCKET_META[b].color,
  })).filter((s) => lots.series.some((p) => (p[s.key as keyof typeof p] as number) > 0.5));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Plan"
        subtitle="Financial independence projection on tax-aware, spendable dollars"
      />

      <PlanClient history={history} initial={assumptions} />

      <PageHeader
        title="Tax buckets"
        subtitle={`Where investable dollars sit by tax treatment · ${money(investable)} total (house equity excluded)`}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Current mix">
          <AllocationDonut data={donut} />
          <ul className="mt-4 space-y-1.5 text-xs text-ink-3">
            {TAX_BUCKETS.filter((b) => lots.current[b] > 0.5).map((b) => (
              <li key={b}>
                <span className="font-medium text-ink-2">{BUCKET_META[b].name}:</span>{" "}
                {BUCKET_META[b].note}
              </li>
            ))}
          </ul>
        </Card>

        <Card
          title="By account"
          subtitle="401(k) lineage split via monthly tax-lot simulation, tied to statements"
        >
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Account</th>
                <th className="py-1.5 pr-2 text-right font-medium">Balance</th>
                <th className="py-1.5 text-right font-medium">Buckets</th>
              </tr>
            </thead>
            <tbody>
              {lots.units.map((u) => (
                <tr key={u.name} className="border-t border-edge align-top">
                  <td className="py-2 pr-2">
                    {u.slugs.length === 1 ? (
                      <Link
                        href={`/accounts/${u.slugs[0]}`}
                        className="text-ink hover:underline"
                      >
                        {u.name}
                      </Link>
                    ) : (
                      <span className="text-ink">{u.name}</span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {money(u.balance)}
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {TAX_BUCKETS.filter((b) => u.buckets[b] > 0.5).map((b) => (
                        <span
                          key={b}
                          className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] tabular-nums text-ink-2"
                        >
                          <span
                            className="inline-block h-1.5 w-1.5 rounded-full"
                            style={{ background: BUCKET_META[b].color }}
                          />
                          {money(u.buckets[b])}
                          {u.mixed && ` (${pct(u.buckets[b] / u.balance)})`}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {lots.drift.length > 0 && (
            <p className="mt-3 text-xs text-ink-3">
              Reconciliation: simulated lineage totals were scaled to actual
              statement balances; unexplained residual{" "}
              {lots.drift
                .map((d) => `${d.name}: ${money(d.amount, true)}`)
                .join("; ")}{" "}
              (likely a small external transfer) allocated proportionally.
            </p>
          )}
        </Card>
      </div>

      <Card
        title="Buckets over time"
        subtitle={`Monthly since ${monthLabel(lots.series[0].date)} — watch the Roth and HSA layers compound`}
      >
        <TimeSeriesChart
          data={lots.series}
          series={bucketSeriesDef}
          stacked
          height={320}
        />
      </Card>
    </div>
  );
}
