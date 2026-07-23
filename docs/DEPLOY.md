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

### 1b. Create the app's own database role (one-time)

The connection string from step 2 belongs to the project's **owner** role
(`neondb_owner` — named after the database). It can drop tables, create roles
and reach every database in the project. That is the right credential for
migrations, and the wrong one to ship to an internet-facing Worker.

So Fred uses two credentials:

| Credential | Lives in | Can do |
|---|---|---|
| `neondb_owner` | `.env` on your laptop | everything — `db:push`, `db:seed` |
| `fred_app` | Worker secret `DATABASE_URL` | SELECT/INSERT/UPDATE/DELETE, nothing else |

The split is natural here because migrations already run from your laptop, not
from the Worker: Fred does no DDL at runtime, so the deployed app never needs
permission to change the schema.

6. Generate a password — **alphanumeric only**:
   ```bash
   openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32; echo
   ```
   This password is about to go inside a `postgresql://` URL, where
   `@ # % : / ?` are structural characters, not just symbols. A generated
   password containing one (a raw password-manager password often does) makes
   the URL parser misread where the password ends and the host begins — the
   connection string looks fine but fails to parse, and *every* request 500s
   because every route touches the database. Alphanumeric sidesteps this
   entirely; no escaping to get right.

7. Open the Neon **SQL Editor** (connected to the `fred` database as the
   owner role) and run [`scripts/sql/app_role.sql`](../scripts/sql/app_role.sql),
   replacing `CHANGE_ME` with the password from step 6.

   > **Create this role with SQL, not from the Neon Console/CLI/API.** Roles
   > created through those interfaces are automatically granted membership in
   > `neon_superuser` — CREATEDB, CREATEROLE, BYPASSRLS, REPLICATION and
   > read/write on every database. Clicking "Add role" in the dashboard would
   > give you a second administrator, not a restricted app user. Roles created
   > with SQL get only default public-schema privileges, which is the point.

   Save that password somewhere safe — Neon does not manage or display
   passwords for SQL-created roles.

   **Confirm the whole script actually ran** — SQL editors that stop at the
   first error, or a partial paste, can silently leave you with the role but
   none of its grants, which surfaces later as every page failing to load
   rather than as an error here. Run this in the same editor and expect `64`:
   ```sql
   select count(*) from information_schema.role_table_grants where grantee = 'fred_app';
   ```
   `0` means the `GRANT`/`ALTER DEFAULT PRIVILEGES` statements never ran — go
   back and run the rest of `app_role.sql` (the `CREATE ROLE` line will error
   as a duplicate; skip it and run everything below it).

8. Build the Worker's connection string by swapping the credentials in the
   pooled URL from step 2:
   ```
   postgresql://fred_app:<password>@ep-….-pooler.<region>.aws.neon.tech/neondb?sslmode=require
   ```
   Keep this one for step 14. Leave `.env` pointing at the owner role.

**If you later add a table**, `npm run db:push` runs as the owner and the new
table is reachable by `fred_app` automatically — `app_role.sql` sets
`ALTER DEFAULT PRIVILEGES` for exactly that reason. `npm run verify:dbrole`
proves it, along with the rest of the boundary.

### 2. Cloudflare — deploy the Worker (one-time)

9. `npx wrangler login` — browser OAuth into the same Cloudflare account as
   Corpus.
10. `npm run deploy` — builds and publishes; prints your
   `https://fred.<account>.workers.dev` URL.

   The URL will return **500 "Cloudflare Access is not configured"** until
   step 14. That is deliberate — the Worker will not serve financial data it
   cannot attribute to an authorised user, so the app is never briefly open
   while you finish setup.

### 3. Turn on Cloudflare Access (before the app can serve anything)

11. Dashboard → **Workers & Pages** → **fred** → **Settings** →
   **Domains & Routes** → on the `workers.dev` row, click
   **Enable Cloudflare Access**. (This works on `workers.dev`; no custom
   domain needed.)
12. Click **Manage Cloudflare Access** to open the Zero Trust policy and add
   the allowed emails — yours and Kate's. The default login method is a
   one-time PIN emailed to those addresses: nothing to configure, no passwords
   to manage. Zero Trust free covers up to 50 users.
13. In Zero Trust → **Access** → **Applications** → the app that was just
    created:
    - set **Session Duration** to **1 month** (the maximum) so the installed
      PWA rarely re-prompts;
    - copy the **Audience (AUD) tag** from the Overview tab — you need it next.

### 4. Set the secrets and go live

14. Set all three, then redeploy:
    ```bash
    npx wrangler secret put DATABASE_URL           # the fred_app string from step 8
    npx wrangler secret put CF_ACCESS_TEAM_DOMAIN  # e.g. "yourteam"
    npx wrangler secret put CF_ACCESS_AUD          # the AUD tag from step 13
    npm run deploy
    ```
    Note `DATABASE_URL` here is the **`fred_app`** string, not the owner one in
    your `.env`.
15. Reload the URL — you should get the Access one-time-PIN prompt, then Fred
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
- **Database role check**: `npm run verify:dbrole` builds Fred's schema in a
  throwaway database, applies `app_role.sql`, and asserts the app role can
  read and write but cannot DROP, TRUNCATE, ALTER, CREATE TABLE or CREATE
  ROLE.
- The monthly-close flow writes to whichever database the app is pointed at.
  Once deployed, do your monthly close in the deployed app (Neon) — the local
  PGlite copy is a dev sandbox, not a mirror.
