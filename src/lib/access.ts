// ---------------------------------------------------------------------------
// Cloudflare Access verification (docs/AUTH.md)
//
// Access is the real gate: it authenticates at Cloudflare's edge, so an
// unauthenticated request never reaches this Worker at all. What lives here is
// defence in depth — the app independently proves that every request carries a
// valid Access token, so the app is not left wide open if Access is ever
// switched off, or if a route/custom domain is later added without it.
//
// Deliberately dependency-free: verification is ~40 lines of Web Crypto, and
// the Worker bundle is close to the free plan's 3 MB cap.
// ---------------------------------------------------------------------------

export type AccessConfig = { teamDomain: string; aud: string };

/** Where the secrets are read from. At the Worker entrypoint this is the
 *  `env` binding — `process.env` is not populated until OpenNext enters the
 *  request context, so the entrypoint must pass `env` explicitly. */
export type EnvSource = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);

/** Present only once both secrets are set — see docs/DEPLOY.md. */
export function accessConfig(
  source: EnvSource = process.env,
): AccessConfig | null {
  const teamDomain = str(source.CF_ACCESS_TEAM_DOMAIN);
  const aud = str(source.CF_ACCESS_AUD);
  if (!teamDomain || !aud) return null;
  // Accept either "yourteam" or the full "yourteam.cloudflareaccess.com".
  const host = teamDomain.includes(".")
    ? teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : `${teamDomain}.cloudflareaccess.com`;
  return { teamDomain: host, aud };
}

export const issuerFor = (cfg: AccessConfig) => `https://${cfg.teamDomain}`;
export const certsUrlFor = (cfg: AccessConfig) =>
  `${issuerFor(cfg)}/cdn-cgi/access/certs`;
/** Ends the Access session (not just Fred's view of it). */
export const logoutUrlFor = (cfg: AccessConfig) =>
  `${issuerFor(cfg)}/cdn-cgi/access/logout`;

export type VerifyResult =
  | { ok: true; email: string | null; sub: string | null }
  | { ok: false; reason: string };

type Jwk = { kid?: string; kty?: string; alg?: string; use?: string };

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const decodeJson = (segment: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));

// Per-isolate JWKS cache. Purely an optimisation — a miss just refetches, so
// correctness never depends on it surviving (proxy code must not rely on
// globals persisting).
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { url: string; at: number; keys: Map<string, CryptoKey> } | null =
  null;

async function loadKeys(
  cfg: AccessConfig,
  fetchImpl: typeof fetch,
  force = false,
): Promise<Map<string, CryptoKey>> {
  const url = certsUrlFor(cfg);
  const fresh =
    jwksCache &&
    jwksCache.url === url &&
    Date.now() - jwksCache.at < JWKS_TTL_MS;
  if (fresh && !force) return jwksCache!.keys;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { ...jwk, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  jwksCache = { url, at: Date.now(), keys };
  return keys;
}

/**
 * Verify an Access JWT: signature against the team's published keys, plus
 * issuer, audience and expiry. Returns the identity rather than a boolean so
 * the app can show who is signed in.
 */
export async function verifyAccessJwt(
  token: string | null | undefined,
  cfg: AccessConfig,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<VerifyResult> {
  if (!token) return { ok: false, reason: "no Access token on the request" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return { ok: false, reason: "undecodable token" };
  }

  if (header.alg !== "RS256") {
    // Never honour the token's own claim about which algorithm to trust:
    // "alg": "none" and HMAC confusion are the classic JWT forgeries.
    return { ok: false, reason: `unexpected alg ${String(header.alg)}` };
  }
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) return { ok: false, reason: "token has no key id" };

  let keys = await loadKeys(cfg, fetchImpl);
  let key = keys.get(kid);
  if (!key) {
    // Unknown kid usually means Access rotated its signing keys — refetch once
    // before rejecting, otherwise a rotation locks everyone out for an hour.
    keys = await loadKeys(cfg, fetchImpl, true);
    key = keys.get(kid);
  }
  if (!key) return { ok: false, reason: "signing key not recognised" };

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]) as unknown as BufferSource,
    signed as unknown as BufferSource,
  );
  if (!valid) return { ok: false, reason: "bad signature" };

  if (payload.iss !== issuerFor(cfg)) {
    return { ok: false, reason: "issued by a different Access team" };
  }
  // `aud` is a list of application AUD tags; ours must be among them, or the
  // token belongs to a different app behind the same team.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.aud)) {
    return { ok: false, reason: "token is for a different application" };
  }

  const seconds = now / 1000;
  if (typeof payload.exp === "number" && payload.exp <= seconds) {
    return { ok: false, reason: "session expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) {
    return { ok: false, reason: "token not yet valid" };
  }

  return {
    ok: true,
    email: typeof payload.email === "string" ? payload.email : null,
    sub: typeof payload.sub === "string" ? payload.sub : null,
  };
}

/** Access sends the JWT as a header; the cookie is the browser-navigation
 *  fallback for requests it did not add the header to. */
export function readAccessToken(req: {
  headers: { get(name: string): string | null };
}): string | null {
  const header = req.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = req.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Where enforcement applies
// ---------------------------------------------------------------------------

const isWorkers = () =>
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers";

/**
 * `skip`         — local dev / `npm run preview`: no edge in front, nothing to verify.
 * `enforce`      — deployed Worker with Access configured.
 * `misconfigured`— deployed Worker *without* the secrets. Fails closed rather
 *                  than serving financial data unverified (same stance as the
 *                  DATABASE_URL check in src/db/index.ts).
 */
export function authMode(
  source: EnvSource = process.env,
): "skip" | "enforce" | "misconfigured" {
  if (str(source.NEXTJS_ENV) === "development") return "skip";
  if (!isWorkers()) return "skip";
  return accessConfig(source) ? "enforce" : "misconfigured";
}

/** Header the proxy uses to hand the verified identity to the app. It is set
 *  or stripped on every request, never passed through, so a client cannot
 *  forge it by sending the header itself. */
export const IDENTITY_HEADER = "x-fred-user";
