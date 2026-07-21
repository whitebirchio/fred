# Fred

Personal-finance PWA replacing the Google Sheets workflow: individual net
worth, savings & growth, shared house ledger, and per-paycheck income —
maintained through a monthly-close flow, with Monarch synced alongside for
day-to-day balances.

Fred is the system of record. History was bootstrapped once from the original
workbooks ([docs/SEED.md](docs/SEED.md)); nothing in the running app reads them.

Built with Next.js (App Router) + TypeScript, Drizzle ORM, Recharts, Tailwind.
Storage is Postgres: **Neon** in production, **PGlite** (embedded Postgres)
locally when `DATABASE_URL` is unset — zero setup for dev.

## Getting started

```bash
npm install
npm run db:push      # create schema (PGlite locally, Neon if DATABASE_URL set)
npm run db:seed      # one-time bootstrap from the committed data/seed/*.json
npm run dev          # http://localhost:3000
```

### Pointing at Neon

1. Create a Neon project and copy the pooled connection string.
2. `cp .env.example .env` and set `DATABASE_URL=postgres://…`.
3. `npm run db:push && npm run db:seed` (one-time), then `npm run dev`.

Both commands read `.env` and target whatever `DATABASE_URL` names; the seed
prints its target host before writing. It refuses to run against a database
that already has data — see [docs/SEED.md](docs/SEED.md).

> `data/seed/` contains real financial data. The repo is expected to stay
> private; add it to `.gitignore` if that ever changes.

## Pages

| Route | Purpose |
|---|---|
| `/` | Net worth, allocation, per-account balances |
| `/plan` | FI projection (live assumptions) + tax-aware bucket breakdown |
| `/savings` | Savings vs growth, monthly savings, annual YTD overlays, savings rate |
| `/household` | Unified roster across sources: resolved balances + provenance, review queue, slice-and-dice filters, liabilities |
| `/accounts/[slug]` | Single-account detail: statement history + entry |
| `/house` | Value/loan/equity, Scott–Kate split, payment ledger, valuation entry |
| `/income` | Salary history, annual tax rates, automated 401(k) planner, paycheck entry |
| `/monthly` | Monthly close checklist — enter statement balances, growth is derived |
| `/sync` | Provider connection status, sync-now, run history |

Authentication (Cloudflare Access, enforced at the edge with an independent
token check in the Worker) is in [docs/AUTH.md](docs/AUTH.md). The one-time
bootstrap and how to seed a real database live in
[docs/SEED.md](docs/SEED.md); metric definitions and where each number
originally came from in [docs/ANALYSIS.md](docs/ANALYSIS.md); the external-sync
architecture (provider abstraction, dedup rules, idempotency) in
[docs/SYNC.md](docs/SYNC.md); the unified household account model design in
[docs/HOUSEHOLD.md](docs/HOUSEHOLD.md). Deployment (Neon + Cloudflare Workers
via OpenNext) is wired — manual account steps are in
[docs/DEPLOY.md](docs/DEPLOY.md); future-feature thinking lives in
[docs/ROADMAP.md](docs/ROADMAP.md).

## Access

Deployed, Fred sits behind Cloudflare Access: a one-time PIN emailed to two
allowlisted addresses, sessions lasting a month, and no login code of its own.
The Worker independently verifies the Access token on every request and
refuses to serve anything if Access is unconfigured. `npm run verify:access`
exercises the verifier against forged, expired and wrong-audience tokens.

The deployed app connects to Postgres as a least-privilege role (`fred_app`:
DML only, no DDL, no role creation); the owning role stays on the laptop for
migrations. `npm run verify:dbrole` proves the boundary.

## PWA

`public/manifest.webmanifest` + `public/sw.js` (registered in production
builds only): installable, offline shell with last-seen pages cached.
