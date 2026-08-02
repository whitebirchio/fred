"use client";

import { ReactNode, useId } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  ComposedChart,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { compact, monthLabel, money, pct } from "@/lib/format";

export type SeriesDef = { key: string; name: string; color: string };

const AXIS = { stroke: "var(--border)", tickLine: false as const };

const moneyFmt = (v: number) => money(v);

function TooltipBox({
  label,
  rows,
}: {
  label: string;
  rows: { name: string; color?: string; value: string }[];
}) {
  return (
    <div className="rounded-lg border border-edge bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-ink">{label}</div>
      {rows.map((r) => (
        <div key={r.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-ink-2">
            {r.color && (
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: r.color }}
              />
            )}
            {r.name}
          </span>
          <span className="font-medium tabular-nums text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

type TooltipPayload = {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}[];

// Passed to recharts as `content={<ChartTooltip … />}`; recharts clones the
// element and injects active/payload/label at hover time.
export function ChartTooltip({
  active,
  payload,
  label,
  format,
  labelFormat,
}: {
  active?: boolean;
  payload?: TooltipPayload;
  label?: string | number;
  format: (v: number) => string;
  labelFormat?: (l: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <TooltipBox
      label={(labelFormat ?? ((l: string) => l))(String(label))}
      rows={payload
        .filter((p) => p.value != null)
        .map((p) => ({
          name: String(p.name ?? p.dataKey),
          color: p.color,
          value: format(Number(p.value)),
        }))}
    />
  );
}

/** Collapsible table view of the plotted data (accessibility fallback). */
export function DataTable({
  data,
  columns,
  format,
  labelKey,
}: {
  data: Record<string, unknown>[];
  columns: SeriesDef[];
  format: (v: number) => string;
  labelKey: string;
}) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink-2">
        View data table
      </summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-edge">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-2 text-left">
            <tr>
              <th className="px-2 py-1.5 font-medium text-ink-2">Date</th>
              {columns.map((c) => (
                <th key={c.key} className="px-2 py-1.5 text-right font-medium text-ink-2">
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...data].reverse().map((row, i) => (
              <tr key={i} className="border-t border-edge">
                <td className="px-2 py-1 text-ink-2">{String(row[labelKey])}</td>
                {columns.map((c) => (
                  <td key={c.key} className="px-2 py-1 text-right tabular-nums text-ink">
                    {row[c.key] == null ? "–" : format(Number(row[c.key]))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function TimeSeriesChart({
  data,
  series,
  height = 280,
  isPercent = false,
  stacked = false,
  withTable = true,
  overlay,
}: {
  data: Record<string, unknown>[];
  series: SeriesDef[];
  height?: number;
  isPercent?: boolean;
  stacked?: boolean;
  withTable?: boolean;
  /** A line drawn over a stacked chart — for a total the stack itself can't
   *  express, such as net worth once liabilities are in the mix. */
  overlay?: SeriesDef;
}) {
  const fmt = isPercent ? (v: number) => pct(v) : (v: number) => money(v);
  const axisFmt = isPercent ? (v: number) => pct(v, 0) : compact;
  const gradId = useId();

  const chart = stacked ? (
    <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="date"
        {...AXIS}
        tickFormatter={(v: string) => v.slice(0, 4)}
        minTickGap={40}
      />
      <YAxis {...AXIS} tickFormatter={axisFmt} width={52} axisLine={false} />
      <Tooltip content={<ChartTooltip format={fmt} labelFormat={monthLabel} />} />
      {series.length > 1 && <Legend iconType="circle" iconSize={8} />}
      {series.map((s) => (
        <Area
          key={s.key}
          dataKey={s.key}
          name={s.name}
          stackId="a"
          stroke={s.color}
          fill={s.color}
          fillOpacity={0.55}
          strokeWidth={1}
          isAnimationActive={false}
        />
      ))}
      {/* Drawn over the bands because a stack cannot show it: positives pile
          up from zero and negatives hang below, so the top of the colours is
          assets. This line is the total those bands actually sum to. */}
      {overlay && (
        <Line
          dataKey={overlay.key}
          name={overlay.name}
          stroke={overlay.color}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      )}
    </ComposedChart>
  ) : series.length === 1 ? (
    <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={series[0].color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={series[0].color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="date"
        {...AXIS}
        tickFormatter={(v: string) => v.slice(0, 4)}
        minTickGap={40}
      />
      <YAxis {...AXIS} tickFormatter={axisFmt} width={52} axisLine={false} />
      <Tooltip content={<ChartTooltip format={fmt} labelFormat={monthLabel} />} />
      <Area
        dataKey={series[0].key}
        name={series[0].name}
        stroke={series[0].color}
        strokeWidth={2}
        fill={`url(#${gradId})`}
        isAnimationActive={false}
      />
    </AreaChart>
  ) : (
    <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="date"
        {...AXIS}
        tickFormatter={(v: string) => v.slice(0, 4)}
        minTickGap={40}
      />
      <YAxis {...AXIS} tickFormatter={axisFmt} width={52} axisLine={false} />
      <Tooltip content={<ChartTooltip format={fmt} labelFormat={monthLabel} />} />
      <Legend iconType="circle" iconSize={8} />
      {series.map((s) => (
        <Line
          key={s.key}
          dataKey={s.key}
          name={s.name}
          stroke={s.color}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      ))}
    </LineChart>
  );

  return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      </div>
      {withTable && (
        <DataTable data={data} columns={series} format={fmt} labelKey="date" />
      )}
    </div>
  );
}

export function MonthlyBarChart({
  data,
  series,
  height = 260,
  stacked = false,
}: {
  data: Record<string, unknown>[];
  series: SeriesDef[];
  height?: number;
  stacked?: boolean;
}) {
    return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              {...AXIS}
              tickFormatter={(v: string) => v.slice(0, 4)}
              minTickGap={40}
            />
            <YAxis {...AXIS} tickFormatter={compact} width={52} axisLine={false} />
            <Tooltip content={<ChartTooltip format={moneyFmt} labelFormat={monthLabel} />} cursor={{ fill: "var(--surface-2)" }} />
            {series.length > 1 && <Legend iconType="circle" iconSize={8} />}
            {series.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.name}
                stackId={stacked ? "a" : undefined}
                fill={s.color}
                radius={stacked ? 0 : [3, 3, 0, 0]}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <DataTable data={data} columns={series} format={(v) => money(v)} labelKey="date" />
    </div>
  );
}

/**
 * Year-overlay chart: month on the x-axis, one line per year, so seasonality
 * reads across years at a glance. Recent years take categorical colors + the
 * legend; older years recede to muted gray so 15+ series stay readable.
 */
export function YearOverlayChart({
  rows,
  years,
  isPercent = false,
  height = 300,
  highlight = 4,
}: {
  rows: Record<string, unknown>[];
  years: number[];
  isPercent?: boolean;
  height?: number;
  highlight?: number;
}) {
  const fmt = isPercent ? (v: number) => pct(v) : (v: number) => money(v);
  const axisFmt = isPercent ? (v: number) => pct(v, 0) : compact;
  const recent = years.slice(-highlight);
  const colors = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-5)"];
  const columns = [...years].reverse().map((y, i) => ({
    key: String(y),
    name: String(y),
    color: recent.includes(y)
      ? colors[recent.indexOf(y) % colors.length]
      : "var(--text-muted)",
    isRecent: recent.includes(y),
    z: i,
  }));
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-3 text-xs text-ink-2">
        {recent.map((y, i) => (
          <span key={y} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: colors[i % colors.length] }}
            />
            {y}
          </span>
        ))}
        {years.length > recent.length && (
          <span className="flex items-center gap-1.5 text-ink-3">
            <span className="inline-block h-2 w-2 rounded-full bg-(--text-muted) opacity-40" />
            earlier years
          </span>
        )}
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="month" {...AXIS} />
            <YAxis {...AXIS} tickFormatter={axisFmt} width={52} axisLine={false} />
            <Tooltip content={<ChartTooltip format={fmt} />} />
            {[...columns].sort((a, b) => Number(a.isRecent) - Number(b.isRecent)).map((c) => (
              <Line
                key={c.key}
                dataKey={c.key}
                name={c.name}
                stroke={c.color}
                strokeWidth={c.isRecent ? 2 : 1}
                strokeOpacity={c.isRecent ? 1 : 0.35}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <DataTable
        data={rows}
        columns={columns.filter((c) => c.isRecent)}
        format={fmt}
        labelKey="month"
      />
    </div>
  );
}

export function AllocationDonut({
  data,
  height = 240,
}: {
  data: { name: string; value: number; color: string }[];
  height?: number;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div style={{ height, width: height }} className="shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="90%"
              paddingAngle={2}
              stroke="var(--surface-1)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <TooltipBox
                    label={String(payload[0].name)}
                    rows={[
                      {
                        name: "Balance",
                        value: `${money(Number(payload[0].value))} (${pct(
                          Number(payload[0].value) / total,
                        )})`,
                      },
                    ]}
                  />
                ) : null
              }
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="min-w-40 flex-1 space-y-1.5 text-sm">
        {data.map((d) => (
          <li key={d.name} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-ink-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: d.color }}
              />
              {d.name}
            </span>
            <span className="tabular-nums text-ink">
              {money(d.value)}
              <span className="ml-2 text-xs text-ink-3">{pct(d.value / total)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartShell({ children }: { children: ReactNode }) {
  return <div className="text-xs">{children}</div>;
}
