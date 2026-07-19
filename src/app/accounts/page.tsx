import Link from "next/link";
import { loadAccounts } from "@/lib/metrics";
import { CATEGORY_META, CATEGORY_ORDER } from "@/lib/categories";
import { money, monthLabel } from "@/lib/format";
import { Card, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const accts = await loadAccounts();

  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    accounts: accts.filter((a) => a.category === cat),
  })).filter((g) => g.accounts.length > 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Accounts"
        subtitle="Every tracked account; closed accounts keep their history"
      />
      {groups.map(({ cat, accounts }) => (
        <Card key={cat} title={CATEGORY_META[cat].name}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Account</th>
                <th className="py-1.5 pr-2 font-medium">Institution</th>
                <th className="py-1.5 pr-2 text-right font-medium">Balance</th>
                <th className="py-1.5 pr-2 text-right font-medium">Entries</th>
                <th className="py-1.5 text-right font-medium">Last entry</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const last = a.entries.at(-1);
                return (
                  <tr key={a.id} className="border-t border-edge">
                    <td className="py-2 pr-2">
                      <Link
                        href={`/accounts/${a.slug}`}
                        className="font-medium text-ink hover:underline"
                      >
                        {a.name}
                      </Link>
                      {!a.isActive && (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">
                          closed
                        </span>
                      )}
                      {!a.includeInNetWorth && (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">
                          excluded from net worth
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-ink-2">{a.institution}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {last ? money(last.balance) : "–"}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-ink-2">
                      {a.entries.length}
                    </td>
                    <td className="py-2 text-right text-xs text-ink-3">
                      {last ? monthLabel(last.statementDate) : "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}
