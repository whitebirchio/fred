import { eq } from "drizzle-orm";
import Link from "next/link";
import { db, appConfig } from "@/db";
import {
  loadAccounts,
  loadHouse,
  houseMonthly,
  portfolioSeries,
} from "@/lib/metrics";
import {
  taxLotSeries,
  bucketBalanceOnly,
  TAX_BUCKETS,
  BUCKET_META,
} from "@/lib/taxlots";
import { loadHousehold } from "@/lib/household";
import { loadAccountHistories } from "@/lib/series";
import { getScope } from "@/lib/scope";
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
  const scope = await getScope();
  const [accts, house, hh, savedRows] = await Promise.all([
    loadAccounts(),
    loadHouse(),
    loadHousehold(),
    db.select().from(appConfig).where(eq(appConfig.key, "plan")),
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
  const lots = taxLotSeries(accts, scope, hh.primaryPersonId);

  // Accounts with no close history can't be simulated into tax lots, but their
  // dollars are real and belong in the mix — classified by account type, and
  // reported separately so a weaker classification never masquerades as a
  // simulated one.
  const closeTracked = new Set(
    accts.filter((a) => a.entries.length > 0).map((a) => a.id),
  );
  const balanceOnly = bucketBalanceOnly(
    hh.accounts,
    scope,
    hh.primaryPersonId,
    (id) => closeTracked.has(id),
  );
  const combined = Object.fromEntries(
    TAX_BUCKETS.map((b) => [b, lots.current[b] + balanceOnly.buckets[b]]),
  ) as typeof lots.current;

  // The projection needs flow history; the bucket mix only needs balances. A
  // scope with no close-tracked accounts (Kate's, say) can still answer "where
  // do these dollars sit", so show that rather than an empty page.
  const canProject = months.length > 0 && lots.series.length > 0;
  if (!canProject && balanceOnly.total === 0) {
    return <p className="text-ink-2">No data yet.</p>;
  }

  const defaults = canProject ? defaultAssumptions(months) : null;
  const saved = (savedRows[0]?.value ?? null) as Partial<PlanAssumptions> | null;
  const assumptions = defaults
    ? ({ ...defaults, ...saved } as PlanAssumptions)
    : null;

  const history =
    canProject && assumptions
      ? spendableHistory(lots.series, assumptions.pretaxTaxRate)
      : [];

  const investable = TAX_BUCKETS.reduce((s, b) => s + combined[b], 0);
  const donut = TAX_BUCKETS.map((b) => ({
    name: BUCKET_META[b].name,
    color: BUCKET_META[b].color,
    value: combined[b],
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

      {assumptions ? (
        <PlanClient history={history} initial={assumptions} />
      ) : (
        <Card>
          <p className="text-sm text-ink-2">
            No projection for this view — a forecast needs contribution and
            growth history, and nothing in scope is tracked through the monthly
            close. The tax-bucket mix below still reflects the real balances.
          </p>
        </Card>
      )}

      <PageHeader
        title="Tax buckets"
        subtitle={`Where investable dollars sit by tax treatment · ${money(investable)} total (home equity excluded)`}
      />

      {balanceOnly.total > 0 && (
        <Card>
          <p className="text-xs text-ink-2">
            <span className="text-ink">{money(balanceOnly.total)}</span> of the mix
            below comes from {balanceOnly.accounts.length} account
            {balanceOnly.accounts.length === 1 ? "" : "s"} with no monthly-close
            history, so their tax character is inferred from the account type
            rather than simulated from contributions.
            {canProject
              ? " The projection above and the per-account table below cover close-tracked accounts only."
              : ""}
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Current mix">
          <AllocationDonut data={donut} />
          <ul className="mt-4 space-y-1.5 text-xs text-ink-3">
            {TAX_BUCKETS.filter((b) => combined[b] > 0.5).map((b) => (
              <li key={b}>
                <span className="font-medium text-ink-2">{BUCKET_META[b].name}:</span>{" "}
                {BUCKET_META[b].note}
              </li>
            ))}
          </ul>
        </Card>

        <Card
          title="By account"
          subtitle={
            lots.units.length
              ? "401(k) lineage split via monthly tax-lot simulation, tied to statements"
              : "Balances classified by account type — no close history to simulate lots from"
          }
        >
          {lots.units.length === 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Account</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Balance</th>
                  <th className="py-1.5 text-right font-medium">Bucket</th>
                </tr>
              </thead>
              <tbody>
                {balanceOnly.accounts.map((a) => (
                  <tr key={a.name} className="border-t border-edge">
                    <td className="py-2 pr-2 text-ink">{a.name}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {money(a.value)}
                    </td>
                    <td className="py-2 text-right text-xs text-ink-2">
                      {BUCKET_META[a.bucket].name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <table className={`w-full text-sm ${lots.units.length ? "" : "hidden"}`}>
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

      {lots.series.length > 0 && (
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
      )}
    </div>
  );
}
