import { FixtureProvider } from "./fixture";
import { MonarchProvider } from "./monarch";
import type { SyncProvider } from "./types";

export type { ProviderAccount, ProviderHolding, ProviderTransaction, SyncProvider } from "./types";

// Provider selection is a single env switch so swapping the external system
// (or pointing dev at the fixture) never touches application code.
//   FRED_SYNC_PROVIDER = monarch (default) | fixture
export function getProvider(): SyncProvider {
  const name = process.env.FRED_SYNC_PROVIDER ?? "monarch";
  switch (name) {
    case "fixture":
      return new FixtureProvider();
    case "monarch":
      return new MonarchProvider();
    default:
      throw new Error(`Unknown sync provider: ${name}`);
  }
}
