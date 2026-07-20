// Quick health/read-out of synced external data + recent sync runs.
// Usage: npx tsx scripts/db_state.ts
import { desc } from "drizzle-orm";
import { db } from "../src/db";
import {
  externalAccounts,
  balanceSnapshots,
  externalTransactions,
  holdings,
  syncRuns,
} from "../src/db/schema";

async function main() {
  const [accts, snaps, txs, hold, runs] = await Promise.all([
    db.select().from(externalAccounts),
    db.select().from(balanceSnapshots),
    db.select().from(externalTransactions),
    db.select().from(holdings),
    db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(6),
  ]);
  const byProvider = (p: string) => accts.filter((a) => a.provider === p).length;
  console.log(`external accounts: ${accts.length} (monarch ${byProvider("monarch")}, fixture ${byProvider("fixture")})`);
  console.log(`snapshots: ${snaps.length} | transactions: ${txs.length} | holdings: ${hold.length}`);
  console.log(`linked: ${accts.filter((a) => a.linkedAccountId).length}`);
  console.log("recent runs:");
  for (const r of runs) {
    console.log(`  #${r.id} ${r.provider} ${r.status} ${(r.error ?? "").slice(0, 70)}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
