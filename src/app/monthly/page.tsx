import Link from "next/link";
import { loadAccounts, loadHouse, houseMonthly } from "@/lib/metrics";
import { CATEGORY_META } from "@/lib/categories";
import { money, monthEnd, monthLabel } from "@/lib/format";
import { Card, PageHeader } from "@/components/ui";
import { EntryForm } from "@/components/entry-form";

export const dynamic = "force-dynamic";

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function MonthlyPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month } = await searchParams;
  const now = new Date();
  // default target = last completed calendar month
  const defaultYm = shiftMonth(
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
    -1,
  );
  const ym = /^\d{4}-\d{2}$/.test(month ?? "") ? month! : defaultYm;
  const [y, m] = ym.split("-").map(Number);
  const target = monthEnd(y, m);

  const [accts, house] = await Promise.all([loadAccounts(), loadHouse()]);
  const active = accts.filter((a) => a.isActive);

  const rows = active.map((a) => {
    const entry = a.entries.find((e) => e.statementDate === target) ?? null;
    const prev = [...a.entries].filter((e) => e.statementDate < target).at(-1);
    return { account: a, entry, prevBalance: prev?.balance ?? 0 };
  });
  const done = rows.filter((r) => r.entry).length;

  const houseMonths = house ? houseMonthly(house) : [];
  const monthPayments =
    house?.payments.filter((p) => p.date.slice(0, 7) === ym) ?? [];
  const monthValuation =
    house?.valuations.some((v) => v.date.slice(0, 7) === ym) ?? false;
  const lastHouse = houseMonths.at(-1);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Monthly close"
        subtitle="Work down the checklist once statements arrive — growth math is automatic"
        action={
          <div className="flex items-center gap-2 text-sm">
            <Link
              href={`/monthly?month=${shiftMonth(ym, -1)}`}
              className="rounded-lg border border-edge px-2 py-1 text-ink-2 hover:bg-surface-2"
            >
              ←
            </Link>
            <span className="font-medium text-ink">{monthLabel(target)}</span>
            <Link
              href={`/monthly?month=${shiftMonth(ym, 1)}`}
              className="rounded-lg border border-edge px-2 py-1 text-ink-2 hover:bg-surface-2"
            >
              →
            </Link>
          </div>
        }
      />

      <Card>
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-2">
            {done} of {rows.length} account statements entered
            {monthPayments.length > 0 && ` · ${monthPayments.length} house payments logged`}
            {monthValuation && " · house value updated"}
          </span>
          <span className="tabular-nums text-ink-3">
            {Math.round((done / Math.max(1, rows.length)) * 100)}%
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${(done / Math.max(1, rows.length)) * 100}%` }}
          />
        </div>
      </Card>

      {rows.map(({ account, entry, prevBalance }) => (
        <Card key={account.id}>
          <details open={!entry}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium text-ink">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: CATEGORY_META[account.category].color }}
                />
                {account.name}
                <Link
                  href={`/accounts/${account.slug}`}
                  className="text-xs font-normal text-ink-3 hover:underline"
                >
                  history
                </Link>
              </span>
              {entry ? (
                <span className="text-sm text-good">
                  ✓ {money(entry.balance)}{" "}
                  <span className="text-xs text-ink-3">
                    (growth {money(entry.growth)})
                  </span>
                </span>
              ) : (
                <span className="text-xs text-ink-3">
                  awaiting statement · prior {money(prevBalance)}
                </span>
              )}
            </summary>
            <div className="mt-3 border-t border-edge pt-3">
              <EntryForm
                accountId={account.id}
                accountName={account.name}
                statementDate={target}
                prevBalance={prevBalance}
                defaults={
                  entry
                    ? {
                        balance: entry.balance,
                        individualContributions: entry.individualContributions,
                        employerContributions: entry.employerContributions,
                        transfersIn: entry.transfersIn,
                        withdrawals: entry.withdrawals,
                        transfersOut: entry.transfersOut,
                      }
                    : undefined
                }
              />
            </div>
          </details>
        </Card>
      ))}

      <Card
        title="House"
        subtitle={`Log mortgage/HOA payments and refresh the market value for ${monthLabel(target)}`}
      >
        <ul className="space-y-1 text-sm">
          <li className={monthPayments.length ? "text-good" : "text-ink-2"}>
            {monthPayments.length ? "✓" : "○"} {monthPayments.length || "No"}{" "}
            payment{monthPayments.length === 1 ? "" : "s"} logged this month
          </li>
          <li className={monthValuation ? "text-good" : "text-ink-2"}>
            {monthValuation ? "✓" : "○"} Market value updated
            {lastHouse && !monthValuation && (
              <span className="ml-1 text-xs text-ink-3">
                (last: {money(lastHouse.marketValue)})
              </span>
            )}
          </li>
        </ul>
        <Link
          href="/house"
          className="mt-3 inline-block rounded-lg border border-edge px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
        >
          Open house page →
        </Link>
      </Card>

      <Card title="Paychecks" subtitle="Add any paychecks received this month">
        <Link
          href="/income"
          className="inline-block rounded-lg border border-edge px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
        >
          Open income page →
        </Link>
      </Card>
    </div>
  );
}
