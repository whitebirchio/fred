# External sync architecture (Monarch today, anything tomorrow)

Fred pulls household data from an external aggregator without marrying it.
Three design rules drive everything here:

1. **Encapsulation** — all provider-specific code lives in
   `src/lib/providers/`; the rest of the app sees only Fred's own normalized
   shapes. Swapping Monarch for another system means writing one new adapter.
2. **Statements stay the system of record.** Synced data verifies, prefills,
   and extends — it never overwrites `account_entries`.
3. **Idempotency** — every write is an upsert keyed by natural identity;
   re-running a sync converges instead of duplicating.

## The provider boundary

`src/lib/providers/types.ts` defines the contract:

```
SyncProvider
  isConfigured(): boolean
  fetchAccounts(): ProviderAccount[]        // + optional daily balances
  fetchTransactions(since): ProviderTransaction[]
  fetchHoldings(accountIds): ProviderHolding[]
```

Implementations:

- **`monarch.ts`** — speaks Monarch's *unofficial* GraphQL API (there is no
  official developer API as of July 2026; this mirrors the community
  `monarchmoney` libraries). Token auth via the `MONARCH_TOKEN` env var.
  Because the API is unofficial, operation shapes can drift — every Monarch
  detail is in this one file, holdings failures are non-fatal, and the first
  live run may need query tweaks here (and only here).
- **`fixture.ts`** — synthetic provider backed by
  `data/fixtures/provider-sample.json`, used for tokenless dev and pipeline
  tests. Includes deliberately matching + mismatching balances to exercise
  verification.

Selection is one env switch: `FRED_SYNC_PROVIDER=monarch` (default) or
`fixture`.

## Storage (all Fred-shaped)

| Table | Natural key | Notes |
|---|---|---|
| `external_accounts` | (provider, external_id) | link/owner/household fields are user-owned: set on first sight, never clobbered by later syncs |
| `balance_snapshots` | (external_account, date) | daily where available |
| `external_transactions` | (provider, external_id) | re-upserted each sync (edits/recategorization in the provider flow through) |
| `holdings` | (external_account, as_of, name) | point-in-time positions |
| `sync_runs` | — | audit trail: status + stats or error per run |

The provider's original payload is kept in `external_accounts.raw` as an
escape hatch only — application logic never reads it.

## Duplication vs addition (the authority rules)

- **Linked** external account (mapped to a Fred statement account — auto-
  matched by name on first sync, user-adjustable on `/sync`): duplicative by
  definition. Used for **verification** (statement balance vs provider
  snapshot on `/sync`) and **prefill** (synced month-end balance badge on the
  monthly close). Excluded from household additions.
- **Unlinked** external account (Kate's accounts, joint checking, Zestimate,
  mortgage): additive. Excluded from household totals **by default** — each
  must be explicitly opted in (with an ownership share) so nothing double
  counts silently. Note the house: Fred already counts even-split equity, so
  the Zestimate + mortgage accounts should stay opted out.
- Transactions/holdings exist only on the synced side — pure addition (the
  future spending analytics per docs/ROADMAP.md Part 2).

## Idempotency guarantees

`scripts/verify_sync.ts` runs two consecutive syncs and asserts convergence
(row counts identical on the second run). Incremental transaction fetches
overlap 30 days so late edits and pending→cleared flips reconcile via upsert.
Deletions in the provider are *not* propagated (rows keep `last_seen_at`; a
cleanup pass can use it later).

## Getting a Monarch token

Monarch has no API keys. The community-standard approach: log in once with
the [`monarchmoney` Python library](https://github.com/hammem/monarchmoney)
(supports MFA) and save the session token, or copy the `Token` from the web
app's requests. Set it as:

- local: `MONARCH_TOKEN=…` in `.env`
- deployed: `npx wrangler secret put MONARCH_TOKEN`

Then `/sync` → **Sync now**. A nightly Cloudflare cron trigger can automate
this later (free tier).
