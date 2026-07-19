# Fred

Personal-finance PWA replacing the Google Sheets workflow: individual net
worth, savings & growth, shared house ledger, and per-paycheck income —
imported from the original workbooks and updated through a monthly-close flow.

Built with Next.js (App Router) + TypeScript, Drizzle ORM, Recharts, Tailwind.
Storage is Postgres: **Neon** in production, **PGlite** (embedded Postgres)
locally when `DATABASE_URL` is unset — zero setup for dev.

## Getting started

```bash
npm install
npm run db:push      # create schema (PGlite locally, Neon if DATABASE_URL set)
npm run db:seed      # load data/seed/*.json (extracted from the workbooks)
npm run dev          # http://localhost:3000
```

### Pointing at Neon

1. Create a Neon project and copy the pooled connection string.
2. `cp .env.example .env` and set `DATABASE_URL=postgres://…`.
3. `npm run db:push && npm run db:seed` (one-time), then `npm run dev`.

### Re-extracting the spreadsheets

`scripts/extract_seed.py` (needs `openpyxl`) reads the three workbooks from
`~/Downloads` and regenerates `data/seed/*.json`. The seed importer wipes and
reloads all tables, so don't re-run it after entering new data in the app.

> `data/seed/` contains real financial data. The repo is expected to stay
> private; add it to `.gitignore` if that ever changes.

## Pages

| Route | Purpose |
|---|---|
| `/` | Net worth, allocation, per-account balances |
| `/savings` | Savings vs growth, monthly savings, annual YTD overlays, savings rate |
| `/accounts`, `/accounts/[slug]` | Account list, per-account history + statement entry |
| `/house` | Value/loan/equity, Scott–Kate split, payment ledger, valuation entry |
| `/income` | Salary history, annual tax rates, automated 401(k) planner, paycheck entry |
| `/monthly` | Monthly close checklist — enter statement balances, growth is derived |

Metric definitions and the source-spreadsheet mapping live in
[docs/ANALYSIS.md](docs/ANALYSIS.md). Deployment (Neon + Cloudflare Workers via
OpenNext) is wired — manual account steps are in [docs/DEPLOY.md](docs/DEPLOY.md);
future-feature thinking lives in [docs/ROADMAP.md](docs/ROADMAP.md).

## PWA

`public/manifest.webmanifest` + `public/sw.js` (registered in production
builds only): installable, offline shell with last-seen pages cached.
