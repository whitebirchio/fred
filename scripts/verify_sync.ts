// Sync pipeline harness: runs two consecutive syncs and asserts convergence
// (row counts identical after the second run — idempotency).
// Usage: FRED_SYNC_PROVIDER=fixture npx tsx scripts/verify_sync.ts
import { getProvider } from "../src/lib/providers";
import { runSync } from "../src/lib/sync";
import {
  db,
  externalAccounts,
  balanceSnapshots,
  externalTransactions,
  holdings,
} from "../src/db";

async function counts() {
  const [a, s, t, h] = await Promise.all([
    db.select().from(externalAccounts),
    db.select().from(balanceSnapshots),
    db.select().from(externalTransactions),
    db.select().from(holdings),
  ]);
  return {
    accounts: a.length,
    snapshots: s.length,
    transactions: t.length,
    holdings: h.length,
    linked: a.filter((x) => x.linkedAccountId).map((x) => x.name),
  };
}

async function main() {
  const p = await getProvider();
  console.log("provider:", p.name);
  const r1 = await runSync(p);
  console.log("run 1:", r1.status, JSON.stringify(r1.stats ?? r1.error));
  const c1 = await counts();
  console.log("after run 1:", JSON.stringify(c1));
  const r2 = await runSync(p);
  console.log("run 2:", r2.status, JSON.stringify(r2.stats ?? r2.error));
  const c2 = await counts();
  console.log("after run 2:", JSON.stringify(c2));
  const same =
    c1.accounts === c2.accounts &&
    c1.snapshots === c2.snapshots &&
    c1.transactions === c2.transactions &&
    c1.holdings === c2.holdings;
  console.log(same ? "IDEMPOTENT ✓" : "NOT IDEMPOTENT ✗");
  process.exit(same ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
