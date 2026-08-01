# The Household: unified account model & resolution design

Design for making account management coherent as sources multiply. Status:
**Phases 0–2 shipped (2026-07-20); Phase 3 pending.** Companion to
docs/SYNC.md (which covers the provider plumbing this builds on).

**What's live:** the hub/spoke schema, the resolution engine with provenance
(`src/lib/household.ts`), and a redesigned `/household` page.

**UX redesign (2026-07-20, after the first cut tested poorly).** The first
version was technically correct but failed as an experience: it opened on a
31-row wall of dropdowns (a chore, not your household), split one conceptual
list into "review queue" vs "roster" purely because a `match_status` column
exists, never actually *showed* a duplicate being resolved, and spoke in
model vocabulary ("sources", "provenance", "match status"). The reframe:
this is the **merge-duplicate-contacts problem**, and that UX is solved.
Three choices set the direction:

1. **Group by institution.** Duplicates cluster by institution, so
   mismatches jump out; `canonicalizeInstitution` collapses "Ally Bank"/
   "Ally" and "Fidelity"/"Fidelity NetBenefits" onto one heading so an
   account and its synced twin always land together. Each group carries a
   subtotal.
2. **Auto-merge the unmistakable, review the rest.** `autoMatchConfident()`
   links only when the single best match scores ≥ 90 (same institution +
   shared distinctive token + balance within 2%) *and* no runner-up also
   clears the bar. On the real backlog this collapsed 31 decisions to 26 by
   auto-linking 5 Vanguard accounts, and correctly *declined* the genuinely
   ambiguous ones (Scott's 401(k)→LM at 70 — same account, but the
   institution reads "Fidelity" vs "LM"; the Ally pairs at 80). Runs after
   every sync so the queue never rebuilds. Fully reversible: auto-matched
   rows are tagged in the roster with an `undo`.
3. **Guided review, one at a time.** A single focused card per decision with
   the comparison inline and plain-language answers ("Yes, same account" /
   "No — it's a new account" / "Ignore"), plus skip, back, and a "Show all"
   escape hatch. Two card variants: a *match* question when there's a
   candidate, an *add* question when there isn't.

**Making the merge visible** was the other half of the fix. Expanding any
account row shows each source record side by side with its own value and
date, which one is `shown`, the reason it won, and `undo` — so a resolved
duplicate is legible rather than an invisible collapse:

```
Ⓕ Fred  as of 2026-05-31                              $1,022,415
Ⓜ Monarch (Scott Brokerage …5071)  as of 2026-07-20   $1,009,275  shown  undo
Monarch is the highest-priority source for this data and is current (1d old).
```

A **connectivity badge** on every row answers "what exists and how does it
relate across sources" at a glance: `Ⓕ + Ⓜ` (both), `Ⓜ Monarch` (synced
only), `Ⓕ only` (no live feed). Vocabulary is plain throughout; the
model's terms stay in the code.

`/accounts` (the list) redirects here; `/accounts/[slug]` remains the
single-account detail view. **Not yet built (Phase 3):** household net-worth
*series* over time, property-as-account on `/house`, and retiring the
deprecated ownership columns on `external_accounts`.

## The problem

Today `accounts` does double duty: it is both *Fred's statement data
container* (seeded once, appended by the monthly close) and
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

**Fred's own month-end entries are just another source** — call it `fred`:
bootstrapped once (docs/SEED.md), appended by the monthly close from then on.
This symmetry is what makes the model scale: `monarch` is a source, `fred` is
a source, a future Plaid/CSV import is a source. None of
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
| `live_balance` | what it's worth now | `monarch → fred` | freshness wins; Fred's entries are month-end |
| `monthly_close` | curated month-end series, flows, growth/tax decomposition | `fred` only | by definition — no provider can decompose flows/tax character; Monarch verifies & prefills (existing features) |
| `transactions` | spending ledger | `monarch` | Fred has none |
| `holdings` | positions | `monarch` | Fred has none |
| `identity` | name, category, owner, shares | hub-owned (user) | defaulted from first source, then user-edited |

Resolution algorithm, per (account, domain, as-of):

1. Walk the priority list (account override → household default).
2. First source that **has data within its staleness window** wins.
3. Return a provenance object, never a bare number:
   `{ value, source, observedAt, alternatives: [{source, value, observedAt}] }`

The freshness fallback in step 2 is what makes configuration mostly
unnecessary: Kate's 401(k) has no `fred` source, so `monarch` wins
`live_balance` for it with zero setup; Scott's LM 401(k) entries would
win `monthly_close` because only they exist there. Overrides are for the
exceptional case ("this account's Monarch feed is broken — trust
Fred's own close"), not the norm.

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

fred source = implicit spoke           -- an accounts row "has" this source
                                          iff account_entries exist for it
```

Monarch-only accounts get **promoted**: accepting one from the review queue
creates a hub `accounts` row (no entries — that's fine, entries are a
separate table) and links the external row to it. After promotion, *every*
account in the household — Scott's, Kate's, joint, liabilities — is one
`accounts` row with 0..n sources. One list, one shape.

### The house and the mortgage

> **Superseded by Phase 3 (2026-08-01).** The house is now a real household
> account backed by the property ledger, and the mortgage is a normal
> liability account; both carry `exclusion = 'primary_residence'` so the pair
> is held out of net worth *together*. See "Phase 3" below for why the
> original approach was abandoned. The paragraph below is kept as the record
> of what was believed at the time.

Fred already nets the mortgage inside the even-split equity convention
(equity = market value − loan, ÷2). So Monarch's mortgage account and
Zestimate must **not** enter the roster as independent accounts — that would
double count. Per decision 2 the primary residence stays a permanently
special category with its own `/house` page, reported as a distinct line
rather than blended into the account roster. Those two Monarch rows are
therefore `ignored`, with a note recording *why* (not "uninteresting" —
"already represented by the property ledger"). The Zestimate may later feed
the property ledger as a valuation source; that is a `/house` feature, not a
roster one.

## The end-to-end experience

> Historical: this was the original Phase-2 proposal. The shipped page groups
> by **institution** rather than owner, and replaces the review *queue* with
> guided one-at-a-time review — see the UX redesign notes at the top. The
> model and resolution rules below are unchanged.

### `/household` (new page; absorbs `/accounts` and the account-management
half of `/sync`)

**Roster** — grouped by owner (Scott / Kate / Joint), then category. Each
account row shows:
- name, owner chip, category
- resolved current balance **with a provenance badge**: `Ⓜ today` or
  `Ⓕ Jun 30` — hover/tap explains: *"Monarch, updated today, won
  live-balance priority. Fred: $22,273 (Jun 30) agrees ✓"*
- source chips: `Ⓕ Fred ✓` `Ⓜ Monarch ✓auto` — the at-a-glance answer
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
- Monthly close is untouched — it *is* the `fred` source's write path.

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

## Decisions (2026-07-20)

1. **Liabilities are in.** Credit cards, auto loans and similar count toward
   household net worth (assets − liabilities). Categories `credit` and `loan`
   added; liabilities are stored as positive magnitudes with the sign applied
   at rollup, so a card balance never accidentally reads as an asset.

2. **The house stays special — permanently, not just until Phase 3.** The
   rationale is structural, not stylistic: *you always need somewhere to
   live*, so primary-residence equity is not fungible with investable assets
   and shouldn't sit beside them in a roster or blend into a single net-worth
   number. It stays its own category with its own page, reported as a
   distinct line (this is already why `/plan` excludes it from FI assets —
   you cannot spend your house). Monarch's Zestimate and mortgage rows are
   therefore `ignored` in the roster: the property ledger already nets the
   loan inside even-split equity, so admitting them would double count.
   *Future investment properties are a different case* — those are genuine
   portfolio assets and would join the roster as normal accounts; the
   distinction to encode is primary-residence vs. investment property, not
   house vs. not-house.

3. **`/household` replaces `/accounts` outright.** `/accounts/[slug]`
   survives as the detail view for a single account.

4. **Default lens: everything, then slice.** Rather than a binary
   My-view/Household toggle, the default is the full household and the user
   narrows it — by owner, category, or individual account — with every
   number recomputing against the current selection. "My view" becomes just
   a saved filter (owner = Scott), not a separate mode.

   **Safety exception:** *unreviewed* sources are never included, regardless
   of the everything-by-default rule. This is what prevents double counting
   while the review queue is worked — several Monarch accounts clearly
   duplicate existing Fred accounts without auto-matching (e.g. Monarch
   "Scott 401(k) (…7830)" ≈ Fred "LM 401(k)"), so silently counting all 32
   unlinked rows would inflate net worth by roughly a million dollars.
   Reviewed → included by default; pending → excluded and visibly flagged.

## Phase 3 — one calculation, every screen (shipped 2026-08-01)

The symptom: net worth on `/household` disagreed with net worth on Overview.
The cause was not a bug in either — they were computing **different things**,
and both were defensible in isolation:

| | Overview | `/household` |
|---|---|---|
| Membership | `include_in_net_worth` (19 of 35) | `include_in_household` (35 of 35) |
| Balances | Fred month-end entries, carried forward | live resolved (Monarch preferred) |
| Liabilities | none (all flagged out) | counted, signed |
| House | ½ equity from the ledger | absent — but the mortgage was counted |

They happened to land $12k apart, which made the disagreement look like a
rounding problem rather than two different questions. Three real defects hid
underneath:

1. **`/household` counted the mortgage but had no house.** Net worth was
   short an entire asset while carrying its debt.
2. **`portfolioSeries` added liabilities positively.** Latent only because
   every liability happened to be filtered out of that view.
3. **`include_in_net_worth` meant two things at once** — "isn't Scott's"
   *and* "deliberately excluded" — so ownership and exclusion could not be
   varied independently.

### What replaced it

**One rollup.** `rollup()` in `src/lib/household.ts` computes every
net-worth, asset and liability figure in the app, over the resolved balances
from `loadHousehold()`. No page computes a total of its own. This is the
structural guarantee: two screens can only disagree if they compute
separately, so nothing else is permitted to.

**Scope, not lenses.** A single cookie-backed selector (`src/lib/scope.ts`,
read server-side in the root layout) chooses whose money is on screen:
Everyone, a person, or Joint. Everyone counts everything at 100%; a person
counts their own accounts whole plus `ownership_share` of anything joint.
Because joint accounts split evenly, **the per-person totals sum exactly to
the household total** — an invariant `scripts/verify_consistency.ts` asserts,
and the thing that makes the filter trustworthy rather than merely
suggestive.

**Exclusion is one column with a reason.** `accounts.exclusion` is null when
an account counts, else says why (`primary_residence`, `unvested`, `other`).
Ownership lives entirely in `owner_person_id` / `is_joint` /
`ownership_share`. `include_in_net_worth` and `include_in_household` are
retained but no longer read.

**The house is an account again — and excluded by default.** Reversing the
Phase-0 decision: modelling the home as "not an account" is what left the
roster showing a mortgage with nothing behind it. It is now an `accounts` row
with `property_id` pointing at the ledger that supplies its value, and the
mortgage is a normal liability with a second `fred` source from the same
ledger. Both carry `exclusion = 'primary_residence'`, so the default net
worth omits **the equity**, not just the asset — you always need somewhere to
live, and counting the debt without the house would be more pessimistic than
intended, not less. One toggle includes the pair for when the property
becomes an investment. The old "permanently special category" conclusion was
right about the *economics* and wrong about the *modelling*.

**Balances live, flows month-end.** Current-value figures resolve as of
today; charts, savings, growth and tax lots come from the monthly close.
Balance-only accounts (Kate's, the liabilities) contribute balances
everywhere and flows nowhere, and the pages that depend on flows say so
rather than implying those accounts grew by zero. `tracks_monthly_close`
keeps them out of the close checklist.

**Closed means zero.** An inactive account contributes nothing to today's
totals; its history is untouched. This required correcting three accounts
that had been marked inactive to mean "I don't use this much" while still
holding money.

### The freshness bug this uncovered

The resolution engine's staleness fallback — the mechanism that demotes a
stale source — **had never once fired.** `MonarchProvider.fetchAccounts()`
set `balanceAsOf` to *today* for every account unconditionally, so every
Monarch observation claimed to be 0 days old and always won priority. The UI
rendered "Monarch is the highest-priority source and is current (0d old)" on
data that was months stale.

Monarch exposes the real signal, and it is not `updatedAt` (which moves when
any field changes): **`displayLastUpdatedAt`** is when the balance was last
refreshed. Verified against the live API — the HSA investments row reported
`updatedAt` 90d but `displayLastUpdatedAt` 277d, and 277d was the truth.
`credential.updateRequired` gives the categorical version: this connection
is broken, go re-authenticate. Both are now captured
(`external_accounts.connection_status`), a broken feed can never win on
freshness however recent its timestamp claims to be, and the reason strings
name the loser and why ("Monarch lost its connection to this institution on
… and needs reconnecting").

Effect on real data: LM Pension moved from Monarch's stale $67,304 to Fred's
$72,410, I-Bonds likewise, and Kate's 401(k) — which has no Fred source —
stopped claiming to be current and now reports honestly that its connection
is broken.

### Guarding it

`scripts/verify_consistency.ts` re-derives each page's headline the way that
page derives it and asserts they match, plus the invariants above: scope
shares summing to the whole, the home pair moving together, liabilities
signed, closed accounts at zero, and every investable dollar landing in a tax
bucket. Run it after any change to resolution or rollup.

## Open questions

- Does the primary-residence-vs-investment-property distinction want an
  explicit flag now, or wait until an investment property actually exists?
  (Partly answered: `exclusion = 'primary_residence'` *is* that flag — an
  investment property would simply carry no exclusion.)
- Monarch's `displayLastUpdatedAt` is trusted as balance freshness. If it
  ever proves to move for non-balance reasons, `credential.updateRequired`
  is the more conservative signal to lean on.
