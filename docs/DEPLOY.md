# Deploying Fred (Neon + Cloudflare Workers)

Everything code-side is wired: the OpenNext adapter builds the app for
Workers ([wrangler.jsonc](../wrangler.jsonc), [open-next.config.ts](../open-next.config.ts)),
and the database layer automatically uses the Neon serverless driver whenever
`DATABASE_URL` is set (locally it falls back to embedded PGlite).

Verified: `npx opennextjs-cloudflare build` succeeds; bundle is ~1.8 MB gzipped
(free-plan cap is 3 MB); the worker boots under `wrangler dev` and serves
assets, with a clear error until the `DATABASE_URL` secret exists.

## Manual steps (require your accounts)

### 1. Neon — create and load the database (one-time)

1. [console.neon.tech](https://console.neon.tech) → **New project** — name it
   `fred`, pick the region closest to you, default Postgres version.
2. On the project dashboard, **Connect** → copy the **pooled** connection
   string (host contains `-pooler`).
3. Locally: `cp .env.example .env` and paste it as `DATABASE_URL=...`.
4. Load the schema and your imported history into Neon:
   ```bash
   npm run db:push
   npm run db:seed
   ```
5. Sanity-check: `npm run dev` now runs against Neon (because `.env` sets
   `DATABASE_URL`); the Overview should show the same numbers as before.
   Delete/rename `.env` any time you want dev to use the local PGlite copy
   instead.

### 2. Cloudflare — deploy the Worker (one-time)

6. `npx wrangler login` — browser OAuth into the same Cloudflare account as
   Corpus.
7. `npm run deploy` — builds and publishes; prints your
   `https://fred.<account>.workers.dev` URL. (Pages will 500 until step 8.)
8. `npx wrangler secret put DATABASE_URL` — paste the same pooled Neon string.
9. Reload the URL — Fred should be live with your data.

Afterwards, each redeploy is just `npm run deploy`.

### 3. Lock it down with Cloudflare Access (strongly recommended)

The app has no login of its own and this is your full financial history —
protect it before bookmarking:

10. Dashboard → **Workers & Pages** → **fred** → **Settings** →
    **Domains & Routes** → on the `workers.dev` row, click
    **Enable Cloudflare Access**.
11. Click **Manage Cloudflare Access** to open the Zero Trust policy and set
    the allowed emails (you, and Kate if desired). Zero Trust free tier covers
    up to 50 users; the default login method is a one-time PIN emailed to
    allowed addresses — no passwords to manage.
12. In Zero Trust → Access → Applications → the created app, set **Session
    Duration** to something long (e.g. 1 month) so the installed PWA rarely
    re-prompts.

### 4. Install the PWA

Open the workers.dev URL on your phone → Share → **Add to Home Screen**
(iOS) or the install prompt (Android/desktop Chrome).

### Later (when ready)

- `npx wrangler secret put MONARCH_TOKEN` — for the Monarch sync
  (see [ROADMAP.md](ROADMAP.md)).
- Custom domain: Worker → Settings → Domains & Routes → Add custom domain
  (requires the domain's DNS on Cloudflare).

## Notes

- **Free-tier fit**: Workers free = 100k requests/day + 10ms CPU/request —
  orders of magnitude beyond personal use. Static assets are free and
  unmetered. Neon free tier comfortably holds this dataset (a few MB).
- `npm run preview` runs the production Worker build locally (reads
  `.dev.vars` for `DATABASE_URL` if you want it to hit Neon).
- The monthly-close flow writes to whichever database the app is pointed at.
  Once deployed, do your monthly close in the deployed app (Neon) — the local
  PGlite copy is a dev sandbox, not a mirror.
