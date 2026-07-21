# Deploying Fred (Neon + Cloudflare Workers)

Everything code-side is wired: the OpenNext adapter builds the app for
Workers ([wrangler.jsonc](../wrangler.jsonc), [open-next.config.ts](../open-next.config.ts)),
and the database layer automatically uses the Neon serverless driver whenever
`DATABASE_URL` is set (locally it falls back to embedded PGlite).

Authentication is Cloudflare Access — see [AUTH.md](AUTH.md). Fred has no
login of its own and **fails closed**: a deployed Worker without the Access
secrets serves nothing but setup instructions, so there is no window where
your finances sit unprotected on a public URL.

Verified: `npx opennextjs-cloudflare build` succeeds; wrangler reports the
bundle at 1.56 MB gzipped (free-plan cap is 3 MB); the Worker boots under
`wrangler dev`, serves assets, enforces Access, and shows a clear error until
the `DATABASE_URL` secret exists.

## Manual steps (require your accounts)

### 1. Neon — create and load the database (one-time)

1. [console.neon.tech](https://console.neon.tech) → **New project** — name it
   `fred`, pick the region closest to you, default Postgres version.
2. On the project dashboard, **Connect** → copy the **pooled** connection
   string (host contains `-pooler`).
3. Locally: `cp .env.example .env` and paste it as `DATABASE_URL=...`.
4. Load the schema and bootstrap your history into Neon:
   ```bash
   npm run db:push
   npm run db:seed
   ```
   Both read `.env`, so they target Neon as soon as `DATABASE_URL` is set. The
   seed prints where it is about to write — check that it says your Neon host
   and not `embedded PGlite` before letting it run:
   ```
   Target: Postgres at ep-….neon.tech/fred (DATABASE_URL)
   ```
   This is a **one-time bootstrap** from the committed `data/seed/*.json`; the
   `.xlsx` workbooks are not needed and are never read. Afterwards Fred owns
   the data and the monthly close is what adds to it — running `db:seed`
   against a populated database is refused. See [SEED.md](SEED.md).
5. Sanity-check: `npm run dev` now runs against Neon (because `.env` sets
   `DATABASE_URL`); the Overview should show **$2,403,754.02**, the same as
   your local copy. Delete/rename `.env` any time you want dev to use the
   local PGlite copy instead.

### 2. Cloudflare — deploy the Worker (one-time)

6. `npx wrangler login` — browser OAuth into the same Cloudflare account as
   Corpus.
7. `npm run deploy` — builds and publishes; prints your
   `https://fred.<account>.workers.dev` URL.

   The URL will return **500 "Cloudflare Access is not configured"** until
   step 11. That is deliberate — the Worker will not serve financial data it
   cannot attribute to an authorised user, so the app is never briefly open
   while you finish setup.

### 3. Turn on Cloudflare Access (do this before step 4)

8. Dashboard → **Workers & Pages** → **fred** → **Settings** →
   **Domains & Routes** → on the `workers.dev` row, click
   **Enable Cloudflare Access**. (This works on `workers.dev`; no custom
   domain needed.)
9. Click **Manage Cloudflare Access** to open the Zero Trust policy and add
   the allowed emails — yours and Kate's. The default login method is a
   one-time PIN emailed to those addresses: nothing to configure, no passwords
   to manage. Zero Trust free covers up to 50 users.
10. In Zero Trust → **Access** → **Applications** → the app that was just
    created:
    - set **Session Duration** to **1 month** (the maximum) so the installed
      PWA rarely re-prompts;
    - copy the **Audience (AUD) tag** from the Overview tab — you need it next.

### 4. Set the secrets and go live

11. Set all three, then redeploy:
    ```bash
    npx wrangler secret put DATABASE_URL           # pooled Neon string
    npx wrangler secret put CF_ACCESS_TEAM_DOMAIN  # e.g. "yourteam"
    npx wrangler secret put CF_ACCESS_AUD          # the AUD tag from step 10
    npm run deploy
    ```
12. Reload the URL — you should get the Access one-time-PIN prompt, then Fred
    with your data, and your email in the top-right of the header.

Afterwards, each redeploy is just `npm run deploy`.

### 5. Install the PWA

Open the workers.dev URL on your phone → Share → **Add to Home Screen**
(iOS) or the install prompt (Android/desktop Chrome).

### Later (when ready)

- `npm run monarch:login`, then `npx wrangler secret put MONARCH_TOKEN` and
  `npx wrangler secret put MONARCH_DEVICE_UUID` — enables the Monarch sync on
  `/sync` (see [SYNC.md](SYNC.md) for how the login script works).
- Custom domain: Worker → Settings → Domains & Routes → Add custom domain
  (requires the domain's DNS on Cloudflare).

## Notes

- **Free-tier fit**: Workers free = 100k requests/day + 10ms CPU/request —
  orders of magnitude beyond personal use. Static assets are free and
  unmetered. Neon free tier comfortably holds this dataset (a few MB).
- `npm run preview` runs the production Worker build locally (reads
  `.dev.vars` for `DATABASE_URL` if you want it to hit Neon). The sample
  `.dev.vars` sets `NEXTJS_ENV=development`, which skips Access enforcement —
  remove that line to exercise the real auth path locally.
- **Auth checks**: `npm run verify:access` proves the token verifier rejects
  forged, expired and wrong-audience tokens. See [AUTH.md](AUTH.md).
- The monthly-close flow writes to whichever database the app is pointed at.
  Once deployed, do your monthly close in the deployed app (Neon) — the local
  PGlite copy is a dev sandbox, not a mirror.
