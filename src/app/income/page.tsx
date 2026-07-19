import {
  loadIncome,
  incomeByYear,
  plannerFor,
  salaryTimeline,
} from "@/lib/metrics";
import { dateLabel, money, pct } from "@/lib/format";
import { Card, PageHeader, StatTile } from "@/components/ui";
import { MonthlyBarChart, TimeSeriesChart } from "@/components/charts";
import { addPaycheck } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function IncomePage() {
  const { employers, paychecks, limits } = await loadIncome();
  const years = incomeByYear(paychecks);
  const salary = salaryTimeline(paychecks, employers);
  const planner = plannerFor(paychecks, limits, new Date());
  const current = years.at(-1);
  const lastCheck = paychecks.at(-1);
  const activeEmployer = employers.find((e) => e.isActive) ?? employers[0];

  const annualRows = years.map((y) => ({
    date: String(y.year),
    regular: Math.round((y.gross - y.bonus) * 100) / 100,
    bonus: y.bonus,
    net: y.net,
    taxes: y.taxes,
  }));
  const rateRows = years.map((y) => ({
    date: String(y.year),
    rate: y.effectiveRate,
  }));
  const salaryRows = salary.map((s) => ({ date: s.date, salary: s.salary }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Income"
        subtitle="Per-paycheck ledger across employers, with annual rollups"
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Current salary"
          value={
            planner?.currentSalary ? money(planner.currentSalary) : "–"
          }
          sub={activeEmployer?.name}
        />
        <StatTile
          label={`${current?.year ?? ""} gross`}
          value={current ? money(current.gross) : "–"}
          sub={current?.bonus ? `incl. ${money(current.bonus)} bonus` : undefined}
        />
        <StatTile
          label={`${current?.year ?? ""} net`}
          value={current ? money(current.net) : "–"}
        />
        <StatTile
          label={`${current?.year ?? ""} eff. tax rate`}
          value={current ? pct(current.effectiveRate) : "–"}
          sub="all taxes ÷ gross"
        />
        <StatTile
          label="Last paycheck"
          value={lastCheck ? money(lastCheck.netPay) : "–"}
          sub={lastCheck ? dateLabel(lastCheck.paymentDate) : undefined}
        />
      </div>

      {planner && (
        <Card
          title={`401(k) planner — ${planner.year}`}
          subtitle="Automated from imported paychecks: what to set per check to exactly hit the IRS limit"
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile label="IRS limit" value={money(planner.limit)} />
            <StatTile
              label="YTD contributed"
              value={money(planner.ytd)}
              sub={pct(planner.ytd / planner.limit)}
            />
            <StatTile label="Remaining" value={money(planner.remaining)} />
            <StatTile
              label="Paychecks left"
              value={String(planner.remainingChecks)}
              sub="biweekly cadence"
            />
            <StatTile
              label="Needed per check"
              value={money(planner.perCheck, true)}
              sub={
                planner.pctOfSalary != null
                  ? `≈ ${pct(planner.pctOfSalary)} of salary`
                  : undefined
              }
            />
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent"
              style={{
                width: `${Math.min(100, (planner.ytd / planner.limit) * 100)}%`,
              }}
            />
          </div>
        </Card>
      )}

      <Card title="Annual salary" subtitle="From pay stubs; steps mark raises and employer changes">
        <TimeSeriesChart
          data={salaryRows}
          series={[{ key: "salary", name: "Annual salary", color: "var(--series-1)" }]}
          height={260}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Annual gross income" subtitle="Regular pay and bonus">
          <MonthlyBarChart
            data={annualRows}
            stacked
            series={[
              { key: "regular", name: "Regular", color: "var(--series-1)" },
              { key: "bonus", name: "Bonus", color: "var(--series-3)" },
            ]}
          />
        </Card>
        <Card title="Effective tax rate" subtitle="All withheld taxes ÷ gross, by year">
          <TimeSeriesChart
            data={rateRows}
            series={[{ key: "rate", name: "Effective rate", color: "var(--series-6)" }]}
            isPercent
            height={260}
          />
        </Card>
      </div>

      <Card
        title="Add paycheck"
        subtitle="Quick entry — totals only; full line items live in the stub"
      >
        <form
          action={addPaycheck}
          className="grid grid-cols-2 gap-3 text-xs text-ink-2 sm:grid-cols-4"
        >
          <label className="block">
            Employer
            <select
              name="employerId"
              defaultValue={activeEmployer?.id}
              className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
            >
              {employers.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {[
            ["paymentDate", "Payment date", "date"],
            ["annualSalary", "Annual salary", "text"],
            ["totalIncome", "Gross pay", "text"],
            ["netPay", "Net pay", "text"],
            ["federalTax", "Federal tax", "text"],
            ["totalTaxes", "Total taxes", "text"],
            ["retirement401k", "401(k)", "text"],
            ["hsa", "HSA", "text"],
            ["bonus", "Bonus", "text"],
          ].map(([name, label, type]) => (
            <label key={name} className="block">
              {label}
              <input
                type={type}
                inputMode={type === "text" ? "decimal" : undefined}
                name={name}
                required={name === "paymentDate" || name === "totalIncome" || name === "netPay"}
                placeholder={type === "text" ? "0" : undefined}
                className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm tabular-nums text-ink"
              />
            </label>
          ))}
          <div className="col-span-2 flex items-end sm:col-span-4">
            <button className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">
              Save paycheck
            </button>
          </div>
        </form>
      </Card>

      <Card title="Recent paychecks" subtitle="Most recent first">
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-ink-3">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Date</th>
                <th className="py-1.5 pr-2 font-medium">Employer</th>
                <th className="py-1.5 pr-2 text-right font-medium">Gross</th>
                <th className="py-1.5 pr-2 text-right font-medium">401(k)</th>
                <th className="py-1.5 pr-2 text-right font-medium">Taxes</th>
                <th className="py-1.5 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {[...paychecks].reverse().slice(0, 40).map((c) => (
                <tr key={c.id} className="border-t border-edge">
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    {dateLabel(c.paymentDate)}
                  </td>
                  <td className="py-1.5 pr-2 text-ink-2">
                    {employers.find((e) => e.id === c.employerId)?.name}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {money(c.totalIncome, true)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {money(c.retirement401k, true)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {money(c.totalTaxes, true)}
                  </td>
                  <td className="py-1.5 text-right font-medium tabular-nums">
                    {money(c.netPay, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
