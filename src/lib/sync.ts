import { and, desc, eq, max, sql } from "drizzle-orm";
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

    // ---------------------------------------------------------------- accounts
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

    const extIdToRowId = new Map<string, number>();
    const now = new Date().toISOString();
    for (const pa of providerAccounts) {
      stats.accounts++;
      const prior = existingByExtId.get(pa.externalId);
      if (prior) {
        await db
          .update(externalAccounts)
          .set({
            name: pa.name,
            institution: pa.institution,
            accountType: pa.accountType,
            isAsset: pa.isAsset,
            currentBalance: round2(pa.balance),
            balanceAsOf: pa.balanceAsOf,
            isActive: pa.isActive,
            raw: pa.raw ?? null,
            lastSeenAt: now,
          })
          .where(eq(externalAccounts.id, prior.id));
        extIdToRowId.set(pa.externalId, prior.id);
      } else {
        stats.newAccounts++;
        const linkedAccountId = autoMatch(
          pa.name,
          pa.institution,
          fredAccounts,
          alreadyLinked,
        );
        if (linkedAccountId) {
          stats.autoLinked++;
          alreadyLinked.add(linkedAccountId);
        }
        const [row] = await db
          .insert(externalAccounts)
          .values({
            provider: provider.name,
            externalId: pa.externalId,
            name: pa.name,
            institution: pa.institution,
            accountType: pa.accountType,
            isAsset: pa.isAsset,
            currentBalance: round2(pa.balance),
            balanceAsOf: pa.balanceAsOf,
            isActive: pa.isActive,
            linkedAccountId,
            includeInHousehold: false,
            raw: pa.raw ?? null,
          })
          .returning();
        extIdToRowId.set(pa.externalId, row.id);
      }
    }

    // --------------------------------------------------------------- snapshots
    for (const pa of providerAccounts) {
      const rowId = extIdToRowId.get(pa.externalId)!;
      const points = [
        ...(pa.dailyBalances ?? []),
        { date: pa.balanceAsOf, balance: pa.balance },
      ];
      for (const p of points) {
        await db
          .insert(balanceSnapshots)
          .values({
            externalAccountId: rowId,
            date: p.date,
            balance: round2(p.balance),
          })
          .onConflictDoUpdate({
            target: [balanceSnapshots.externalAccountId, balanceSnapshots.date],
            set: { balance: round2(p.balance) },
          });
        stats.snapshots++;
      }
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
    for (const t of txs) {
      const accountRowId = extIdToRowId.get(t.accountExternalId);
      if (!accountRowId) continue; // transaction for an account we don't know
      await db
        .insert(externalTransactions)
        .values({
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
        })
        .onConflictDoUpdate({
          target: [externalTransactions.provider, externalTransactions.externalId],
          set: {
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
        });
      stats.transactions++;
    }

    // ---------------------------------------------------------------- holdings
    const investmentIds = providerAccounts
      .filter((pa) => INVESTMENT_TYPES.has(pa.accountType))
      .map((pa) => pa.externalId);
    if (investmentIds.length) {
      const asOf = new Date().toISOString().slice(0, 10);
      let rows: Awaited<ReturnType<typeof provider.fetchHoldings>> = [];
      try {
        rows = await provider.fetchHoldings(investmentIds);
      } catch (err) {
        warnings.push(`holdings: ${asMessage(err)}`);
      }
      for (const h of rows) {
        const accountRowId = extIdToRowId.get(h.accountExternalId);
        if (!accountRowId) continue;
        await db
          .insert(holdings)
          .values({
            externalAccountId: accountRowId,
            asOf,
            ticker: h.ticker,
            name: h.name,
            quantity: h.quantity,
            price: h.price,
            value: round2(h.value),
          })
          .onConflictDoUpdate({
            target: [holdings.externalAccountId, holdings.asOf, holdings.name],
            set: {
              ticker: h.ticker,
              quantity: h.quantity,
              price: h.price,
              value: round2(h.value),
            },
          });
        stats.holdings++;
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

  for (const row of rows) {
    const [fred] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, row.linkedAccountId!));
    if (!fred) continue;
    const [lastEntry] = await db
      .select({
        statementDate: accountEntries.statementDate,
        balance: accountEntries.balance,
      })
      .from(accountEntries)
      .where(eq(accountEntries.accountId, fred.id))
      .orderBy(desc(accountEntries.statementDate))
      .limit(1);
    if (!lastEntry) continue;
    const { statementDate } = lastEntry;
    const [snap] = await db
      .select({ date: balanceSnapshots.date, balance: balanceSnapshots.balance })
      .from(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.externalAccountId, row.externalId),
          sql`${balanceSnapshots.date} between (${statementDate}::date - interval '5 days') and (${statementDate}::date + interval '5 days')`,
        ),
      )
      .orderBy(sql`abs(${balanceSnapshots.date} - ${statementDate}::date)`)
      .limit(1);
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
export async function snapshotNear(accountId: number, dateISO: string) {
  const [snap] = await db
    .select({ date: balanceSnapshots.date, balance: balanceSnapshots.balance })
    .from(balanceSnapshots)
    .innerJoin(
      externalAccounts,
      eq(externalAccounts.id, balanceSnapshots.externalAccountId),
    )
    .where(
      and(
        eq(externalAccounts.linkedAccountId, accountId),
        sql`${balanceSnapshots.date} between (${dateISO}::date - interval '5 days') and (${dateISO}::date + interval '5 days')`,
      ),
    )
    .orderBy(sql`abs(${balanceSnapshots.date} - ${dateISO}::date)`)
    .limit(1);
  return snap ?? null;
}
