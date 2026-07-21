// Harness for the Cloudflare Access token check: `npm run verify:access`.
//
// Auth code that has never rejected a bad token is untested code, and a live
// Access tenant can't be stood up in a test. So this mints its own RSA keypair,
// signs tokens with it, serves them a stub JWKS, and asserts each way the
// check must fail — forged signature, wrong app, wrong team, expired, and the
// "alg" tricks that break naive JWT verifiers.

import {
  verifyAccessJwt,
  readAccessToken,
  type AccessConfig,
} from "../src/lib/access";

const cfg: AccessConfig = {
  teamDomain: "fredtest.cloudflareaccess.com",
  aud: "aud-tag-for-fred",
};
const ISS = `https://${cfg.teamDomain}`;
const KID = "key-1";

const b64url = (bytes: Uint8Array | string) => {
  const b =
    typeof bytes === "string"
      ? Buffer.from(bytes, "utf8")
      : Buffer.from(bytes);
  return b.toString("base64url");
};

async function main() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  // A second, unrelated key: signs the "forged token" case.
  const attacker = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const jwks = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };

  let jwksRequests = 0;
  const stubFetch = (async () => {
    jwksRequests++;
    return new Response(JSON.stringify(jwks), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  async function mint(
    claims: Record<string, unknown>,
    opts: { header?: Record<string, unknown>; key?: CryptoKey } = {},
  ) {
    const header = { alg: "RS256", kid: KID, typ: "JWT", ...opts.header };
    const body = {
      iss: ISS,
      aud: [cfg.aud],
      email: "scott.schmalz@gmail.com",
      sub: "user-abc",
      iat: nowSec - 60,
      exp: nowSec + 3600,
      ...claims,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      opts.key ?? privateKey,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${b64url(new Uint8Array(sig))}`;
  }

  type Case = { name: string; token: string | null; expect: "accept" | "reject" };

  const cases: Case[] = [
    { name: "valid token from an allowed user", token: await mint({}), expect: "accept" },
    { name: "no token at all", token: null, expect: "reject" },
    { name: "not a JWT", token: "garbage", expect: "reject" },
    {
      name: "signature forged with an attacker key",
      token: await mint({}, { key: attacker.privateKey }),
      expect: "reject",
    },
    {
      name: "payload tampered after signing",
      token: await (async () => {
        const t = await mint({});
        const [h, , s] = t.split(".");
        const evil = b64url(
          JSON.stringify({
            iss: ISS,
            aud: [cfg.aud],
            email: "stranger@example.com",
            exp: nowSec + 3600,
          }),
        );
        return `${h}.${evil}.${s}`;
      })(),
      expect: "reject",
    },
    {
      name: 'alg "none" downgrade',
      token: await (async () => {
        const h = b64url(JSON.stringify({ alg: "none", kid: KID, typ: "JWT" }));
        const p = b64url(
          JSON.stringify({ iss: ISS, aud: [cfg.aud], exp: nowSec + 3600 }),
        );
        return `${h}.${p}.`;
      })(),
      expect: "reject",
    },
    {
      name: "HMAC algorithm confusion (HS256)",
      token: await mint({}, { header: { alg: "HS256" } }),
      expect: "reject",
    },
    { name: "expired session", token: await mint({ exp: nowSec - 1 }), expect: "reject" },
    {
      name: "token for a different Access application",
      token: await mint({ aud: ["some-other-app"] }),
      expect: "reject",
    },
    {
      name: "token from a different Access team",
      token: await mint({ iss: "https://someoneelse.cloudflareaccess.com" }),
      expect: "reject",
    },
    {
      name: "unknown signing key id",
      token: await mint({}, { header: { kid: "key-does-not-exist" } }),
      expect: "reject",
    },
    {
      name: "aud as a bare string (not a list)",
      token: await mint({ aud: cfg.aud }),
      expect: "accept",
    },
  ];

  let failures = 0;
  for (const c of cases) {
    const r = await verifyAccessJwt(c.token, cfg, stubFetch, now);
    const got = r.ok ? "accept" : "reject";
    const pass = got === c.expect;
    if (!pass) failures++;
    const detail = r.ok ? `email=${r.email}` : r.reason;
    console.log(
      `${pass ? "✓" : "✗"} ${c.name.padEnd(42)} ${got.padEnd(6)} ${detail}`,
    );
  }

  // The identity must come from the signed token, never from a client-set header.
  const forged = await verifyAccessJwt(
    readAccessToken({
      headers: {
        get: (n: string) =>
          n === "cf-access-jwt-assertion" ? null : n === "cookie" ? "CF_Authorization=garbage" : null,
      },
    }),
    cfg,
    stubFetch,
    now,
  );
  const cookiePathOk = !forged.ok;
  console.log(
    `${cookiePathOk ? "✓" : "✗"} ${"cookie fallback rejects garbage".padEnd(42)} ${forged.ok ? "accept" : "reject"}`,
  );
  if (!cookiePathOk) failures++;

  console.log(`\nJWKS fetches: ${jwksRequests} (cached across calls, refetched on unknown kid)`);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  return failures === 0 ? 0 : 1;

}

main().then(
  (code: number) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
