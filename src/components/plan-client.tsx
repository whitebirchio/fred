"use client";

import { useMemo, useState, useTransition } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltip } from "@/components/charts";
import { Card, StatTile } from "@/components/ui";
import { buildPlan, type PlanAssumptions } from "@/lib/plan";
import { compact, money, monthLabel, pct } from "@/lib/format";
import { savePlanAssumptions } from "@/app/actions";

const CONTROLS: {
  key: keyof PlanAssumptions;
  label: string;
  kind: "money" | "pct";
  min?: number;
  max?: number;
  step?: number;
}[] = [
  { key: "annualSpending", label: "Annual spending (today's $)", kind: "money" },
  { key: "monthlySavings", label: "Monthly savings", kind: "money" },
  { key: "swr", label: "Safe withdrawal rate", kind: "pct", min: 2.5, max: 6, step: 0.25 },
  { key: "expectedReal", label: "Expected real return", kind: "pct", min: 1, max: 9, step: 0.5 },
  { key: "conservativeReal", label: "Conservative return", kind: "pct", min: 0, max: 6, step: 0.5 },
  { key: "optimisticReal", label: "Optimistic return", kind: "pct", min: 3, max: 12, step: 0.5 },
  { key: "pretaxTaxRate", label: "Eff. tax on pre-tax withdrawals", kind: "pct", min: 0, max: 40, step: 1 },
];

export function PlanClient({
  history,
  initial,
}: {
  history: { date: string; actual: number }[];
  initial: PlanAssumptions;
}) {
  const [a, setA] = useState<PlanAssumptions>(initial);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const plan = useMemo(() => buildPlan(history, a), [history, a]);

  const set = (key: keyof PlanAssumptions, raw: number) =>
    setA((prev) => ({ ...prev, [key]: raw }));

  const fmtDate = (iso: string | null) => (iso ? monthLabel(iso) : "beyond 40y");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="FI target"
          value={money(plan.fiNumber)}
          sub={`spending ÷ ${pct(a.swr, 2)} SWR`}
        />
        <StatTile
          label="Spendable today"
          value={money(plan.spendableNow)}
          sub="after-tax, investable only"
        />
        <StatTile
          label="Progress"
          value={pct(Math.min(plan.progress, 9.99))}
          deltaGood={plan.progress >= 1 ? true : undefined}
        />
        <StatTile
          label="FI date (expected)"
          value={fmtDate(plan.fiDates.expected)}
          sub={`${fmtDate(plan.fiDates.optimistic)} – ${fmtDate(plan.fiDates.conservative)}`}
        />
        <StatTile
          label="Coast FI"
          value={fmtDate(plan.coastDate)}
          sub="stop saving today, expected return"
        />
      </div>

      <Card
        title="Projection"
        subtitle="Spendable (after-tax) investable assets, real dollars — history and three return scenarios"
      >
        <div className="mb-2 h-2 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${Math.min(100, plan.progress * 100)}%` }}
          />
        </div>
        <div style={{ height: 340 }} className="text-xs">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={plan.chart}
              margin={{ top: 8, right: 8, bottom: 0, left: 4 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                stroke="var(--border)"
                tickLine={false}
                tickFormatter={(v: string) => v.slice(0, 4)}
                minTickGap={40}
              />
              <YAxis
                stroke="var(--border)"
                tickLine={false}
                axisLine={false}
                tickFormatter={compact}
                width={56}
              />
              <Tooltip
                content={
                  <ChartTooltip format={(v) => money(v)} labelFormat={monthLabel} />
                }
              />
              <Legend iconType="circle" iconSize={8} />
              <ReferenceLine
                y={plan.fiNumber}
                stroke="var(--text-muted)"
                strokeDasharray="6 4"
                label={{
                  value: `FI ${compact(plan.fiNumber)}`,
                  position: "insideTopRight",
                  fill: "var(--text-secondary)",
                  fontSize: 11,
                }}
              />
              <Line
                dataKey="actual"
                name="Actual"
                stroke="var(--series-1)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="expected"
                name="Expected"
                stroke="var(--series-2)"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="conservative"
                name="Conservative"
                stroke="var(--series-3)"
                strokeWidth={1.5}
                strokeDasharray="3 4"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="optimistic"
                name="Optimistic"
                stroke="var(--series-5)"
                strokeWidth={1.5}
                strokeDasharray="3 4"
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card
        title="Assumptions"
        subtitle="Every input drives the projection live; save to keep as defaults"
      >
        <form
          action={(fd) => {
            startTransition(async () => {
              await savePlanAssumptions(fd);
              setSaved(true);
              setTimeout(() => setSaved(false), 2500);
            });
          }}
          className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3 lg:grid-cols-4"
        >
          {CONTROLS.map((c) => {
            const value = a[c.key];
            return (
              <label key={c.key} className="block text-xs text-ink-2">
                {c.label}
                {c.kind === "money" ? (
                  <input
                    inputMode="numeric"
                    name={c.key}
                    value={Math.round(value)}
                    onChange={(e) => set(c.key, Number(e.target.value) || 0)}
                    className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm tabular-nums text-ink"
                  />
                ) : (
                  <span className="mt-1 flex items-center gap-2">
                    <input
                      type="range"
                      min={c.min}
                      max={c.max}
                      step={c.step}
                      value={value * 100}
                      onChange={(e) => set(c.key, Number(e.target.value) / 100)}
                      className="w-full accent-(--accent)"
                    />
                    <span className="w-12 text-right text-sm tabular-nums text-ink">
                      {pct(value, c.step && c.step < 1 ? 2 : 0)}
                    </span>
                    <input type="hidden" name={c.key} value={value} />
                  </span>
                )}
              </label>
            );
          })}
          <div className="col-span-2 flex items-end gap-3 sm:col-span-3 lg:col-span-1">
            <button
              disabled={pending}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save as defaults"}
            </button>
            {saved && <span className="text-xs text-good">Saved ✓</span>}
          </div>
        </form>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          Returns are real (inflation-adjusted), so targets stay in
          today&apos;s dollars. FI assets exclude house equity (it
          doesn&apos;t produce spendable income). Spendable applies the effective-tax haircut to pre-tax
          dollars only; capital-gains tax on the taxable account is not modeled
          (basis untracked). New savings are credited 1:1 to spendable assets —
          a slight overstatement for the pre-tax share of contributions.
        </p>
      </Card>
    </div>
  );
}
