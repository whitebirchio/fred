#!/usr/bin/env python3
"""One-time extraction of the three source workbooks into data/seed/*.json.

Sources (see docs/ANALYSIS.md):
  - Finances (new).xlsx     -> accounts + monthly statement entries
  - 13 Charron Cir.xlsx     -> property, payments (Scott/Kate shares), valuations
  - Pay Stubs.xlsx          -> employers + per-paycheck detail

Every account tab in the Finances workbook carries a normalized cumulative
block (named range) with columns [Date, Net Contributions, Net Transfers In,
Net Growth, Net Withdrawals, Net Transfers Out, Balance]; month-over-month
deltas of that block give the per-month flows uniformly across all tabs.
Raw input columns (left of the block) are preserved per entry in `detail`.
"""

import datetime
import json
import os
import re
import sys

import openpyxl
from openpyxl.utils import column_index_from_string, range_boundaries

DOWNLOADS = os.path.expanduser("~/Downloads")
FINANCES = os.path.join(DOWNLOADS, "Finances (new).xlsx")
CHARRON = os.path.join(DOWNLOADS, "13 Charron Cir.xlsx")
PAYSTUBS = os.path.join(DOWNLOADS, "Pay Stubs.xlsx")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "seed")

def iso(d):
    return d.strftime("%Y-%m-%d") if isinstance(d, (datetime.datetime, datetime.date)) else None

def num(v):
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    return 0.0

# ---------------------------------------------------------------------------
# Finances (new).xlsx
# ---------------------------------------------------------------------------

ACCOUNT_META = {
    # slug: (sheet, category, tax, institution, active)
    "becu": ("BECU", "cash", "taxable", "BECU", False),
    "ally-savings": ("Ally - Savings", "cash", "taxable", "Ally", True),
    "ally-checking": ("Ally - Checking", "cash", "taxable", "Ally", True),
    "lm-401k": ("LM 401(k)", "retirement", "traditional", "LM", True),
    "hs-401k": ("HS 401(k)", "retirement", "traditional", "HS", False),
    "lm-pension": ("LM Pension", "retirement", "pension", "LM", True),
    "vanguard-roth-ira": ("Vanguard - Roth IRA", "retirement", "roth", "Vanguard", True),
    "vanguard-traditional-ira": ("Vanguard - Traditional IRA", "retirement", "traditional", "Vanguard", True),
    "vanguard-sep-ira": ("Vanguard - SEP IRA", "retirement", "traditional", "Vanguard", True),
    "vanguard-brokerage": ("Vanguard - Brokerage", "brokerage", "taxable", "Vanguard", True),
    "vanguard-cash-plus": ("Vanguard - Cash Plus", "cash", "taxable", "Vanguard", True),
    "robinhood": ("Robinhood", "brokerage", "taxable", "Robinhood", False),
    "alpaca": ("Alpaca", "brokerage", "taxable", "Alpaca", False),
    "fidelity-brokerage": ("Fidelity - Brokerage", "brokerage", "taxable", "Fidelity", True),
    "td-ameritrade-brokerage": ("TD Ameritrade - Brokerage", "brokerage", "taxable", "TD Ameritrade", False),
    "lm-hsa": ("LM HSA", "hsa", "hsa", "LM", True),
    "hs-hsa": ("HS HSA", "hsa", "hsa", "HS", False),
    "crypto-ethereum": ("Crypto - Ethereum", "crypto", "taxable", "Coinbase", True),
    "crypto-bitcoin": ("Crypto - Bitcoin", "crypto", "taxable", "Coinbase", True),
    "i-bonds": ("I-Bonds", "cash", "taxable", "TreasuryDirect", True),
}

# Sheets tracked outside the net-worth rollup (no named range, no Analysis col)
EXTRA_SHEETS = {
    "hs-espp": ("HS ESPP", "brokerage", "taxable", "HS"),
    "hs-rsus": ("HS RSUs", "brokerage", "taxable", "HS"),
}

NORMALIZED_HEADERS = {
    "Date", "Net Contributions", "Net Transfers In", "Net Growth",
    "Net Withdrawals", "Net Transfers Out", "Balance",
}


def extract_accounts():
    wbv = openpyxl.load_workbook(FINANCES, data_only=True)
    wbf = openpyxl.load_workbook(FINANCES)

    # named range -> (sheet, first normalized col index)
    block_start = {}
    for name, dn in wbf.defined_names.items():
        text = dn.attr_text  # e.g. "'Ally - Savings'!$G:$M"
        m = re.match(r"^'?(.*?)'?!\$([A-Z]+):\$[A-Z]+$", text)
        if m:
            block_start[m.group(1)] = column_index_from_string(m.group(2))

    accounts = []
    for order, (slug, (sheet, category, tax, institution, active)) in enumerate(
        ACCOUNT_META.items()
    ):
        ws = wbv[sheet]
        start = block_start[sheet]
        headers = {}
        for c in range(1, ws.max_column + 1):
            h = ws.cell(1, c).value
            if isinstance(h, str) and h.strip():
                headers[c] = h.strip()

        input_cols = {
            c: h
            for c, h in headers.items()
            if c < start and h != "Statement Date"
        }
        extra_cols = {
            c: h
            for c, h in headers.items()
            if c >= start + 7 and not h.startswith("http")
        }
        company_cols = [c for c, h in input_cols.items() if "Company" in h]

        entries = []
        prev = [0.0] * 5  # netContrib, netTransfIn, netGrowth, netWithdraw, netTransfOut
        for r in range(2, ws.max_row + 1):
            d = ws.cell(r, start).value
            if not isinstance(d, (datetime.datetime, datetime.date)):
                continue
            cum = [num(ws.cell(r, start + i).value) for i in range(1, 6)]
            balance = num(ws.cell(r, start + 6).value)
            delta = [round(cum[i] - prev[i], 2) for i in range(5)]
            prev = cum
            employer = round(
                sum(num(ws.cell(r, c).value) for c in company_cols), 2
            )
            detail = {}
            for c, h in {**input_cols, **extra_cols}.items():
                v = ws.cell(r, c).value
                if isinstance(v, (int, float)) and v != 0:
                    detail[h] = round(float(v), 2)
            entries.append(
                {
                    "statementDate": iso(d),
                    "individualContributions": round(delta[0] - employer, 2),
                    "employerContributions": employer,
                    "transfersIn": delta[1],
                    "growth": delta[2],
                    "withdrawals": delta[3],
                    "transfersOut": delta[4],
                    "balance": balance,
                    "detail": detail or None,
                }
            )

        accounts.append(
            {
                "slug": slug,
                "name": sheet,
                "institution": institution,
                "category": category,
                "taxTreatment": tax,
                "owner": "scott",
                "isActive": active,
                "includeInNetWorth": True,
                "sortOrder": order,
                "entries": entries,
            }
        )

    # HS ESPP / RSUs: direct monthly columns, excluded from net worth
    for order, (slug, (sheet, category, tax, institution)) in enumerate(
        EXTRA_SHEETS.items()
    ):
        ws = wbv[sheet]
        headers = {}
        for c in range(1, ws.max_column + 1):
            h = ws.cell(1, c).value
            if isinstance(h, str) and h.strip():
                headers[h.strip()] = c

        def col(name):
            return headers.get(name)

        entries = []
        for r in range(2, ws.max_row + 1):
            d = ws.cell(r, 1).value
            if not isinstance(d, (datetime.datetime, datetime.date)):
                continue

            def val(name):
                c = col(name)
                return num(ws.cell(r, c).value) if c else 0.0

            detail = {}
            for name in ("Units", "Share Price"):
                if col(name):
                    v = ws.cell(r, col(name)).value
                    if isinstance(v, (int, float)):
                        detail[name] = round(float(v), 2)
            entries.append(
                {
                    "statementDate": iso(d),
                    "individualContributions": val("Contributions"),
                    "employerContributions": 0.0,
                    "transfersIn": val("Transfers In"),
                    "growth": val("Growth"),
                    "withdrawals": val("Withdrawals"),
                    "transfersOut": val("Transfers Out") or val("Transfer Out"),
                    "balance": val("Balance"),
                    "detail": detail or None,
                }
            )
        accounts.append(
            {
                "slug": slug,
                "name": sheet,
                "institution": institution,
                "category": category,
                "taxTreatment": tax,
                "owner": "scott",
                "isActive": False,
                "includeInNetWorth": False,
                "sortOrder": 100 + order,
                "entries": entries,
            }
        )

    return accounts

# ---------------------------------------------------------------------------
# 13 Charron Cir.xlsx
# ---------------------------------------------------------------------------

PAYMENT_TYPES = {
    "Down Payment": "down_payment",
    "Mortgage Payment": "mortgage",
    "HOA": "hoa",
    "Fees": "fees",
    "Escrow": "escrow",
}


def extract_property():
    wb = openpyxl.load_workbook(CHARRON, data_only=True)
    ws = wb["Payments"]
    payments = []
    for r in range(3, ws.max_row + 1):
        d = ws.cell(r, 1).value
        if not isinstance(d, (datetime.datetime, datetime.date)):
            continue
        ptype = str(ws.cell(r, 2).value or "").strip()
        payments.append(
            {
                "date": iso(d),
                "type": PAYMENT_TYPES.get(ptype, "other"),
                "typeRaw": ptype,
                "scott": num(ws.cell(r, 3).value),
                "kate": num(ws.cell(r, 4).value),
                "principal": num(ws.cell(r, 6).value),
                "interest": num(ws.cell(r, 7).value),
                "escrow": num(ws.cell(r, 8).value),
                "hoa": num(ws.cell(r, 9).value),
                "fees": num(ws.cell(r, 10).value),
                "loanBalanceAfter": num(ws.cell(r, 11).value),
                "notes": (str(ws.cell(r, 12).value)[:500] if ws.cell(r, 12).value else None),
            }
        )

    ws = wb["Analysis"]
    valuations = []
    for r in range(2, ws.max_row + 1):
        d = ws.cell(r, 1).value
        if not isinstance(d, (datetime.datetime, datetime.date)):
            continue
        mv = ws.cell(r, 3).value
        if isinstance(mv, (int, float)):
            valuations.append({"date": iso(d), "marketValue": round(float(mv), 2)})

    return {
        "slug": "13-charron-cir",
        "name": "13 Charron Cir",
        "address": "13 Charron Cir",
        "purchasePrice": 380000,
        "purchaseDate": "2019-06-27",
        "originalLoan": 304000,
        "equityShare": 0.5,
        "payments": payments,
        "valuations": valuations,
    }

# ---------------------------------------------------------------------------
# Pay Stubs.xlsx
# ---------------------------------------------------------------------------

STUB_SHEETS = {
    "lm": "LM - Pay Stubs",
    "trellis": "Trellis - Pay Stubs",
    "hs": "HS - Pay Stubs",
}

META_COLS = {
    "Payment Date", "Pay Begin Date", "Pay End Date", "Annual Salary",
    "Net Pay", "Calculated Net", "Checksum", "Total Income",
    "Fed Income Tax Rate", "Tax Rate", "401k",
    "Net Pay + 401k + ESSP + HSA + Commuter",
}

SECTION_KEYS = {
    "Income": "income",
    "Pre Tax Deductions": "preTax",
    "Taxes": "taxes",
    "Post Tax Deductions": "postTax",
}


def extract_paychecks():
    wb = openpyxl.load_workbook(PAYSTUBS, data_only=True)
    out = []
    for slug, sheet in STUB_SHEETS.items():
        ws = wb[sheet]
        # row 1: section labels at section-start columns; row 2: column names
        sections = {}
        current = None
        for c in range(1, ws.max_column + 1):
            s = ws.cell(1, c).value
            if isinstance(s, str) and s.strip() in SECTION_KEYS:
                current = SECTION_KEYS[s.strip()]
            name = ws.cell(2, c).value
            if not isinstance(name, str) or not name.strip():
                continue
            name = name.strip()
            sections[c] = (None if name in META_COLS or current is None else current, name)

        checks = []
        for r in range(3, ws.max_row + 1):
            d = ws.cell(r, 1).value
            if not isinstance(d, (datetime.datetime, datetime.date)):
                continue
            items = {"income": {}, "preTax": {}, "taxes": {}, "postTax": {}}
            meta = {}
            for c, (section, name) in sections.items():
                v = ws.cell(r, c).value
                if section is None:
                    meta[name] = v
                elif isinstance(v, (int, float)) and v != 0:
                    items[section][name] = round(float(v), 2)

            taxes_total = round(sum(items["taxes"].values()), 2)
            fed = sum(
                v for k, v in items["taxes"].items()
                if "Fed" in k or "Federal" in k
            )
            k401 = sum(
                v
                for sec in ("preTax", "postTax")
                for k, v in items[sec].items()
                if "401k" in k
            )
            hsa = sum(v for k, v in items["preTax"].items() if k == "HSA")
            bonus = sum(v for k, v in items["income"].items() if "Bonus" in k)
            total_income = meta.get("Total Income")
            if not isinstance(total_income, (int, float)):
                total_income = sum(items["income"].values())
            checks.append(
                {
                    "paymentDate": iso(d),
                    "payBeginDate": iso(ws.cell(r, 2).value),
                    "payEndDate": iso(ws.cell(r, 3).value),
                    "annualSalary": num(meta.get("Annual Salary")),
                    "totalIncome": round(float(total_income), 2),
                    "netPay": num(meta.get("Net Pay")),
                    "federalTax": round(float(fed), 2),
                    "totalTaxes": taxes_total,
                    "retirement401k": round(float(k401), 2),
                    "hsa": round(float(hsa), 2),
                    "bonus": round(float(bonus), 2),
                    "items": items,
                }
            )
        out.append({"slug": slug, "name": sheet.split(" - ")[0], "person": "scott", "paychecks": checks})
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    accounts = extract_accounts()
    prop = extract_property()
    employers = extract_paychecks()

    with open(os.path.join(OUT, "accounts.json"), "w") as f:
        json.dump(accounts, f, indent=1)
    with open(os.path.join(OUT, "property.json"), "w") as f:
        json.dump(prop, f, indent=1)
    with open(os.path.join(OUT, "paychecks.json"), "w") as f:
        json.dump(employers, f, indent=1)

    # sanity summary
    for a in accounts:
        last = a["entries"][-1] if a["entries"] else None
        print(
            f"{a['slug']:26} entries={len(a['entries']):4}"
            f" last={last['statementDate'] if last else '-'}"
            f" balance={last['balance'] if last else 0:>12,.2f}"
        )
    print(f"property payments={len(prop['payments'])} valuations={len(prop['valuations'])}")
    for e in employers:
        print(f"{e['slug']:8} paychecks={len(e['paychecks'])}")


if __name__ == "__main__":
    sys.exit(main())
