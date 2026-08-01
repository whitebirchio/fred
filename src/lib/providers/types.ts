// Provider-agnostic sync contract. Every provider (Monarch today, anything
// tomorrow) translates its payloads into these shapes at the boundary; nothing
// outside src/lib/providers/ may depend on a provider's native format.

/** How much the provider's own plumbing can be trusted right now.
 *
 *  A balance is only as good as the connection that fetched it, and providers
 *  keep serving the last value they saw long after that connection breaks —
 *  silently, with no error anywhere in the sync. Carrying this alongside the
 *  balance is what lets resolution demote a source that has quietly stopped
 *  being a live feed:
 *    ok       — connected and syncing
 *    broken   — the provider says re-authentication is needed, or it lost its
 *               link to the institution; the balance is a fossil
 *    disabled — syncing deliberately turned off at the provider
 *    manual   — never was a live feed; a human types this value in at the
 *               provider, so staleness is expected rather than a fault */
export type ConnectionStatus = "ok" | "broken" | "disabled" | "manual";

export type ProviderAccount = {
  externalId: string;
  name: string;
  institution: string | null;
  /** Normalized type: checking | savings | brokerage | retirement | crypto |
   *  real_estate | mortgage | credit | loan | other */
  accountType: string;
  isAsset: boolean;
  balance: number;
  /** ISO date the *balance* was last refreshed at the source — NOT the time
   *  of the sync. Providers happily hand back months-old values, so this must
   *  come from the provider's own freshness field; defaulting it to "today"
   *  fabricates currency and silently disables every staleness rule
   *  downstream (see src/lib/household.ts). */
  balanceAsOf: string;
  isActive: boolean;
  connectionStatus: ConnectionStatus;
  /** When a broken connection last worked, if the provider says. */
  disconnectedAt?: string | null;
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
