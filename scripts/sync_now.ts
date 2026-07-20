// Run one sync from the CLI, using whichever provider FRED_SYNC_PROVIDER
// selects. Same code path as the /sync page's "Sync now" button — useful for
// scripted/scheduled runs and for verifying a provider fix end-to-end.
// Usage: npm run sync:now
import { getProvider } from "../src/lib/providers";
import { runSync } from "../src/lib/sync";

async function main() {
  const provider = getProvider();
  if (!provider.isConfigured()) {
    console.error(
      `Provider "${provider.name}" is not configured — see docs/SYNC.md.`,
    );
    process.exit(1);
  }
  console.log(`syncing via ${provider.name}…`);
  const r = await runSync(provider);
  console.log(`status: ${r.status}`);
  if (r.stats) console.log(`stats:  ${JSON.stringify(r.stats)}`);
  if (r.warnings?.length) console.log(`warnings: ${r.warnings.join("; ")}`);
  if (r.error) console.log(`error:  ${r.error}`);
  process.exit(r.status === "error" ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
