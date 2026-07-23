# External sync architecture (Monarch today, anything tomorrow)

Fred pulls household data from an external aggregator without marrying it.
Three design rules drive everything here:

1. **Encapsulation** — all provider-specific code lives in
   `src/lib/providers/`; the rest of the app sees only Fred's own normalized
   shapes. Swapping Monarch for another system means writing one new adapter.
2. **Fred stays the system of record.** Synced data verifies, prefills, and
   extends — it never overwrites `account_entries`, the month-end record the
   monthly close owns.
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

Monarch doesn't document how long a token lasts, and real-world reports vary
wildly — anywhere from several months (with `trusted_device: true`, which
this always requests) down to a few hours for some users. So getting a token
needs to be routine, not an occasional chore.

### Keeping the token fresh — `npm run monarch:refresh`

```bash
npm run monarch:refresh
# Monarch email: you@example.com
# Monarch password (hidden): ********
# Multi-factor code (authenticator app or emailed code): 123456
#
# ✓ Token refreshed and pushed to https://fred.whitebirch.workers.dev.
# No further steps — the next sync will use it.
```

One command, run whenever `/sync` shows the token is stale or a sync starts
failing with `HTTP 401`/`403`. Your email and password are typed locally and
sent only to Monarch — exactly as before — but instead of printing the token
for you to copy into `.env` and `wrangler secret put` by hand, the script
pushes `{ token, deviceUuid }` straight to the running app over HTTPS
(`POST /api/monarch-credentials`), which stores it in the database
(`src/lib/monarch-credentials.ts`, keyed into the existing `app_config`
table). `getProvider()` reads it from there on every sync — no redeploy, no
Cloudflare secrets involved for routine refreshes.

**Why the database and not a Worker secret**: a Worker secret needs
`wrangler secret put` — a CLI command with your Cloudflare login — every
single refresh. Given how often this might need to happen, that overhead adds
up. The database is just application data the app already reads on every
request.

**Why the password still never touches the deployed app**: only the
*resulting token* is pushed, not your Monarch credentials. This keeps the
trust boundary identical to the original design — your password's only
destination is Monarch's own login endpoint, on your own machine.

**One-time setup** — the push needs to authenticate through Cloudflare
Access the same as everything else in Fred, so a script (not a person
clicking through a login page) needs a **service token**:

1. Zero Trust dashboard → **Access** → **Service Auth** → **Create Service
   Token** (name it e.g. `fred-monarch-refresh`).
2. Copy the **Client ID** and **Client Secret** — shown once.
3. Zero Trust → **Access** → **Applications** → the application protecting
   Fred → **Policies** → add a second policy: **Action: Allow**, rule type
   **Include** → **Service Token** → select the token you just created.
   (This is additive — your existing email-based policy for you and Kate is
   untouched; either policy matching lets a request through.)
4. In `.env`:
   ```bash
   CF_ACCESS_SERVICE_CLIENT_ID=<client id>
   CF_ACCESS_SERVICE_CLIENT_SECRET=<client secret>
   ```

Without this, `monarch:refresh` still works end-to-end locally
(`FRED_APP_URL` unset or pointed at `http://localhost:3000`, where Access
enforcement doesn't apply), and against the deployed app it fails closed —
Access rejects the push, and the script falls back to printing the raw
token/device UUID so you can fall back to the old manual path
(`wrangler secret put MONARCH_TOKEN` / `MONARCH_DEVICE_UUID` — the provider
checks those as a fallback if the database has no token). It never silently
does nothing.

**Caveats:**
- Monarch actively hardens the login endpoint against non-browser clients
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
- Monarch's API host moved from `api.monarchmoney.com` to `api.monarch.com`
  at some point — `src/lib/providers/monarch.ts` already points at the
  current host (confirmed against a live HAR capture), but if Monarch moves
  it again, that's the one line to check.
- `/sync` shows how stale the current token is ("refreshed 3d ago") so a
  looming expiry is visible before it causes a failed sync, not just after.

A nightly Cloudflare cron trigger can automate the sync call later (free
tier) — it can't automate re-obtaining the token itself, since that step
requires your login.
