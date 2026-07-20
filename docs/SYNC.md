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

## When a Monarch operation drifts

Monarch's API is unofficial, so an operation can start returning HTTP 400
without notice. The engine is built to survive that: **accounts are fatal**
(everything else keys off them), but **transactions and holdings each degrade
independently** — a broken one records a warning, leaves the rest of the sync
intact, and marks the run `partial` (surfaced on `/sync`) rather than
discarding a good pull. `scripts/verify_sync_partial.ts` guards that behavior.

To diagnose and fix drift:

1. `npm run monarch:probe` — read-only; exercises each operation against the
   live API and reports which one broke, without touching the database.
2. Compare the failing query in `src/lib/providers/monarch.ts` against what
   the real web app sends: open app.monarch.com with DevTools → Network,
   filter `graphql`, and read the `postData` of the matching operation (or
   export a HAR). The web app's own query is ground truth for field names and
   argument placement.
3. Fix the query in that one file and re-probe.

Two real examples, both HTTP 400, both fixed this way:

- **Transactions**: pagination args were passed to `allTransactions(...)`,
  but the schema only accepts them on the nested `results(...)` field — plus
  an invented `search: ""` filter key that doesn't exist.
- **Holdings**: `account { id }` was selected on the aggregate node, but
  `aggregateHoldings` groups a security *across* accounts, so the account
  lives on the nested per-account `holdings` rows. Those rows also carry
  their own `quantity`/`value`, which is what makes per-account attribution
  correct when a security is held in more than one account.

`npm run sync:state` prints current row counts and recent run statuses.

## Idempotency guarantees

`scripts/verify_sync.ts` runs two consecutive syncs and asserts convergence
(row counts identical on the second run). Incremental transaction fetches
overlap 30 days so late edits and pending→cleared flips reconcile via upsert.
Deletions in the provider are *not* propagated (rows keep `last_seen_at`; a
cleanup pass can use it later).

## Getting a Monarch token

Monarch has no API keys, so there's no dashboard to visit. It's also **not**
a bearer token you can lift from the browser's Network tab — confirmed by
inspecting a real session's HAR export: the web app (`app.monarch.com`)
authenticates every GraphQL call with an **httpOnly session cookie plus a
`x-csrftoken` header**, not an `Authorization` header. That cookie can't be
copied out through DevTools (httpOnly means JavaScript-and-Network-tab
invisible by design), so there is no "find the request, copy the header"
shortcut here — an earlier version of this doc said otherwise and was wrong.

The token this adapter uses (`Authorization: Token <value>`) is a **separate,
parallel auth path** Monarch's backend also accepts, meant for API-style
clients rather than the browser. The only way to obtain one is to submit
credentials to Monarch's login endpoint yourself, the same way the
`monarchmoney` Python library does it.

**`npm run monarch:login`** does exactly that — prompts for your email and
password locally (hidden input), POSTs to Monarch's login endpoint with
`trusted_device: true` for a long-lived token, handles an MFA prompt if one
comes back, and prints the token plus the device UUID it was minted with.
Nothing is stored or sent anywhere but Monarch.

```bash
npm run monarch:login
# Monarch email: you@example.com
# Monarch password (hidden): ********
# Multi-factor code (authenticator app or emailed code): 123456
#
# ✓ Success. Add these to .env:
#
# MONARCH_TOKEN=…
# MONARCH_DEVICE_UUID=…
```

Set both as:

- local: in `.env`
- deployed: `npx wrangler secret put MONARCH_TOKEN` and
  `npx wrangler secret put MONARCH_DEVICE_UUID`

Then `/sync` → **Sync now**.

**Caveats:**
- Monarch actively hardens this login endpoint against non-browser clients
  (CAPTCHA/reCAPTCHA challenges, header fingerprinting) — the script mirrors
  the real client's headers (`device-uuid`, `monarch-client`, `Origin`,
  `User-Agent`) to reduce friction, but if it still gets blocked, it prints
  Monarch's raw response so the payload can be adjusted, and falling back to
  the community
  [`monarchmoney` Python library](https://github.com/hammem/monarchmoney)
  (`interactive_login()`, actively maintained forks:
  [`monarchmoneycommunity`](https://github.com/bradleyseanf/monarchmoneycommunity),
  [`monarchmoney-enhanced`](https://github.com/keithah/monarchmoney-enhanced))
  or its TypeScript port
  [`monarchmoney-ts`](https://github.com/keithah/monarchmoney-ts) is the
  documented escape hatch — any of them mint a token usable here the same way.
- The token can still expire; if syncs start failing with `HTTP 401`/`403`,
  re-run `npm run monarch:login` for a fresh one (`MONARCH_TOKEN` in the
  error message points back here).
- Monarch's API host moved from `api.monarchmoney.com` to `api.monarch.com`
  at some point — `src/lib/providers/monarch.ts` already points at the
  current host (confirmed against a live HAR capture), but if Monarch moves
  it again, that's the one line to check.

A nightly Cloudflare cron trigger can automate the sync call later (free
tier) — it can't automate re-obtaining the token itself, since that step
requires your login.
