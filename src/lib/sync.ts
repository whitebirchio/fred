import { desc, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accountEntries,
  accounts,
  balanceSnapshots,
  externalAccounts,
  externalTransactions,
  holdings,
  syncRuns,
} from "@/db/schema";
import type { SyncProvider } from "./providers";

// Sync orchestration. Core properties:
//  - Idempotent: every write is an upsert keyed by natural identity
//    ((provider, externalId) or (account, date)); re-running a sync converges
//    instead of duplicating.
//  - Non-destructive: user-owned fields (link, owner, household inclusion,
//    share) are set once at first sight and never overwritten by later syncs.
//  - Auditable: every run lands in sync_runs with stats or the error.

const round2 = (v: number) => Math.round(v * 100) / 100;

const INVESTMENT_TYPES = new Set(["brokerage", "retirement", "crypto"]);

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match a new external account to a Fred statement account by name/institution
 * similarity. Links only on an unambiguous single match; users can always
 * relink in the UI.
 */
function autoMatch(
  externalName: string,
  institution: string | null,
  fredAccounts: { id: number; name: string; institution: string | null }[],
  alreadyLinked: Set<number>,
): number | null {
  const ext = normalizeName(externalName);
  const extWithInst = normalizeName(`${institution ?? ""}${externalName}`);
  const candidates = fredAccounts.filter((a) => {
    if (alreadyLinked.has(a.id)) return false;
    const fred = normalizeName(a.name);
    const fredWithInst = normalizeName(`${a.institution ?? ""}${a.name}`);
    return (
      fred === ext ||
      fred.includes(ext) ||
      ext.includes(fred) ||
      fredWithInst.includes(ext) ||
      extWithInst.includes(fred)
    );
  });
  return candidates.length === 1 ? candidates[0].id : null;
}

/** Multi-row upserts fail outright if the same conflict key appears twice in
 *  one statement (Postgres: "ON CONFLICT DO UPDATE command cannot affect row
 *  a second time") -- collapse to last-write-wins before every bulk write
 *  below. (Real case this guards: Monarch's trailing daily-balance window can
 *  land on the same date as the separately-appended "current balance" point
 *  for the same account.) */
function dedupeBy<T>(rows: T[], keyFn: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(keyFn(r), r);
  return [...m.values()];
}

// Matches db/seed.ts's bulk-insert chunk size. Keeps each statement's
// parameter count well under Postgres's limit and, more importantly, keeps
// the number of subrequests a sync issues small and bounded rather than
// scaling 1:1 with row count -- see runSync's comment below for why that
// matters on a free-plan Worker.
const CHUNK = 500;

export type SyncStats = {
  accounts: number;
  newAccounts: number;
  autoLinked: number;
  snapshots: number;
  transactions: number;
  holdings: number;
};

export async function runSync(provider: SyncProvider): Promise<{
  runId: number;
  status: "success" | "partial" | "error";
  stats?: SyncStats;
  warnings?: string[];
  error?: string;
}> {
  const [run] = await db
    .insert(syncRuns)
    .values({ provider: provider.name, status: "running" })
    .returning();

  // Against an unofficial API any single operation can drift out from under
  // us at any time. Accounts are load-bearing (everything else is keyed to
  // them, so a failure there is fatal), but transactions and holdings each
  // degrade independently: a broken query there records a warning and leaves
  // the rest of the sync intact rather than discarding a good account/
  // snapshot pull. The run is then marked "partial" so the failure is still
  // visible on /sync rather than silently swallowed.
  const warnings: string[] = [];
  const asMessage = (err: unknown) =>
    err instanceof Error ? err.message : String(err);

  try {
    const stats: SyncStats = {
      accounts: 0,
      newAccounts: 0,
      autoLinked: 0,
      snapshots: 0,
      transactions: 0,
      holdings: 0,
    };
    const now = new Date().toISOString();

    // ---------------------------------------------------------------- accounts
    //
    // Every phase below follows the same shape: compute the full set of rows
    // to write in memory first, then issue a small number of chunked bulk
    // upserts -- never one write per row. A real sync touches thousands of
    // rows (snapshots especially: Monarch resends its whole trailing daily-
    // balance window every time), and Neon's HTTP driver makes each query one
    // `fetch()` call, which counts as one Cloudflare subrequest. The free
    // plan caps a single Worker invocation at 50 of those; a per-row loop
    // blew through it and killed the request mid-sync, leaving a `sync_runs`
    // row stuck at "running" with whatever had already committed. Chunked
    // bulk upserts keep the subrequest count small and bounded by data
    // volume divided by CHUNK, not by row count 1:1.
    const providerAccounts = await provider.fetchAccounts();
    const existing = await db
      .select()
      .from(externalAccounts)
      .where(eq(externalAccounts.provider, provider.name));
    const existingByExtId = new Map(existing.map((e) => [e.externalId, e]));
    const fredAccounts = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        institution: accounts.institution,
      })
      .from(accounts);
    const alreadyLinked = new Set(
      existing
        .map((e) => e.linkedAccountId)
        .filter((id): id is number => id != null),
    );

    stats.accounts = providerAccounts.length;
    const dedupedAccounts = dedupeBy(providerAccounts, (pa) => pa.externalId);
    const accountRows = dedupedAccounts.map((pa) => {
      const prior = existingByExtId.get(pa.externalId);
      let linkedAccountId: number | null = prior?.linkedAccountId ?? null;
      if (!prior) {
        stats.newAccounts++;
        const matched = autoMatch(pa.name, pa.institution, fredAccounts, alreadyLinked);
        if (matched) {
          stats.autoLinked++;
          alreadyLinked.add(matched);
          linkedAccountId = matched;
        }
      }
      return {
        provider: provider.name,
        externalId: pa.externalId,
        name: pa.name,
        institution: pa.institution,
        accountType: pa.accountType,
        isAsset: pa.isAsset,
        currentBalance: round2(pa.balance),
        balanceAsOf: pa.balanceAsOf,
        isActive: pa.isActive,
        // Only takes effect for a genuine INSERT -- the conflict SET below
        // deliberately excludes this column, so an existing row's link (or
        // lack of one) is never touched by a later sync.
        linkedAccountId,
        includeInHousehold: false,
        raw: pa.raw ?? null,
        lastSeenAt: now,
      };
    });

    const extIdToRowId = new Map<string, number>();
    for (let i = 0; i < accountRows.length; i += CHUNK) {
      const written = await db
        .insert(externalAccounts)
        .values(accountRows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [externalAccounts.provider, externalAccounts.externalId],
          set: {
            name: sql`excluded.name`,
            institution: sql`excluded.institution`,
            accountType: sql`excluded.account_type`,
            isAsset: sql`excluded.is_asset`,
            currentBalance: sql`excluded.current_balance`,
            balanceAsOf: sql`excluded.balance_as_of`,
            isActive: sql`excluded.is_active`,
            raw: sql`excluded.raw`,
            lastSeenAt: sql`excluded.last_seen_at`,
            // linkedAccountId, includeInHousehold: deliberately omitted --
            // user-owned fields, set once at first sight, never overwritten.
          },
        })
        .returning({ id: externalAccounts.id, externalId: externalAccounts.externalId });
      for (const row of written) extIdToRowId.set(row.externalId, row.id);
    }

    // --------------------------------------------------------------- snapshots
    const snapshotRows = dedupedAccounts.flatMap((pa) => {
      const rowId = extIdToRowId.get(pa.externalId);
      if (!rowId) return [];
      const points = [
        ...(pa.dailyBalances ?? []),
        { date: pa.balanceAsOf, balance: pa.balance },
      ];
      return points.map((p) => ({
        externalAccountId: rowId,
        date: p.date,
        balance: round2(p.balance),
      }));
    });
    const dedupedSnapshots = dedupeBy(snapshotRows, (s) => `${s.externalAccountId}|${s.date}`);
    stats.snapshots = dedupedSnapshots.length;
    for (let i = 0; i < dedupedSnapshots.length; i += CHUNK) {
      await db
        .insert(balanceSnapshots)
        .values(dedupedSnapshots.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [balanceSnapshots.externalAccountId, balanceSnapshots.date],
          set: { balance: sql`excluded.balance` },
        });
    }

    // ------------------------------------------------------------ transactions
    // Incremental window: refetch from 30 days before the newest stored
    // transaction (captures late edits/clearing) or 2 years on first run.
    const [{ newest }] = await db
      .select({ newest: max(externalTransactions.date) })
      .from(externalTransactions)
      .where(eq(externalTransactions.provider, provider.name));
    let since: string;
    if (newest) {
      const d = new Date(newest + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 30);
      since = d.toISOString().slice(0, 10);
    } else {
      const d = new Date();
      d.setUTCFullYear(d.getUTCFullYear() - 2);
      since = d.toISOString().slice(0, 10);
    }
    let txs: Awaited<ReturnType<typeof provider.fetchTransactions>> = [];
    try {
      txs = await provider.fetchTransactions(since);
    } catch (err) {
      warnings.push(`transactions: ${asMessage(err)}`);
    }
    const txRows = txs.flatMap((t) => {
      const accountRowId = extIdToRowId.get(t.accountExternalId);
      if (!accountRowId) return []; // transaction for an account we don't know
      return [
        {
          provider: provider.name,
          externalId: t.externalId,
          externalAccountId: accountRowId,
          date: t.date,
          amount: round2(t.amount),
          pending: t.pending,
          merchant: t.merchant,
          category: t.category,
          categoryGroup: t.categoryGroup,
          notes: t.notes,
          tags: t.tags,
          lastSeenAt: now,
        },
      ];
    });
    const dedupedTx = dedupeBy(txRows, (t) => `${t.provider}|${t.externalId}`);
    stats.transactions = dedupedTx.length;
    for (let i = 0; i < dedupedTx.length; i += CHUNK) {
      await db
        .insert(externalTransactions)
        .values(dedupedTx.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [externalTransactions.provider, externalTransactions.externalId],
          set: {
            externalAccountId: sql`excluded.external_account_id`,
            date: sql`excluded.date`,
            amount: sql`excluded.amount`,
            pending: sql`excluded.pending`,
            merchant: sql`excluded.merchant`,
            category: sql`excluded.category`,
            categoryGroup: sql`excluded.category_group`,
            notes: sql`excluded.notes`,
            tags: sql`excluded.tags`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
    }

    // ---------------------------------------------------------------- holdings
    const investmentIds = dedupedAccounts
      .filter((pa) => INVESTMENT_TYPES.has(pa.accountType))
      .map((pa) => pa.externalId);
    if (investmentIds.length) {
      const asOf = new Date().toISOString().slice(0, 10);
      let fetched: Awaited<ReturnType<typeof provider.fetchHoldings>> = [];
      try {
        fetched = await provider.fetchHoldings(investmentIds);
      } catch (err) {
        warnings.push(`holdings: ${asMessage(err)}`);
      }
      const holdingRows = fetched.flatMap((h) => {
        const accountRowId = extIdToRowId.get(h.accountExternalId);
        if (!accountRowId) return [];
        return [
          {
            externalAccountId: accountRowId,
            asOf,
            ticker: h.ticker,
            name: h.name,
            quantity: h.quantity,
            price: h.price,
            value: round2(h.value),
          },
        ];
      });
      const dedupedHoldings = dedupeBy(
        holdingRows,
        (h) => `${h.externalAccountId}|${h.asOf}|${h.name}`,
      );
      stats.holdings = dedupedHoldings.length;
      for (let i = 0; i < dedupedHoldings.length; i += CHUNK) {
        await db
          .insert(holdings)
          .values(dedupedHoldings.slice(i, i + CHUNK))
          .onConflictDoUpdate({
            target: [holdings.externalAccountId, holdings.asOf, holdings.name],
            set: {
              ticker: sql`excluded.ticker`,
              quantity: sql`excluded.quantity`,
              price: sql`excluded.price`,
              value: sql`excluded.value`,
            },
          });
      }
    }

    const status = warnings.length ? "partial" : "success";
    await db
      .update(syncRuns)
      .set({
        status,
        finishedAt: new Date().toISOString(),
        stats,
        error: warnings.length ? warnings.join("; ") : null,
      })
      .where(eq(syncRuns.id, run.id));
    return {
      runId: run.id,
      status,
      stats,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (err) {
    const message = asMessage(err);
    await db
      .update(syncRuns)
      .set({
        status: "error",
        finishedAt: new Date().toISOString(),
        error: [message, ...warnings].join("; "),
      })
      .where(eq(syncRuns.id, run.id));
    return { runId: run.id, status: "error", error: message };
  }
}

// ---------------------------------------------------------------------------
// Queries for the sync UI
// ---------------------------------------------------------------------------

export async function loadSyncState() {
  const [externals, runs, allAccounts] = await Promise.all([
    db.select().from(externalAccounts).orderBy(desc(externalAccounts.currentBalance)),
    db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(5),
    db.select().from(accounts).orderBy(accounts.sortOrder),
  ]);
  return { externals, runs, allAccounts };
}

/**
 * For linked external accounts: compare Fred's last statement balance with
 * the provider snapshot nearest that statement date (within a tolerance).
 */
/**
 * Batched, not per-account: this used to issue up to 3 sequential queries for
 * every linked external account, which on Neon's HTTP driver means one
 * `fetch()` subrequest each. With enough linked accounts that blew past
 * Cloudflare's 50-subrequest-per-invocation cap (free plan) and 500'd the
 * whole page — 27 linked accounts alone is 81 subrequests, before the rest of
 * /sync's own queries. Four bulk queries + an in-memory join scales the same
 * way regardless of how many accounts are linked.
 */
export async function verificationDiffs() {
  const rows = await db
    .select({
      externalId: externalAccounts.id,
      externalName: externalAccounts.name,
      linkedAccountId: externalAccounts.linkedAccountId,
    })
    .from(externalAccounts)
    .where(sql`${externalAccounts.linkedAccountId} is not null`);

  const out: {
    externalName: string;
    fredName: string;
    fredSlug: string;
    statementDate: string;
    statementBalance: number;
    snapshotDate: string | null;
    snapshotBalance: number | null;
    diff: number | null;
  }[] = [];
  if (rows.length === 0) return out;

  const accountIds = [...new Set(rows.map((r) => r.linkedAccountId!))];
  const externalIds = rows.map((r) => r.externalId);

  const [fredAccounts, entries, snapshots] = await Promise.all([
    db.select().from(accounts).where(inArray(accounts.id, accountIds)),
    db
      .select({
        accountId: accountEntries.accountId,
        statementDate: accountEntries.statementDate,
        balance: accountEntries.balance,
      })
      .from(accountEntries)
      .where(inArray(accountEntries.accountId, accountIds))
      .orderBy(desc(accountEntries.statementDate)),
    db
      .select({
        externalAccountId: balanceSnapshots.externalAccountId,
        date: balanceSnapshots.date,
        balance: balanceSnapshots.balance,
      })
      .from(balanceSnapshots)
      .where(inArray(balanceSnapshots.externalAccountId, externalIds)),
  ]);

  const fredById = new Map(fredAccounts.map((a) => [a.id, a]));
  // entries is ordered desc by statementDate, so the first hit per account is
  // the latest — matches the original per-row `.orderBy(desc).limit(1)`.
  const lastEntryByAccount = new Map<number, { statementDate: string; balance: number }>();
  for (const e of entries) {
    if (!lastEntryByAccount.has(e.accountId)) lastEntryByAccount.set(e.accountId, e);
  }
  const snapshotsByExternal = new Map<number, { date: string; balance: number }[]>();
  for (const s of snapshots) {
    const arr = snapshotsByExternal.get(s.externalAccountId) ?? [];
    arr.push(s);
    snapshotsByExternal.set(s.externalAccountId, arr);
  }

  const FIVE_DAYS_MS = 5 * 86_400_000;
  for (const row of rows) {
    const fred = fredById.get(row.linkedAccountId!);
    if (!fred) continue;
    const lastEntry = lastEntryByAccount.get(fred.id);
    if (!lastEntry) continue;
    const { statementDate } = lastEntry;
    const target = Date.parse(statementDate);

    // Nearest snapshot within +/-5 days, same tolerance as the original SQL.
    let snap: { date: string; balance: number } | null = null;
    let bestDiffMs = Infinity;
    for (const s of snapshotsByExternal.get(row.externalId) ?? []) {
      const diffMs = Math.abs(Date.parse(s.date) - target);
      if (diffMs <= FIVE_DAYS_MS && diffMs < bestDiffMs) {
        snap = s;
        bestDiffMs = diffMs;
      }
    }

    out.push({
      externalName: row.externalName,
      fredName: fred.name,
      fredSlug: fred.slug,
      statementDate,
      statementBalance: lastEntry.balance,
      snapshotDate: snap?.date ?? null,
      snapshotBalance: snap?.balance ?? null,
      diff: snap ? round2(snap.balance - lastEntry.balance) : null,
    });
  }
  return out;
}

/** Provider snapshot at/near a given month-end for a linked Fred account. */
/**
 * Nearest provider snapshot (within 5 days) for every given account at once —
 * one query regardless of how many account IDs are passed, for the same
 * subrequest-budget reason as verificationDiffs() above. An account can have
 * more than one linked source (e.g. an HSA split into cash + investment), so
 * this keeps whichever candidate lands closest to the target date per
 * account rather than assuming a 1:1 join.
 */
export async function snapshotsNear(
  accountIds: number[],
  dateISO: string,
): Promise<Map<number, { date: string; balance: number }>> {
  const out = new Map<number, { date: string; balance: number }>();
  if (accountIds.length === 0) return out;

  const rows = await db
    .select({
      linkedAccountId: externalAccounts.linkedAccountId,
      date: balanceSnapshots.date,
      balance: balanceSnapshots.balance,
    })
    .from(balanceSnapshots)
    .innerJoin(
      externalAccounts,
      eq(externalAccounts.id, balanceSnapshots.externalAccountId),
    )
    .where(inArray(externalAccounts.linkedAccountId, accountIds));

  const target = Date.parse(dateISO);
  const FIVE_DAYS_MS = 5 * 86_400_000;
  const bestDiffByAccount = new Map<number, number>();
  for (const r of rows) {
    if (r.linkedAccountId == null) continue;
    const diffMs = Math.abs(Date.parse(r.date) - target);
    if (diffMs > FIVE_DAYS_MS) continue;
    const bestSoFar = bestDiffByAccount.get(r.linkedAccountId);
    if (bestSoFar === undefined || diffMs < bestSoFar) {
      bestDiffByAccount.set(r.linkedAccountId, diffMs);
      out.set(r.linkedAccountId, { date: r.date, balance: r.balance });
    }
  }
  return out;
}
