# Roadmap: thinking beyond the spreadsheets

The spreadsheets answer *"what happened to my accounts?"* An advisor asks
three more questions: *"are you on track?"*, *"are you efficient?"*, and
*"what would change the outcome?"* This document maps those questions onto
data Fred already has, data Monarch has, and what to build. Items are marked
as they ship (1.1 v1 and the 1.2 data model are done).

## Part 1 — Advisor-grade analyses on data Fred already has

### 1.1 Financial independence projection (the marquee feature)
**Status: v1 shipped (2026-07-19)** as `/plan` — FI target from spending ÷ SWR,
live-adjustable assumptions persisted to app config, three deterministic
return scenarios, coast-FI date, spendable (after-tax) framing. Future: Monte
Carlo bands, retirement-age anchoring, spending inferred from Monarch.

The Analysis sheet had rows pre-dated through 2033 — the appetite for
projection is already there; the sheet just never computed it. Fred has the
three inputs an advisor needs: net-worth level, monthly savings cadence, and
16 years of realized growth. Build a projection page:
- FI target = annual spending × 25 (spending estimated from withdrawal
  history until Monarch provides real household spend).
- Fan chart: deterministic bands at conservative/expected/optimistic real
  returns, overlaid on actuals; FI date, coast-FI date ("stop contributing
  today, still retire at X").
- Every assumption is a visible, adjustable slider — never hidden math.

### 1.2 Tax-bucket diversification
**Correction (2026-07-19):** an earlier draft called Roth "a ~$20k sliver."
That was an artifact of the data model, not reality — `accounts.tax_treatment`
is one enum per account, so the whole LM 401(k) got labeled "traditional"
even though its columns track Roth / Traditional / After-Tax / Company
separately. A tax-lot simulation of the combined 401(k) (LM+HS merged,
internal rollovers treated as pass-through, each month's growth allocated
proportionally to the running sub-balances) gives the real split:

| Bucket | Amount | Share of NW |
|---|---:|---:|
| Taxable (brokerage/cash/crypto) | ~$1,197,000 | ~50% |
| Pre-tax (401k pre-tax $434k + Trad IRA $222k + SEP $19k + Pension $72k) | ~$747,000 | ~31% |
| **Roth** (401k Roth ~$217k + Roth IRA $20k) | **~$237,000** | ~10% |
| House equity (even split) | ~$186,000 | ~8% |
| HSA | ~$34,000 | ~1.4% |
| After-tax 401(k) basis | ~$2,400 | ~0.1% |

Within **retirement accounts alone** the split is ~76% pre-tax / **~24% Roth** —
a healthy Roth base, not a sliver. And half of net worth sits in a taxable
brokerage, which for *early* retirement is the best bucket to have (accessible
before 59½, long-term cap-gains rates, step-up at death). So the honest
headline is: this portfolio is already well-diversified across tax
treatments and well-positioned for FI.

What's still genuinely useful to build here (optimization, not rescue):
- **Model the four buckets over time** using the tax-lot engine above, and
  project pre-tax RMDs so the future-tax drag is visible, not a surprise.
- **Roth-conversion / contribution-mix analysis in low-income years.** The
  paystub data pins exact YTD taxable income, so Fred can show bracket
  headroom each year; the sabbatical gaps between jobs were real conversion
  windows. At a $225k salary the *current* pre-tax-vs-Roth contribution
  choice is a live question too (deduct now at a high marginal rate vs pay
  now for tax-free growth) — Fred should surface the trade-off and the
  assumptions behind it, not issue a verdict. (Not licensed tax advice;
  present the numbers and let Scott / a CPA decide.)
- After-Tax 401(k) column → mega-backdoor Roth tracking if/when the plan
  allows in-plan conversion.

**Data-model implication — implemented (2026-07-19):** tax treatment is now a
per-contribution dimension: `account_entries` carries
`contributions_pretax` / `contributions_roth` / `contributions_after_tax`
(plus employer), and `accounts.tax_lot_group` marks plan lineages (LM+HS
401(k)) whose intra-group rollovers are internal. `src/lib/taxlots.ts`
simulates monthly tax lots (proportional growth allocation, rescaled to tie
out to statement balances, residuals surfaced as drift) and powers the
`/plan` page's bucket views and the after-tax FI projection.

### 1.3 Honest savings-rate triangulation
The sheet metric (savings ÷ contributions) measures retention of money that
reached accounts. Advisors benchmark against income. Fred has both sides, so
show three rates and reconcile them: gross (÷ total income), net (÷ take-home),
and the existing sheet metric — plus a full personal P&L waterfall:
gross income → taxes → payroll deductions → net → spending → saved.

### 1.4 Personal rate of return & benchmarking
Monthly balances + flows per account are exactly what's needed for
money-weighted (IRR) and time-weighted returns — per account and in total.
Compare against a benchmark blend (e.g. S&P 500 / AGG). This turns "Growth"
from a number into a verdict: is the Vanguard brokerage earning its keep? Did
the Robinhood/Alpaca/TD experiments cost anything? (ETH: −$2.8k realized
lesson, already in the data.)

### 1.5 Cash strategy
$139k (5.8%) sits in cash. Advisor treatment:
- Emergency-fund gauge: months of spend covered (spend from Monarch).
- Purpose tags for cash buckets (the $99.5k Vanguard Cash Plus — earmarked or
  drag?).
- Implied-yield monitor: interest entries ÷ balance per cash account, with a
  flag when a balance earns under a threshold APY.

### 1.6 Housing decisions
Derivable from the ledger: implied mortgage rate (~2.9% — an advisor would
say *never prepay this*), interest vs principal cumulative, equity share of
net worth (7.7% — healthy). Build: payoff-vs-invest calculator and a
valuation-staleness nudge.

### 1.7 Contribution-limit autopilot (extend what exists)
The 401(k) planner is live; generalize it: HSA and IRA limits, I-Bond annual
cap, pace alerts ("current per-check rate finishes $3.6k under the cap"),
and catch-up limits when age-eligible.

### 1.8 Alerts as a first-class feature (the "advisor who calls you")
Monthly close diffs already surface everything needed: growth outliers vs
benchmark, missed expected contributions, salary/bonus changes detected in
paychecks, stale accounts (BECU, BTC), valuation staleness, savings-rate
regression. A small rules engine + a notifications panel (and later, email
via a Workers cron) covers it.

### 1.9 Scenario sandbox
Four job changes, two sabbaticals — life events are the norm in this data.
Sliders against the projection: job change / sabbatical year, market −30%,
sell the house, Kate income change, one-time windfall.

### 1.10 Protection checklist (advisor hygiene, minimal data)
Paystubs show GTL/LTD lines. Track: life-insurance multiple of income,
disability coverage, umbrella policy (net worth > $2M argues for one),
beneficiary designations per account (a column Fred can store), estate docs.
Mostly manual attestations with annual reminders — low tech, high value.

## Part 2 — Monarch integration

### What Monarch holds (its data model, independent of current API access)
- **Accounts** with institution-synced live balances (incl. Kate's + joint)
- **Balance snapshots** / net-worth history per account
- **Transactions**: date, merchant, amount, category, tags, notes
- **Categories & groups**, **budgets** (planned vs actual), monthly summaries
- **Investment holdings**: positions, tickers, quantities, prices
- **Recurring items** detected from transactions

### Division of authority (the redundancy rule)
One number, one source — every metric declares its lineage:

| Domain | System of record | The other side's role |
|---|---|---|
| Monthly flow decomposition (contrib/growth/transfer/withdrawal) | **Fred** statements | Monarch can't decompose this reliably — never overwrites |
| Accounts Monarch can't sync (pension, I-Bonds, house equity convention, paystub detail) | **Fred** | — |
| Household coverage (Kate, joint accounts) | **Monarch** | Fred's schema already models owners; sync fills it |
| Transactions, spending, categories, budgets | **Monarch** | Fred has nothing here — pure gain |
| Holdings / allocation detail | **Monarch** | enables 1.4 benchmarking and concentration analysis |
| Intra-month live balances | **Monarch** | overlay: "today vs last close" on dashboards |

### How it lands in the schema
New tables, no changes to existing ones: `account_links` (Fred account ↔
Monarch account id + sync mode), `balance_snapshots` (account, date, balance,
source), `transactions`, `categories`, `holdings`.

### The two workflows it transforms
1. **Monthly close becomes review-and-accept.** For linked accounts, prefill
   the statement balance from Monarch's month-end snapshot and infer
   contributions/transfers from its transactions; growth stays derived; you
   confirm instead of typing. Unlinked accounts (LM pension etc.) stay manual.
2. **Continuous verification.** When Fred's closed balance and Monarch's
   snapshot diverge beyond a tolerance, show a reconcile chip — catches typos
   in both systems. This is what redundancy is *for*; it's a feature, not
   waste, as long as neither side silently overwrites the other.

### New analyses unlocked
Spending by category & trends, budget vs actual, true household net worth
(Fred individual view stays the default; household becomes a toggle),
recurring-obligation calendar against paycheck dates, and the full P&L
waterfall in 1.3.

### Mechanics
`MONARCH_TOKEN` as a Worker secret; a Cloudflare Cron Trigger (free) runs a
nightly sync; a "Sync now" button for on-demand. The Claude-side Monarch MCP
server is useful for exploration, but the app syncs directly against
Monarch's API so it works without Claude in the loop.

## Suggested order
1. Monarch sync foundation (links + snapshots + transactions) — unlocks most
   of everything else and de-risks the monthly close.
2. FI projection (1.1) + savings-rate triangulation (1.3).
3. Tax buckets (1.2) and returns/benchmarking (1.4, needs holdings).
4. Alerts (1.8), then scenarios (1.9), then the rest opportunistically.
