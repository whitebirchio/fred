import { FixtureProvider } from "./fixture";
import { MonarchProvider } from "./monarch";
import type { SyncProvider } from "./types";
import { loadMonarchCredentials } from "@/lib/monarch-credentials";

export type { ProviderAccount, ProviderHolding, ProviderTransaction, SyncProvider } from "./types";

// Provider selection is a single env switch so swapping the external system
// (or pointing dev at the fixture) never touches application code.
//   FRED_SYNC_PROVIDER = monarch (default) | fixture
//
// Async because the Monarch case loads its token from the database (a DB
// read, not free) — everything that calls this already runs inside an async
// server component or server action, so the await costs nothing structural.
export async function getProvider(): Promise<SyncProvider> {
  const name = process.env.FRED_SYNC_PROVIDER ?? "monarch";
  switch (name) {
    case "fixture":
      return new FixtureProvider();
    case "monarch":
      return new MonarchProvider(await loadMonarchCredentials());
    default:
      throw new Error(`Unknown sync provider: ${name}`);
  }
}
