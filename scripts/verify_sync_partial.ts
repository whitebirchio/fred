// Regression guard: an unofficial provider API can drift at any time, so a
// single failing operation must degrade to a "partial" run rather than
// discarding the phases that did succeed. Simulates a broken transactions
// query (exactly what Monarch's HTTP 400 did) and asserts accounts still land.
// Usage: FRED_SYNC_PROVIDER=fixture npx tsx scripts/verify_sync_partial.ts
import { FixtureProvider } from "../src/lib/providers/fixture";
import { runSync } from "../src/lib/sync";

class BrokenTxProvider extends FixtureProvider {
  async fetchTransactions(): Promise<never> {
    throw new Error("Monarch GetTransactionsList failed: HTTP 400");
  }
}

async function main() {
  const res = await runSync(new BrokenTxProvider());
  console.log("status:  ", res.status);
  console.log("warnings:", res.warnings);
  console.log("stats:   ", JSON.stringify(res.stats));

  const ok =
    res.status === "partial" &&
    (res.stats?.accounts ?? 0) > 0 &&
    (res.stats?.snapshots ?? 0) > 0 &&
    (res.warnings ?? []).some((w) => w.startsWith("transactions:"));
  console.log(
    ok
      ? "DEGRADED CORRECTLY ✓ (accounts + snapshots kept, transactions warned)"
      : "REGRESSION ✗ (expected partial with accounts/snapshots intact)",
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
