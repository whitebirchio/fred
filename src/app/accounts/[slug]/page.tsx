import { notFound } from "next/navigation";
import { individualTotal, loadAccounts } from "@/lib/metrics";
import { contributionFieldFor } from "@/lib/taxlots";
import {
  loadHousehold,
  signedValue,
  sourceIcon,
  sourceLabel,
} from "@/lib/household";
import { CATEGORY_META } from "@/lib/categories";
import { dateLabel, money, monthEnd, monthLabel } from "@/lib/format";
import { Card, PageHeader, StatTile } from "@/components/ui";
import { MonthlyBarChart, TimeSeriesChart } from "@/components/charts";
import { EntryForm } from "@/components/entry-form";
import { DeleteAccountDetailControl } from "@/components/delete-account-detail-control";
import { deleteEntry } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [accts, hh] = await Promise.all([loadAccounts(), loadHousehold()]);
  const account = accts.find((a) => a.slug === slug);
  if (!account) notFound();
  // The same resolved balance every other screen shows for this account,
  // with the provenance that explains which source won.
  const live = hh.accounts.find((a) => a.id === account.id) ?? null;

  const entries = account.entries;
  const last = entries.at(-1);
  const totals = entries.reduce(
    (t, e) => ({
      contributions: t.contributions + individualTotal(e) + e.employerContributions,
      growth: t.growth + e.growth,
      withdrawals: t.withdrawals + e.withdrawals,
    }),
    { contributions: 0, growth: 0, withdrawals: 0 },
  );

  const series = entries.map((e) => ({
    date: e.statementDate,
    balance: e.balance,
    contributions: individualTotal(e) + e.employerContributions,
    growth: e.growth,
    withdrawals: -e.withdrawals,
    net:
      individualTotal(e) +
      e.employerContributions +
      e.transfersIn -
      e.withdrawals -
      e.transfersOut,
  }));

  // next month to enter: month after last entry (or current month)
  const today = new Date();
  let nextDate = monthEnd(today.getUTCFullYear(), today.getUTCMonth() + 1);
  if (last) {
    const [y, m] = last.statementDate.split("-").map(Number);
    const candidate = monthEnd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
    if (candidate < nextDate) nextDate = candidate;
  }

  const color = CATEGORY_META[account.category].color;

  return (
    <div className="space-y-4">
      <PageHeader
        title={account.name}
        subtitle={`${CATEGORY_META[account.category].name} · ${account.institution ?? ""} ${
          account.isActive ? "" : "· closed"
        }`}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Balance"
          value={live?.balance.value != null ? money(live.signedBalance) : "–"}
          sub={
            live?.balance.observedAt
              ? `${sourceLabel(live.balance.source!)} · ${dateLabel(live.balance.observedAt)}`
              : undefined
          }
        />
        <StatTile
          label="Since last close"
          value={
            live?.balance.value != null && last
              ? money(live.signedBalance - signedValue(account.category, last.balance))
              : "–"
          }
          sub={last ? monthLabel(last.statementDate) : undefined}
        />
        <StatTile label="Lifetime contributions" value={money(totals.contributions)} />
        <StatTile
          label="Lifetime growth"
          value={money(totals.growth)}
          deltaGood={totals.growth >= 0}
        />
      </div>

      {/* Which source this number came from, and why — the same explanation
          /household gives, so the two can't tell different stories. */}
      {live && live.sources.length > 0 && (
        <Card title="Where this balance comes from">
          <ul className="space-y-1.5 text-sm">
            {live.sources.map((c) => {
              const winner = c.source === live.balance.source;
              return (
                <li
                  key={`${c.source}-${c.externalAccountId ?? "own"}`}
                  className="flex flex-wrap items-baseline justify-between gap-2"
                >
                  <span className="text-ink-2">
                    {sourceIcon(c.source)} {sourceLabel(c.source)}
                    {c.externalName && (
                      <span className="text-ink-3"> ({c.externalName})</span>
                    )}
                    <span className="ml-2 text-xs text-ink-3">
                      as of {c.observedAt}
                      {c.connectionStatus === "broken" && (
                        <span className="ml-1 text-bad">· connection broken</span>
                      )}
                    </span>
                  </span>
                  <span className="tabular-nums text-ink">
                    {money(c.value)}
                    {winner && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-accent">
                        shown
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-ink-3">{live.balance.reason}</p>
        </Card>
      )}

      <Card title="Balance">
        <TimeSeriesChart
          data={series}
          series={[{ key: "balance", name: "Balance", color }]}
        />
      </Card>

      <Card title="Monthly flows" subtitle="Contributions, growth and withdrawals by month">
        <MonthlyBarChart
          data={series}
          stacked
          series={[
            { key: "contributions", name: "Contributions", color: "var(--series-1)" },
            { key: "growth", name: "Growth", color: "var(--series-2)" },
            { key: "withdrawals", name: "Withdrawals", color: "var(--series-6)" },
          ]}
        />
      </Card>

      <Card
        title="Add / update statement entry"
        subtitle="Enter the statement balance and any flows — growth is derived automatically"
      >
        <EntryForm
          accountId={account.id}
          accountName={account.name}
          statementDate={nextDate}
          prevBalance={last?.balance ?? 0}
          contributionField={contributionFieldFor(account)}
        />
      </Card>

      <Card title="Statement history" subtitle="Most recent first">
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-ink-3">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Month</th>
                <th className="py-1.5 pr-2 text-right font-medium">Contrib.</th>
                <th className="py-1.5 pr-2 text-right font-medium">Employer</th>
                <th className="py-1.5 pr-2 text-right font-medium">Transfers in</th>
                <th className="py-1.5 pr-2 text-right font-medium">Growth</th>
                <th className="py-1.5 pr-2 text-right font-medium">Withdrawals</th>
                <th className="py-1.5 pr-2 text-right font-medium">Transfers out</th>
                <th className="py-1.5 pr-2 text-right font-medium">Balance</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {[...entries].reverse().map((e) => (
                <tr key={e.id} className="border-t border-edge">
                  <td className="py-1.5 pr-2">{monthLabel(e.statementDate)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {money(individualTotal(e), true)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {money(e.employerContributions, true)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {money(e.transfersIn, true)}
                  </td>
                  <td
                    className={`py-1.5 pr-2 text-right tabular-nums ${
                      e.growth < 0 ? "text-bad" : ""
                    }`}
                  >
                    {money(e.growth, true)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {money(e.withdrawals, true)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {money(e.transfersOut, true)}
                  </td>
                  <td className="py-1.5 pr-2 text-right font-medium tabular-nums">
                    {money(e.balance, true)}
                  </td>
                  <td className="py-1.5 text-right">
                    <form action={deleteEntry}>
                      <input type="hidden" name="entryId" value={e.id} />
                      <button
                        className="text-xs text-ink-3 hover:text-bad"
                        title="Delete entry"
                      >
                        ✕
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Danger zone">
        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-3">
            Permanently remove this account and its {entries.length} statement{" "}
            {entries.length === 1 ? "entry" : "entries"} from Fred.
          </p>
          <DeleteAccountDetailControl accountId={account.id} accountName={account.name} />
        </div>
      </Card>
    </div>
  );
}
