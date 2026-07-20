# The Household: unified account model & resolution design

Design for making account management coherent as sources multiply. Status:
**design approved-pending-review; not yet implemented.** Companion to
docs/SYNC.md (which covers the provider plumbing this builds on).

## The problem

Today `accounts` does double duty: it is both *Fred's statement data
container* (born from the spreadsheets, appended by the monthly close) and
*the de-facto canonical account list*. Monarch-only accounts (Kate's, joint,
liabilities) exist only as `external_accounts` rows with household settings
bolted onto them, linked by a single nullable pointer. Concretely, right now:
22 Fred accounts, 35 Monarch accounts, only 3 linked, 32 floating — and no
way to answer "what accounts does this household actually have?" in one
place. Each new source would make this quadratically worse.

## Core construct: accounts vs. evidence

**A household account is the canonical entity. A source record is never an
account — it is *evidence about* an account.**

- **The Household** is the top-level container. It has members (Scott, Kate)
  and household accounts.
- **Household account** (the hub): one row per real-world account. Identity
  (name, institution, category, owner, ownership share), inclusion flags,
  and resolution policy live here — and only here.
- **Sources** (the spokes): each data source's representation of that
  account. Facts (balances, transactions, flows, holdings) always stay with
  their source; the hub *resolves* them at read time.

**Fred's own statement entries are just another source** — call it
`statements`: seeded from the spreadsheets, appended by the monthly close.
This symmetry is what makes the model scale: `monarch` is a source,
`statements` is a source, a future Plaid/CSV import is a source. None of
them is special-cased in the model; they differ only in what domains they
can speak to and where they sit in priority order.

### The invariant that prevents double counting

Every source record is in **exactly one state**:

| State | Meaning | Counts in totals? |
|---|---|---|
| `linked` | attached to exactly one household account | via resolution only |
| `pending` | discovered, awaiting review | never |
| `ignored` | user said "not interesting" | never |

Nothing pending or ignored ever contributes to any number. A household
account may have many sources; a source belongs to at most one account. This
single rule is the whole dedup story, for any number of sources.

Lifecycle: `discovered → (auto-suggested) → linked | added-as-new | ignored`,
always user-revisable. Auto-matching (name/institution similarity, balance
proximity) only *suggests*; on first sight it may auto-link an unambiguous
match (current behavior) but marks it `auto` so the UI can show it was
machine-matched until confirmed.

## Resolution: per-domain priority, not a global winner

"Source of truth" is per **data domain**, because domains have natural
authorities — a global per-account winner would force wrong answers:

| Domain | What it is | Default priority | Why |
|---|---|---|---|
| `live_balance` | what it's worth now | `monarch → statements` | freshness wins; statements are month-end |
| `monthly_close` | curated month-end series, flows, growth/tax decomposition | `statements` only | by definition — no provider can decompose flows/tax character; Monarch verifies & prefills (existing features) |
| `transactions` | spending ledger | `monarch` | statements have none |
| `holdings` | positions | `monarch` | statements have none |
| `identity` | name, category, owner, shares | hub-owned (user) | defaulted from first source, then user-edited |

Resolution algorithm, per (account, domain, as-of):

1. Walk the priority list (account override → household default).
2. First source that **has data within its staleness window** wins.
3. Return a provenance object, never a bare number:
   `{ value, source, observedAt, alternatives: [{source, value, observedAt}] }`

The freshness fallback in step 2 is what makes configuration mostly
unnecessary: Kate's 401(k) has no statements source, so `monarch` wins
`live_balance` for it with zero setup; Scott's LM 401(k) statements would
win `monthly_close` because only they exist there. Overrides are for the
exceptional case ("this account's Monarch feed is broken — trust
statements"), not the norm.

**Conflicts**: when the winner and a losing source disagree beyond a
tolerance (±$1 today), that's not an error — it's the verification feature,
generalized. The UI shows a delta chip; the provenance object explains *why*
the winner won ("priority 1" or "priority 2, but priority 1 had no data
within 35 days"). Today's `/sync` verification table becomes a special case
of this.

## Data model (evolution, not revolution)

Promote the existing `accounts` table into the hub — it already carries the
identity fields — rather than inventing a third table:

```
accounts (= household accounts, the hub)
  + include_in_household boolean       -- household lens (independent of
                                          include_in_net_worth, the
                                          individual/Scott lens)
  + resolution jsonb null              -- per-domain priority override
  + liability categories               -- category gains: credit, loan
                                          (mortgage handled via property, below)
  (owner_person_id, is_joint, ownership_share already exist — they become
   authoritative here; the copies on external_accounts are deprecated)

external_accounts (spokes for synced providers)
  + match_status text                  -- 'auto' | 'confirmed' | 'pending' | 'ignored'
  linked_account_id                    -- unchanged: the spoke→hub pointer
  (owner/include/share columns stop being read; kept until a later cleanup)

statements source = implicit spoke     -- an accounts row "has" this source
                                          iff account_entries exist for it
```

Monarch-only accounts get **promoted**: accepting one from the review queue
creates a hub `accounts` row (no entries — that's fine, entries are a
separate table) and links the external row to it. After promotion, *every*
account in the household — Scott's, Kate's, joint, liabilities — is one
`accounts` row with 0..n sources. One list, one shape.

### The house and the mortgage

Fred already nets the mortgage inside the even-split equity convention
(equity = market value − loan, ÷2). So Monarch's mortgage account and
Zestimate must **not** enter the roster as independent accounts — that would
double count. Instead the property becomes a household account whose
evidence includes: the Fred property ledger (payments/valuations —
authoritative), Monarch's Zestimate (a valuation source to compare against
manual estimates), and Monarch's mortgage account (a loan-balance source to
verify the ledger's running balance). Same hub-and-spoke shape, just with
property-flavored domains (`market_value`, `loan_balance`). Phase 3+; until
then those two Monarch rows stay `ignored` with a note.

## The end-to-end experience

### `/household` (new page; absorbs `/accounts` and the account-management
half of `/sync`)

**Roster** — grouped by owner (Scott / Kate / Joint), then category. Each
account row shows:
- name, owner chip, category
- resolved current balance **with a provenance badge**: `Ⓜ today` or
  `📄 Jun 30` — hover/tap explains: *"Monarch, updated today, won
  live-balance priority. Statements: $22,273 (Jun 30) agrees ✓"*
- source chips: `📄 Statements ✓` `Ⓜ Monarch ✓auto` — the at-a-glance answer
  to "how do I know about this account?"
- state coloring: quiet when sources agree; amber delta chip when they
  disagree (`Δ $475.42`); "needs review" only in the queue, never silently
  in totals

**Review queue** — the inbox that makes onboarding any source routine:
> Monarch found **"Scott Brokerage (…5071)"** · $1,009,275 · Vanguard
> [Link to existing ▾] [Add to household] [Ignore]

ranked match suggestions attached. Today this queue would open with the 32
unlinked Monarch accounts — a one-time triage; afterward only genuinely new
accounts appear. Every future source lands in this same queue.

**Account detail** — identity (editable, hub-owned); sources table (each
source's latest value, as-of, match status, unlink); resolution panel
(default policy shown, drag-to-reorder override per domain); recent
conflicts with both values side by side.

### Everywhere else

- `/sync` shrinks to provider plumbing: connection status, run history,
  sync-now. Linking/ownership UI moves to `/household`.
- Dashboards gain a **lens toggle**: *My view* (today's individual behavior,
  unchanged) / *Household* (resolved roster, assets − liabilities). Every
  resolved number can carry the small provenance badge.
- Monthly close is untouched — it *is* the statements source's write path.

## Scaling story (the acceptance test for this design)

Adding source N+1 requires exactly:
1. implement `SyncProvider` (already the contract),
2. its accounts land in the review queue (no new UI),
3. append its source id to the default priority lists (one config entry).

No new tables, no new pages, no new concepts. If a proposed feature breaks
this property, it's the wrong feature shape.

## Migration plan (each phase shippable)

- **Phase 0 — schema + backfill** (small): add `match_status`,
  `include_in_household`, `resolution`; promote already-opted-in externals
  (Kate's 401(k)) to hub rows; move ownership fields to the hub; mark
  Zestimate/mortgage `ignored` with the property note.
- **Phase 1 — resolution engine**: `src/lib/resolution.ts` (priority +
  freshness fallback + provenance), household roster query, conflict
  computation generalizing `verificationDiffs`.
- **Phase 2 — `/household` UI**: roster, review queue (triage the 32),
  account detail, provenance badges; shrink `/sync`; retire `/accounts`
  into it.
- **Phase 3 — household analytics**: resolved household net-worth series,
  liabilities in totals, lens toggle on Overview, property-as-account.

## Open questions

1. **Liabilities**: include credit cards / auto loan in household net worth
   (assets − liabilities)? Presumably yes — and their transactions already
   sync, feeding future spending analytics.
2. **The house**: adopt property-as-household-account (Phase 3) or keep the
   current special-case indefinitely?
3. **Naming/navigation**: does `/household` replace `/accounts` outright
   (recommended), with `/accounts/[slug]` remaining as the statements-source
   detail view it already is?
4. **Default lens**: should Overview eventually default to Household with
   My-view as the filter, or stay individual-first? (No change until asked.)
