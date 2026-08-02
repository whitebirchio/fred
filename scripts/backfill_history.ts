// Pull each linked account's full balance history from the provider into
// balance_snapshots.
//
// Run from the CLI, not from a sync: this costs one request per account, far
// more subrequests than a Workers invocation may make. Routine syncs keep the
// recent end current from the short trailing window in fetchAccounts, so this
// only ever needs running once per account — though it is idempotent, so
// re-running to close a gap is safe.
//
// Worth running sooner rather than later: what the provider retains is its
// business, and once these points are in Fred they are ours regardless.
//
//   node --env-file=.env npx tsx scripts/backfill_history.ts          # dry run
//   node --env-file=.env npx tsx scripts/backfill_history.ts --apply
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { balanceSnapshots, externalAccounts } from "../src/db/schema";
import { getProvider } from "../src/lib/providers";

const APPLY = process.argv.includes("--apply");
const CHUNK = 500;
const r2 = (v: number) => Math.round(v * 100) / 100;

async function main() {
  const provider = await getProvider();
  if (!provider.isConfigured()) {
    console.error(`Provider "${provider.name}" is not configured — see docs/SYNC.md.`);
    process.exit(1);
  }

  const externals = await db.select().from(externalAccounts);
  // Only accounts that actually feed a household account are worth storing
  // history for; pending and ignored rows contribute to nothing.
  const linked = externals.filter(
    (e) =>
      e.provider === provider.name &&
      e.linkedAccountId &&
      (e.matchStatus === "auto" || e.matchStatus === "confirmed"),
  );
  console.log(`${linked.length} linked ${provider.name} accounts\n`);

  const before = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(balanceSnapshots);
  console.log(`balance_snapshots before: ${before[0].n}`);

  const idByExternalId = new Map(linked.map((e) => [e.externalId, e.id]));
  const points = await provider.fetchBalanceHistory(
    linked.map((e) => e.externalId),
  );
  console.log(`fetched ${points.length} history points`);

  // Per-account coverage, so a provider quietly returning nothing for an
  // account is visible rather than silently leaving a hole in the charts.
  const perAccount = new Map<string, { n: number; first: string; last: string }>();
  for (const p of points) {
    const cur = perAccount.get(p.accountExternalId);
    if (!cur) perAccount.set(p.accountExternalId, { n: 1, first: p.date, last: p.date });
    else {
      cur.n++;
      if (p.date < cur.first) cur.first = p.date;
      if (p.date > cur.last) cur.last = p.date;
    }
  }
  for (const e of linked) {
    const c = perAccount.get(e.externalId);
    console.log(
      `  ${e.name.slice(0, 34).padEnd(36)} ${c ? `${String(c.n).padStart(5)} pts  ${c.first} -> ${c.last}` : "NO HISTORY RETURNED"}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — would upsert ${points.length} snapshots. Re-run with --apply.`);
    process.exit(0);
  }

  // Normalize to Fred's storage convention: liabilities are positive
  // magnitudes, signed at rollup. Monarch reports them negative, and storing
  // that verbatim would flip every credit card into an asset once
  // signedValue() negates it a second time.
  const isAssetByExternalId = new Map(linked.map((e) => [e.externalId, e.isAsset]));
  const rows = points
    .map((p) => ({
      externalAccountId: idByExternalId.get(p.accountExternalId)!,
      date: p.date,
      balance: r2(
        isAssetByExternalId.get(p.accountExternalId) === false
          ? Math.abs(p.balance)
          : p.balance,
      ),
    }))
    .filter((r) => r.externalAccountId != null);

  // Last write wins within a batch — a duplicate (account, date) in one
  // statement is an error in Postgres, not a no-op.
  const deduped = [...new Map(rows.map((r) => [`${r.externalAccountId}|${r.date}`, r])).values()];

  for (let i = 0; i < deduped.length; i += CHUNK) {
    await db
      .insert(balanceSnapshots)
      .values(deduped.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [balanceSnapshots.externalAccountId, balanceSnapshots.date],
        set: { balance: sql`excluded.balance` },
      });
  }

  const after = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(balanceSnapshots);
  console.log(
    `\nAPPLIED — balance_snapshots ${before[0].n} -> ${after[0].n} (+${after[0].n - before[0].n})`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
