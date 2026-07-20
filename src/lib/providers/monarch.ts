import type {
  ProviderAccount,
  ProviderHolding,
  ProviderTransaction,
  SyncProvider,
} from "./types";

// Monarch Money adapter.
//
// ⚠ Monarch has no official developer API (checked July 2026). This client
// speaks the same unofficial GraphQL API the Monarch web app uses, mirroring
// the community libraries (hammem/monarchmoney and forks). Operation names
// and shapes can drift without notice — which is exactly why every Monarch-
// specific detail lives in this one file behind the SyncProvider interface,
// each fetch degrades independently, and the rest of Fred only ever sees
// normalized shapes.
//
// Auth: a session token in the MONARCH_TOKEN env var — the raw value of the
// `Authorization: Token <this>` header the web app sends, either lifted from
// its Network tab or obtained via a community library's login flow. Never
// logged. See docs/SYNC.md for the step-by-step.
//
// Monarch migrated its API host from api.monarchmoney.com to api.monarch.com
// (observed July 2026); community forks that still point at the old host
// fail outright, so this is worth double-checking first if requests start
// erroring after a long gap between syncs.

const GRAPHQL_URL = "https://api.monarch.com/graphql";

const TYPE_MAP: Record<string, { type: string; isAsset: boolean }> = {
  depository: { type: "checking", isAsset: true },
  brokerage: { type: "brokerage", isAsset: true },
  retirement: { type: "retirement", isAsset: true },
  crypto: { type: "crypto", isAsset: true },
  real_estate: { type: "real_estate", isAsset: true },
  vehicle: { type: "other", isAsset: true },
  valuables: { type: "other", isAsset: true },
  loan: { type: "mortgage", isAsset: false },
  credit: { type: "credit", isAsset: false },
  other_asset: { type: "other", isAsset: true },
  other_liability: { type: "other", isAsset: false },
};

type GqlAccount = {
  id: string;
  displayName: string;
  currentBalance: number | null;
  displayBalance: number | null;
  isAsset: boolean;
  deactivatedAt: string | null;
  updatedAt: string;
  institution: { name: string } | null;
  type: { name: string } | null;
  subtype: { name: string } | null;
  recentBalances: (number | null)[] | null;
};

export class MonarchProvider implements SyncProvider {
  readonly name = "monarch";
  private token = process.env.MONARCH_TOKEN ?? "";
  // A stable device id the API's abuse layer expects. Any UUID works; set
  // MONARCH_DEVICE_UUID to reuse the one your login minted the token with.
  private deviceUuid =
    process.env.MONARCH_DEVICE_UUID ?? "00000000-0000-4000-8000-000000000000";

  isConfigured(): boolean {
    return this.token.length > 0;
  }

  private async gql<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    // Token auth (not the web app's cookie+CSRF): API clients send
    // `Authorization: Token …`. The device-uuid and monarch-client headers
    // mirror the real client so the request isn't rejected as non-browser
    // traffic; no x-csrftoken is needed because token auth isn't CSRF-guarded.
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${this.token}`,
        "Client-Platform": "web",
        "device-uuid": this.deviceUuid,
        "monarch-client": "monarch-core-web-app-graphql",
        Origin: "https://app.monarch.com",
        Referer: "https://app.monarch.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ operationName, query, variables }),
    });
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? " (token missing/expired/rejected — mint a fresh MONARCH_TOKEN with `npm run monarch:login`, see docs/SYNC.md)"
          : "";
      throw new Error(`Monarch ${operationName} failed: HTTP ${res.status}${hint}`);
    }
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new Error(`Monarch ${operationName}: ${body.errors[0].message}`);
    }
    if (!body.data) throw new Error(`Monarch ${operationName}: empty response`);
    return body.data;
  }

  async fetchAccounts(): Promise<ProviderAccount[]> {
    const data = await this.gql<{ accounts: GqlAccount[] }>(
      "GetAccounts",
      `query GetAccounts {
        accounts {
          id
          displayName
          currentBalance
          displayBalance
          isAsset
          deactivatedAt
          updatedAt
          institution { name }
          type { name }
          subtype { name }
          recentBalances
        }
      }`,
    );
    const today = new Date().toISOString().slice(0, 10);
    return data.accounts.map((a) => {
      const mapped = TYPE_MAP[a.type?.name ?? ""] ?? {
        type: a.type?.name ?? "other",
        isAsset: a.isAsset,
      };
      // recentBalances is a trailing daily array ending today (no dates on
      // the wire); reconstruct dates by index.
      const daily = (a.recentBalances ?? [])
        .map((balance, i, arr) => {
          if (balance == null) return null;
          const d = new Date();
          d.setUTCDate(d.getUTCDate() - (arr.length - 1 - i));
          return { date: d.toISOString().slice(0, 10), balance };
        })
        .filter((x): x is { date: string; balance: number } => x !== null);
      return {
        externalId: a.id,
        name: a.displayName,
        institution: a.institution?.name ?? null,
        accountType: mapped.type,
        isAsset: a.isAsset ?? mapped.isAsset,
        balance: a.displayBalance ?? a.currentBalance ?? 0,
        balanceAsOf: today,
        isActive: !a.deactivatedAt,
        dailyBalances: daily,
        raw: a,
      };
    });
  }

  async fetchTransactions(sinceISO: string): Promise<ProviderTransaction[]> {
    type Row = {
      id: string;
      date: string;
      amount: number;
      pending: boolean;
      notes: string | null;
      merchant: { name: string } | null;
      category: { name: string; group: { name: string } | null } | null;
      account: { id: string };
      tags: { name: string }[];
    };
    const out: ProviderTransaction[] = [];
    const limit = 100;
    for (let offset = 0; offset < 5000; offset += limit) {
      // Shape mirrors the web app's own Common_GetTransactionsListDashboard
      // operation (captured from a live session). Two details matter and both
      // return HTTP 400 if got wrong: pagination args belong ONLY on the
      // nested `results(...)` field — `allTransactions` itself takes just
      // `filters` — and the filter object accepts only real
      // TransactionFilterInput keys (startDate/endDate/transactionVisibility;
      // an invented `search: ""` is rejected).
      const data = await this.gql<{
        allTransactions: { totalCount: number; results: Row[] };
      }>(
        "GetTransactionsList",
        `query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput) {
          allTransactions(filters: $filters) {
            totalCount
            results(offset: $offset, limit: $limit) {
              id
              date
              amount
              pending
              notes
              merchant { name }
              category { name group { name } }
              account { id }
              tags { name }
              __typename
            }
            __typename
          }
        }`,
        {
          offset,
          limit,
          filters: {
            startDate: sinceISO,
            transactionVisibility: "non_hidden_transactions_only",
          },
        },
      );
      const rows = data.allTransactions.results;
      for (const r of rows) {
        out.push({
          externalId: r.id,
          accountExternalId: r.account.id,
          date: r.date,
          amount: r.amount,
          pending: r.pending,
          merchant: r.merchant?.name ?? null,
          category: r.category?.name ?? null,
          categoryGroup: r.category?.group?.name ?? null,
          notes: r.notes,
          tags: r.tags.map((t) => t.name),
        });
      }
      if (rows.length < limit) break;
    }
    return out;
  }

  async fetchHoldings(accountExternalIds: string[]): Promise<ProviderHolding[]> {
    // Holdings shapes drift the most; failure here must not sink a sync.
    try {
      // `aggregateHoldings` groups one security across accounts, so the
      // account lives on the nested per-account `holdings` rows — not on the
      // aggregate node itself (selecting `account` there is what previously
      // returned HTTP 400). Each nested row carries its own quantity/value,
      // so flattening them attributes positions to the right account instead
      // of dumping an aggregate onto whichever account happened to be first
      // — which matters here: some securities really are held in more than
      // one account.
      type Node = {
        security: {
          ticker: string | null;
          name: string | null;
          currentPrice: number | null;
        } | null;
        holdings:
          | {
              id: string;
              quantity: number | null;
              value: number | null;
              account: { id: string } | null;
            }[]
          | null;
      };
      const data = await this.gql<{
        portfolio: { aggregateHoldings: { edges: { node: Node }[] } };
      }>(
        "Web_GetHoldings",
        `query Web_GetHoldings($input: PortfolioInput) {
          portfolio(input: $input) {
            aggregateHoldings {
              edges {
                node {
                  security { ticker name currentPrice }
                  holdings {
                    id
                    quantity
                    value
                    account { id }
                  }
                  __typename
                }
                __typename
              }
              __typename
            }
            __typename
          }
        }`,
        { input: {} },
      );

      const wanted = new Set(accountExternalIds);
      const out: ProviderHolding[] = [];
      for (const { node } of data.portfolio.aggregateHoldings.edges) {
        for (const h of node.holdings ?? []) {
          const accountId = h.account?.id;
          if (!accountId || !wanted.has(accountId)) continue;
          out.push({
            accountExternalId: accountId,
            ticker: node.security?.ticker ?? null,
            name: node.security?.name ?? node.security?.ticker ?? "Unknown",
            quantity: h.quantity,
            price: node.security?.currentPrice ?? null,
            value: h.value ?? 0,
          });
        }
      }
      return out;
    } catch (err) {
      console.warn("Monarch holdings fetch failed (non-fatal):", err);
      return [];
    }
  }
}
