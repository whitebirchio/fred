import type {
  ProviderAccount,
  ProviderHolding,
  ProviderTransaction,
  SyncProvider,
} from "./types";
import fixtureData from "../../../data/fixtures/provider-sample.json";

// Synthetic provider for tokenless development and pipeline testing: same
// contract as any real provider, backed by data/fixtures/provider-sample.json.
//
// Imported as a module rather than read via fs at request time: a runtime
// `fs.readFileSync` has no file to find once bundled into the deployed
// Worker (there's no filesystem there, only whatever the bundler inlined),
// so it 500'd instead of behaving like every other provider. A static
// `import` is a value the bundler can see and inline at build time, so it
// survives being deployed the same way any other imported constant does.

type FixtureFile = {
  accounts: (Omit<
    ProviderAccount,
    "balanceAsOf" | "raw" | "connectionStatus" | "disconnectedAt"
  > & {
    dailyBalances: { date: string; balance: number }[];
  })[];
  transactions: ProviderTransaction[];
  holdings: ProviderHolding[];
};

function load(): FixtureFile {
  return fixtureData as FixtureFile;
}

export class FixtureProvider implements SyncProvider {
  readonly name = "fixture";

  isConfigured(): boolean {
    return true;
  }

  async fetchAccounts(): Promise<ProviderAccount[]> {
    return load().accounts.map((a) => ({
      ...a,
      balanceAsOf:
        a.dailyBalances[a.dailyBalances.length - 1]?.date ??
        new Date().toISOString().slice(0, 10),
      // A synthetic feed is always healthy — the fixture exists to exercise
      // the pipeline, not to simulate broken institution connections.
      connectionStatus: "ok" as const,
      raw: { fixture: true },
    }));
  }

  async fetchTransactions(sinceISO: string): Promise<ProviderTransaction[]> {
    return load().transactions.filter((t) => t.date >= sinceISO);
  }

  async fetchHoldings(accountExternalIds: string[]): Promise<ProviderHolding[]> {
    return load().holdings.filter((h) =>
      accountExternalIds.includes(h.accountExternalId),
    );
  }
}
