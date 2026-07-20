import fs from "node:fs";
import path from "node:path";
import type {
  ProviderAccount,
  ProviderHolding,
  ProviderTransaction,
  SyncProvider,
} from "./types";

// Synthetic provider for tokenless development and pipeline testing: same
// contract as any real provider, backed by data/fixtures/provider-sample.json.

type FixtureFile = {
  accounts: (Omit<ProviderAccount, "balanceAsOf" | "raw"> & {
    dailyBalances: { date: string; balance: number }[];
  })[];
  transactions: ProviderTransaction[];
  holdings: ProviderHolding[];
};

function load(): FixtureFile {
  const file = path.join(process.cwd(), "data", "fixtures", "provider-sample.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as FixtureFile;
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
