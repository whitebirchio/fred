# Open questions / parked decisions

Banked 2026-07-19 so they don't get lost. Revisit as needed.

1. **Neon setup** — ✅ decided: Neon is the DB provider (consistent with Corpus).
   Still to do: create the Fred project in Neon, put the pooled connection
   string in `.env` as `DATABASE_URL`, run `npm run db:push && npm run db:seed`.

2. **Monarch Money sync** — the Monarch MCP server is installed but needs
   `MONARCH_TOKEN` set before it can authenticate. Once available, build a sync
   for household balances/transactions (the path to covering Kate's side,
   which the spreadsheets don't).

3. **Household scope for v2** — v1 mirrors the sheets (Scott's individual view;
   Kate appears only in the house ledger). Decide whether v2 adds Kate's
   accounts and a Me / Kate / Household toggle. The schema already supports it
   (persons, `owner_person_id`, `is_joint`, `ownership_share`).

4. **Data cleanup calls**
   - BECU carries its last balance ($1,243.05, Dec 2024) forward — matches the
     old VLOOKUP behavior, but close it to $0 if the account is truly empty.
   - Crypto - Bitcoin's last entry is Dec 2025 ($175.02) — refresh or close.

5. **Crypto price automation** — auto-fill BTC/ETH growth from live prices
   (e.g. a public price API) instead of manual growth entry?

6. **Initial git commit** — ✅ done (`6d83a8a`, 2026-07-19). No remote yet;
   nothing pushed.

7. **Hosting** — ✅ decided: Cloudflare Workers via @opennextjs/cloudflare
   (see `docs/DEPLOY.md` for the manual steps). Cloudflare Access will gate
   the app; revisit auth only if Access ever feels limiting.

8. **Roadmap review** — `docs/ROADMAP.md` holds the advisor-lens feature
   thinking and the Monarch integration design; pick the first slice.

9. **Household account model** — design in `docs/HOUSEHOLD.md` (hub/spoke
   accounts-vs-evidence, per-domain resolution with provenance, /household
   page + review queue, 4 phases). Its own open questions: liabilities in
   household net worth, property-as-account, /household replacing /accounts,
   default lens.
