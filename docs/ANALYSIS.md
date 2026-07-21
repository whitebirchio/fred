# Source workbook analysis (historical)

**This is a record of where Fred's seed data came from, not live
documentation.** The three workbooks were imported once in July 2026 and are
being retired; Fred owns the data now (see [SEED.md](SEED.md)). Kept because
it explains how each figure was derived and why the model is shaped the way
it is.

What the workbooks tracked, how the monthly workflow operated, and how that
maps onto Fred's data model:

- `Finances (new).xlsx` — the master net-worth workbook (individual)
- `Pay Stubs.xlsx` — per-paycheck income ledger (individual)
- `13 Charron Cir.xlsx` — house/mortgage ledger (shared: Scott + Kate)

## 1. Finances (new).xlsx

**One tab per account** (21 tracked accounts: BECU, Ally ×2, LM 401(k)/Pension/HSA,
HS 401(k)/HSA/ESPP/RSUs, Vanguard ×5, Robinhood, Alpaca, Fidelity, TD Ameritrade,
Coinbase BTC/ETH, I-Bonds, House Equity). Each tab has:

- **Input columns** (left): one row per statement month — contributions
  (split Roth/Traditional/After-tax/Company where relevant), transfers in/out,
  growth, withdrawals. Column sets vary per account type.
- **Normalized block** (right, a named range per tab): `Date, Net Contributions,
  Net Transfers In, Net Growth, Net Withdrawals, Net Transfers Out, Balance` —
  cumulative, with `Balance = ΣContrib + ΣTransfIn + ΣGrowth − ΣWithdrawals − ΣTransfOut`.

**The Analysis tab** is a month × account matrix (Oct 2010 → present, rows
pre-dated through 2033) with six blocks — BALANCE, CONTRIBUTIONS, TRANSFERS IN,
GROWTH, WITHDRAWALS, TRANSFERS OUT — each populated by
`VLOOKUP(month, <account named range>, col, TRUE)`; the `TRUE` makes accounts
carry their last known balance forward. Summary columns feed **annual YTD
pivots** (month × year grids) for net balance change, contributions, growth,
withdrawals, savings and savings rate.

**Key definitions** (used verbatim in Fred):

- *Savings* = contributions − withdrawals (transfers are internal and excluded)
- *Savings rate* = YTD savings ÷ YTD contributions
- *Growth* = market/interest change; in practice entered as the plug that makes
  the statement balance reconcile
- Contributions include employer money (401k match, pension credits, HSA seed)

**Chart tabs** (native Excel chartsheets — the dashboards Fred replicates):
Balance, Contributions, Growth, Savings, Savings vs Growth, Annual Net Balance,
Annual Net Contributions, Annual Net Growth, Annual Net Savings, Annual Savings
Rate (year-per-line overlays).

**Conventions carried into Fred**
- The workbook tracks *Scott's individual* net worth. The house enters as
  **even-split equity**: `(market value − loan balance) / 2` (HS ESPP/RSUs were
  tracked but excluded from the rollup → `accounts.include_in_net_worth`).
- Closed accounts (BECU, TD Ameritrade, HS 401(k)/HSA, Robinhood-era gaps)
  keep history; a stale account carries its last balance forward.

## 2. Pay Stubs.xlsx

Per-paycheck ledgers per employer, with sectioned columns (Income / Pre-Tax
Deductions / Taxes / Post-Tax Deductions) that vary by employer, plus derived
`Calculated Net` and a `Checksum` verifying the stub math. Employment timeline
(from stub gaps): **LM** 2011-06 → 2018-05, **HS** 2018-05 → 2019-06, **LM**
2019-07 → 2021-11, **Trellis** 2021-11 → 2022-04, **LM** 2022-07 → present.
Salary $58,000 (2011) → $225,050 (2026); March bonuses tracked yearly.

Also contains:
- **401(k) + HSA Contributions** — a planner: given the IRS limit, YTD
  contributions and remaining paychecks, compute the per-check amount/percent
  to exactly max the limit. *Fred automates this fully* (YTD from imported
  paychecks, paydays extrapolated on the biweekly cadence).
- **analysis** — annual bonus history, annual tax totals/rates, refunds.
- LM 401(k) and Pension per-paycheck detail (superseded by the Finances workbook).

## 3. 13 Charron Cir.xlsx

Shared house ledger since June 2019 ($380,000 purchase, $304,000 loan):

- **Payments**: every payment (down payment, mortgage, HOA, fees) with
  *Amount Paid by Scott / by Kate*, allocation to principal/interest/escrow/
  HOA/fees, and running mortgage balance. Notes record the funding path
  (joint Ally checking).
- **Analysis**: monthly market value estimate + equity computed several ways —
  purchase-price equity, market equity, contribution-weighted per-person
  equity, and even-split equity (the one that feeds net worth).

## Monthly workflow (inferred) → Fred's Monthly close

This is the workflow Fred's `/monthly` page replaced. Once statements arrive
(~month end):
1. For each active account, add one row: contributions, transfers, withdrawals,
   and growth *as the plug* to match the statement balance.
   → In Fred: enter statement balance + flows; **growth is derived live**.
2. Log mortgage/HOA payments with the Scott/Kate split; update market value.
3. Add new pay stubs; check the 401(k) planner.
4. Look at the chart tabs (now the Overview/Savings dashboards).

## Automation opportunities (beyond v1)

- Monarch Money sync (MCP server exists; needs `MONARCH_TOKEN`) for balances
  and household transactions.
- Crypto prices (BTC/ETH) from a public API instead of manual growth entry.
- Mortgage amortization: derive principal/interest from the payment amount.
- Paycheck templates: prefill from the previous stub, only edit deltas.
- Recurring-entry defaults (I-Bond interest, HOA dues, pension credit).
