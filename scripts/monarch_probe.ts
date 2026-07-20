// Read-only probe of the Monarch adapter: exercises each operation against
// the live API and reports what came back, without writing anything to the
// database. Because Monarch has no official API, its GraphQL operations can
// drift and start returning HTTP 400; this isolates which one broke and shows
// a small sample so the query in src/lib/providers/monarch.ts can be fixed.
//
// Usage: npx tsx scripts/monarch_probe.ts   (needs MONARCH_TOKEN in .env)
import { MonarchProvider } from "../src/lib/providers/monarch";

async function main() {
  const p = new MonarchProvider();
  if (!p.isConfigured()) {
    console.error("MONARCH_TOKEN not set — run `npm run monarch:login` first.");
    process.exit(1);
  }

  let accountIds: string[] = [];

  // --- accounts -----------------------------------------------------------
  try {
    const accounts = await p.fetchAccounts();
    accountIds = accounts.map((a) => a.externalId);
    const withDaily = accounts.filter((a) => (a.dailyBalances?.length ?? 0) > 0);
    console.log(
      `accounts        ✓ ${accounts.length} (${withDaily.length} with daily balances)`,
    );
  } catch (err) {
    console.log(`accounts        ✗ ${err instanceof Error ? err.message : err}`);
  }

  // --- transactions -------------------------------------------------------
  try {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    const txs = await p.fetchTransactions(since.toISOString().slice(0, 10));
    const dates = txs.map((t) => t.date).sort();
    console.log(`transactions    ✓ ${txs.length} in last 30d`);
    if (txs.length) {
      console.log(`                  range ${dates[0]} … ${dates[dates.length - 1]}`);
      const categorized = txs.filter((t) => t.category).length;
      console.log(`                  ${categorized}/${txs.length} categorized`);
    }
  } catch (err) {
    console.log(`transactions    ✗ ${err instanceof Error ? err.message : err}`);
  }

  // --- holdings -----------------------------------------------------------
  try {
    const hold = await p.fetchHoldings(accountIds);
    console.log(`holdings        ${hold.length ? "✓" : "—"} ${hold.length} positions`);
  } catch (err) {
    console.log(`holdings        ✗ ${err instanceof Error ? err.message : err}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
