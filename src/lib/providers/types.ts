// Provider-agnostic sync contract. Every provider (Monarch today, anything
// tomorrow) translates its payloads into these shapes at the boundary; nothing
// outside src/lib/providers/ may depend on a provider's native format.

export type ProviderAccount = {
  externalId: string;
  name: string;
  institution: string | null;
  /** Normalized type: checking | savings | brokerage | retirement | crypto |
   *  real_estate | mortgage | credit | loan | other */
  accountType: string;
  isAsset: boolean;
  balance: number;
  balanceAsOf: string; // ISO date
  isActive: boolean;
  /** Recent daily balances when the provider exposes them. */
  dailyBalances?: { date: string; balance: number }[];
  /** Original payload — stored as an escape hatch, never read by app logic. */
  raw?: unknown;
};

export type ProviderTransaction = {
  externalId: string;
  accountExternalId: string;
  date: string; // ISO date
  /** Negative = outflow/spending, positive = inflow. */
  amount: number;
  pending: boolean;
  merchant: string | null;
  category: string | null;
  categoryGroup: string | null;
  notes: string | null;
  tags: string[];
};

export type ProviderHolding = {
  accountExternalId: string;
  ticker: string | null;
  name: string;
  quantity: number | null;
  price: number | null;
  value: number;
};

export interface SyncProvider {
  readonly name: string;
  /** False when credentials/config are missing — sync UI explains why. */
  isConfigured(): boolean;
  fetchAccounts(): Promise<ProviderAccount[]>;
  fetchTransactions(sinceISO: string): Promise<ProviderTransaction[]>;
  /** May return [] when the provider can't attribute holdings. */
  fetchHoldings(accountExternalIds: string[]): Promise<ProviderHolding[]>;
}
