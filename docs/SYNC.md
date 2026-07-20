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

Monarch has no API keys, so there's no dashboard to visit — the token is the
session credential the web app itself uses, which you copy out once.

**Easiest path — browser DevTools (no Python, sidesteps MFA/CAPTCHA entirely
since you're just using the normal website):**

1. Go to [app.monarch.com](https://app.monarch.com) and log in as you
   normally would.
2. Open DevTools (`Cmd+Option+I` on Mac, `F12` elsewhere) → **Network** tab.
3. Click **Accounts** in the Monarch sidebar (or reload the page) to trigger
   some API calls.
4. Filter the Network tab for `graphql`, click any one of those POST
   requests, open its **Headers**, and find the request header
   `Authorization: Token xxxxxxxxxxxxxxxxxxxxxxxxxxxx`.
5. Copy everything **after** `Token ` — that string is `MONARCH_TOKEN`. Don't
   include the word `Token` or the leading space.

Set it as:

- local: `MONARCH_TOKEN=…` in `.env`
- deployed: `npx wrangler secret put MONARCH_TOKEN`

Then `/sync` → **Sync now**.

**Caveats:**
- This is a live session token, not an API key — it can expire (browser-
  extracted tokens are the shortest-lived of the available methods). If
  syncs start failing with `HTTP 401`/`403`, just repeat the steps above for
  a fresh one.
- Monarch's API host moved from `api.monarchmoney.com` to `api.monarch.com`
  at some point — `src/lib/providers/monarch.ts` already points at the
  current host, but if Monarch moves it again, that's the one line to check.
- For a longer-lived token, the community
  [`monarchmoney` Python library](https://github.com/hammem/monarchmoney) (or
  its more actively maintained forks,
  [`monarchmoneycommunity`](https://github.com/bradleyseanf/monarchmoneycommunity)
  and [`monarchmoney-enhanced`](https://github.com/keithah/monarchmoney-enhanced))
  supports a proper `interactive_login()` flow with MFA and session
  persistence — worth switching to if browser tokens expire too often to be
  worth the manual refresh. There's also a TypeScript port,
  [`monarchmoney-ts`](https://github.com/keithah/monarchmoney-ts) (npm
  package `monarchmoney`), which would fit Fred's stack directly if it's ever
  worth adding as a scripted login helper instead of the manual DevTools
  copy.

A nightly Cloudflare cron trigger can automate the sync call later (free
tier) — it can't automate re-obtaining the token itself, since that step
requires your login.
