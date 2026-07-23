import { desc } from "drizzle-orm";
import { db, externalTransactions, persons } from "@/db";
import { getProvider } from "@/lib/providers";
import { monarchCredentialsStatus } from "@/lib/monarch-credentials";
import { loadSyncState, verificationDiffs } from "@/lib/sync";
import {
  loadAccounts,
  loadHouse,
  houseMonthly,
  portfolioSeries,
} from "@/lib/metrics";
import { dateLabel, money } from "@/lib/format";
import { Card, PageHeader, StatTile } from "@/components/ui";
import { ExternalAccountRow } from "@/components/external-account-row";
import { syncNow } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const [provider, credStatus, { externals, runs, allAccounts }, diffs, people, accts, house, recentTx] =
    await Promise.all([
      getProvider(),
      monarchCredentialsStatus(),
      loadSyncState(),
      verificationDiffs(),
      db.select().from(persons),
      loadAccounts(),
      loadHouse(),
      db
        .select()
        .from(externalTransactions)
        .orderBy(desc(externalTransactions.date))
        .limit(10),
    ]);

  const houseMonths = house ? houseMonthly(house) : [];
  const { months } = portfolioSeries(accts, houseMonths);
  const individualNW = months.at(-1)?.balance ?? 0;

  const additions = externals.filter(
    (e) => !e.linkedAccountId && e.includeInHousehold,
  );
  const householdExtra = additions.reduce(
    (s, e) => s + e.currentBalance * e.ownershipShare,
    0,
  );
  const lastRun = runs[0];
  // Match status is the authority on what still needs a decision — the same
  // number /household shows. (The old count read the deprecated
  // external_accounts.include_in_household, which is now hub-owned, and so
  // disagreed with the review queue.)
  const unreviewed = externals.filter((e) => e.matchStatus === "pending").length;
  const extById = new Map(externals.map((e) => [e.id, e]));

  // Monarch's token lifetime is undocumented and can be as short as hours —
  // surface how stale it is rather than let it be a surprise on the next
  // failed sync. Irrelevant for the fixture provider.
  const now = new Date();
  const daysAgo = (iso: string) => {
    const n = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
    return n <= 0 ? "today" : `${n}d ago`;
  };
  const providerSub =
    provider.name !== "monarch"
      ? provider.isConfigured()
        ? "configured"
        : "not configured"
      : !provider.isConfigured()
        ? "not configured — run `npm run monarch:refresh`"
        : credStatus.configured
          ? `refreshed ${daysAgo(credStatus.refreshedAt!)}`
          : "using fallback env var — run `npm run monarch:refresh`";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sync"
        subtitle="External data flows in through a swappable provider; Fred stays the system of record"
        action={
          <form action={syncNow}>
            <button
              disabled={!provider.isConfigured()}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Sync now
            </button>
          </form>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Provider" value={provider.name} sub={providerSub} />
        <StatTile
          label="Last sync"
          value={
            lastRun
              ? lastRun.status === "success"
                ? "✓ success"
                : lastRun.status === "partial"
                  ? "⚠ partial"
                  : lastRun.status
              : "never"
          }
          sub={lastRun?.finishedAt?.slice(0, 16).replace("T", " ")}
          deltaGood={
            lastRun
              ? lastRun.status === "success"
                ? true
                : lastRun.status === "error"
                  ? false
                  : undefined
              : undefined
          }
        />
        <StatTile
          label="External accounts"
          value={String(externals.length)}
          sub={`${externals.filter((e) => e.linkedAccountId).length} linked · ${unreviewed} to review`}
        />
        <StatTile
          label="Household net worth"
          value={money(individualNW + householdExtra)}
          sub={`you ${money(individualNW)} + others ${money(householdExtra)}`}
        />
      </div>

      {lastRun?.status === "error" && (
        <Card>
          <p className="text-sm text-bad">Last sync failed: {lastRun.error}</p>
        </Card>
      )}

      {lastRun?.status === "partial" && (
        <Card>
          <p className="text-sm text-ink-2">
            <span className="font-medium text-ink">Partial sync.</span> Accounts
            and balances synced, but some data didn&apos;t: {lastRun.error}
          </p>
          <p className="mt-2 text-xs text-ink-3">
            Monarch has no official API, so an operation can drift without
            notice — the rest of the sync is unaffected and everything already
            pulled is still current. The fix lives in one place:{" "}
            <code className="text-ink-2">src/lib/providers/monarch.ts</code>.
          </p>
        </Card>
      )}

      <Card
        title="External accounts"
        subtitle="Link = the same real account Fred already tracks (verification only); unlinked accounts are additive — opt them into the household total"
      >
        {externals.length === 0 ? (
          <p className="text-sm text-ink-3">
            Nothing synced yet — run a sync to pull accounts.
          </p>
        ) : (
          externals.map((e) => (
            <ExternalAccountRow
              key={e.id}
              external={e}
              fredAccounts={allAccounts.map((a) => ({ id: a.id, name: a.name }))}
              people={people.map((p) => ({ id: p.id, name: p.name }))}
            />
          ))
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Statement verification"
          subtitle="Fred's last close vs the provider snapshot nearest that date"
        >
          {diffs.length === 0 ? (
            <p className="text-sm text-ink-3">No linked accounts yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Account</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Statement</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Provider</th>
                  <th className="py-1.5 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {diffs.map((d) => (
                  <tr key={d.fredSlug} className="border-t border-edge">
                    <td className="py-1.5 pr-2">
                      {d.fredName}
                      <span className="ml-1 text-xs text-ink-3">
                        {d.statementDate}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(d.statementBalance, true)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {d.snapshotBalance != null
                        ? money(d.snapshotBalance, true)
                        : "no snapshot"}
                    </td>
                    <td
                      className={`py-1.5 text-right font-medium tabular-nums ${
                        d.diff == null
                          ? "text-ink-3"
                          : Math.abs(d.diff) < 1
                            ? "text-good"
                            : "text-bad"
                      }`}
                    >
                      {d.diff == null
                        ? "–"
                        : Math.abs(d.diff) < 1
                          ? "✓"
                          : money(d.diff, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-ink-3">
            A mismatch means either a statement typo or provider drift — the
            statement stays authoritative; this is the alarm, not the fix.
          </p>
        </Card>

        <Card title="Recent synced transactions" subtitle="Newest first">
          {recentTx.length === 0 ? (
            <p className="text-sm text-ink-3">No transactions synced yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {recentTx.map((t) => (
                  <tr key={t.id} className="border-t border-edge">
                    <td className="py-1.5 pr-2 text-xs whitespace-nowrap text-ink-3">
                      {dateLabel(t.date)}
                    </td>
                    <td className="py-1.5 pr-2">
                      <span className="text-ink">{t.merchant ?? "—"}</span>
                      <span className="ml-2 text-xs text-ink-3">
                        {t.category}
                        {" · "}
                        {extById.get(t.externalAccountId)?.name}
                      </span>
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${
                        t.amount >= 0 ? "text-good" : "text-ink"
                      }`}
                    >
                      {money(t.amount, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Recent sync runs">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-ink-3">
            <tr>
              <th className="py-1.5 pr-2 font-medium">Run</th>
              <th className="py-1.5 pr-2 font-medium">Status</th>
              <th className="py-1.5 pr-2 font-medium">Finished</th>
              <th className="py-1.5 font-medium">Stats</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-edge">
                <td className="py-1.5 pr-2 text-ink-3">
                  #{r.id} · {r.provider}
                </td>
                <td
                  className={`py-1.5 pr-2 ${
                    r.status === "success"
                      ? "text-good"
                      : r.status === "error"
                        ? "text-bad"
                        : "text-ink-2"
                  }`}
                >
                  {r.status}
                </td>
                <td className="py-1.5 pr-2 text-xs text-ink-3">
                  {r.finishedAt?.slice(0, 19).replace("T", " ") ?? "—"}
                </td>
                {/* A partial run carries both stats and warnings — show both,
                    otherwise the reason for the partial is invisible here. */}
                <td className="py-1.5 text-xs text-ink-3">
                  {r.stats != null && <span>{JSON.stringify(r.stats)}</span>}
                  {r.error && (
                    <span className={r.stats ? "block text-bad" : "text-bad"}>
                      {r.error}
                    </span>
                  )}
                  {!r.stats && !r.error && "—"}
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={4} className="py-2 text-sm text-ink-3">
                  No sync runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
