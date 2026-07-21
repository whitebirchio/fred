# Authentication: Cloudflare Access

Fred holds a complete financial history and is served on the public internet.
It has **no login of its own** — authentication is Cloudflare Access, enforced
at the edge, with an independent token check inside the Worker as a second
layer.

## Why Access rather than Google OAuth in the app

Both end up asking "is this Scott or Kate?", but they differ in where the
question gets asked.

|  | Cloudflare Access | OAuth in the app (Auth.js etc.) |
|---|---|---|
| Where it runs | Cloudflare's edge, in front of the Worker | Inside the Worker, on every request |
| Unauthenticated traffic | never reaches Fred | reaches Fred; the login route is the attack surface |
| Code to maintain | none | sessions, callbacks, CSRF, token refresh |
| Worker bundle | +0 | +100s of KB against a 3 MB free-plan cap |
| Cost | free to 50 users | free |
| Stays logged in | session up to 1 month | whatever you build |

Access can *use* Google as its identity provider, so "sign in with Google" is
still available without hand-rolling OAuth. Fred is currently set up for
**one-time PIN**: a code emailed to an allowlisted address, no IdP setup at
all. Switching to Google later is a dropdown in the Zero Trust dashboard and
needs no code change.

## The two layers

**1. Access, at the edge (the real gate).** Enabled from the Worker's
*Settings → Domains & Routes → Enable Cloudflare Access*. It works on the
`workers.dev` hostname — no custom domain required. Requests without a valid
session are stopped by Cloudflare and never reach the Worker.

**2. Token verification, in the Worker (defence in depth).** `worker.ts` wraps
the OpenNext handler and verifies the Access JWT on every request before
Next.js sees it. This exists because layer 1 is a dashboard toggle: if Access
is ever switched off, or a custom domain or route is added later without a
policy attached, layer 2 keeps the app closed instead of silently serving
everything.

`src/lib/access.ts` verifies the RS256 signature against the team's published
keys (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), then checks
issuer, audience and expiry. It is dependency-free Web Crypto — the Worker
bundle is at ~1.6 MB of a 3 MB cap, so pulling in a JWT library was not worth
it.

**Why the Worker entrypoint and not `proxy.ts`:** Next 16 renamed Middleware to
Proxy and runs it on the Node runtime only — the `runtime` config option throws
if you try to set it — and OpenNext cannot bundle Node middleware for Workers.
Wrapping the entrypoint is also broader: it covers server actions, route
handlers and assets, not just rendered routes.

## Failure modes, by design

| Situation | Response |
|---|---|
| No token (stranger with the URL) | `401 Not authorised: no Access token on the request.` |
| Forged or tampered token | `401` with the specific reason |
| Expired session | `401 Not authorised: session expired.` |
| Token for a different Access app or team | `401` |
| Client sends its own `x-fred-user` header | stripped before Next.js sees it; still `401` |
| **Deployed without the `CF_ACCESS_*` secrets** | `500` with setup instructions — it does not fall open |

That last row is the important one: a deployed Worker missing its Access
config refuses to serve anything, on the same principle as the `DATABASE_URL`
check in `src/db/index.ts`.

## Where enforcement applies

`authMode()` decides:

- `npm run dev` — **skipped**. No edge in front; there is nothing to verify.
- `npm run preview` — **skipped** when `.dev.vars` sets `NEXTJS_ENV=development`
  (the sample file does). Remove that line to exercise the enforce path
  locally.
- Deployed Worker — **enforced**, or fails closed if unconfigured.

## Configuration

Two secrets, both required in production:

| Secret | Value | Where to find it |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | `yourteam` (or the full `yourteam.cloudflareaccess.com`) | Zero Trust → Settings → Custom Pages, or the URL you log in at |
| `CF_ACCESS_AUD` | the application's **Audience (AUD) tag** | Zero Trust → Access → Applications → *your app* → Overview |

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

## Session length

Zero Trust → Access → Applications → *your app* → **Session Duration**.
Default is 24 hours; the maximum is **1 month**, which is what you want for an
installed PWA — it means roughly a dozen sign-ins a year rather than one a day.

The session is a cookie, so it survives closing the app and restarting the
phone. Signing out is deliberate: the "Sign out" link in Fred's header goes to
`https://<team>.cloudflareaccess.com/cdn-cgi/access/logout`, which ends the
Access session rather than just Fred's view of it.

## Verifying the token check

```bash
npm run verify:access
```

Mints an RSA keypair, signs tokens with it, and asserts each way verification
must fail — forged signature, tampered payload, `alg: "none"`, HS256 algorithm
confusion, expired, wrong audience, wrong team, unknown key id. Auth code that
has never rejected a bad token is untested code, and a live Access tenant
can't be stood up in a test.

The enforce path itself was exercised against the real Workers runtime via
`opennextjs-cloudflare preview` with the secrets set and `NEXTJS_ENV` removed:
unauthenticated `GET` → 401, forged cookie → 401, forged `x-fred-user` header →
401, `POST` to a server action → 401.

## Notes and limits

- **Identity.** The verified email is passed to the app as `x-fred-user` and
  shown in the header. `currentSession()` in `src/lib/session.ts` reads it.
  Fred does not yet use it for anything else — both members see the same
  household view — but per-person lenses could key off it later.
- **The service worker** never intercepts `/cdn-cgi/*` and never caches
  redirects or non-`basic` responses, so an expired session cannot get baked
  into the installed PWA's cache.
- **Automated access.** Access blocks non-browser clients too. If Fred ever
  needs a cron or external caller, that needs an Access *service token*, not a
  hole in the policy.
- **Kate's access** is just a second email in the Access policy. Zero Trust
  free covers 50 users.
- **The database credential is separately confined.** The Worker connects as
  `fred_app`, which can only SELECT/INSERT/UPDATE/DELETE — it cannot DROP,
  TRUNCATE, ALTER, create tables or create roles. The owning role never leaves
  the laptop. So a leaked Worker secret is bad but not destructive, and cannot
  be escalated into control of the Neon project. See
  [`scripts/sql/app_role.sql`](../scripts/sql/app_role.sql), step 1b of
  [DEPLOY.md](DEPLOY.md), and `npm run verify:dbrole`.
