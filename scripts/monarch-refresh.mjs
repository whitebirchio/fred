// Mint a Monarch Money API token by logging in programmatically, then push it
// straight into the running app — no manual copy/paste, no wrangler secret
// commands. Monarch's token lifetime is undocumented and unreliable (reports
// range from months down to hours), so this is meant to be re-run often
// enough that a refresh is a non-event.
//
// WHY LOGGING IN LOCALLY STILL EXISTS: Monarch's web app authenticates with an
// httpOnly session cookie + CSRF token, so there is no bearer token to copy
// from the browser's Network tab. API clients instead POST credentials to
// /auth/login/ and get back a token usable as `Authorization: Token <token>`.
// This script does exactly that, prompting for your credentials locally —
// they are sent only to Monarch, never stored, printed, logged, or sent
// anywhere else. Only the resulting TOKEN (not your password) is pushed to
// the deployed app.
//
// Usage: npm run monarch:refresh
// Pushes { token, deviceUuid } to FRED_APP_URL (default the production
// workers.dev URL) via POST /api/monarch-credentials, authenticated with a
// Cloudflare Access service token — see docs/SYNC.md for the one-time setup.
// If the push fails for any reason, falls back to printing the raw values so
// the old manual .env / wrangler secret path still works.
//
// Monarch has no official API; if the login shape has drifted, this prints the
// raw server response so the payload below can be adjusted (see docs/SYNC.md).

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

const LOGIN_URL = 'https://api.monarch.com/auth/login/';

// A stdout wrapper that can suppress echo on demand — the standard technique
// Node CLI tools (npm, yarn, inquirer) use for password masking, since
// readline has no public "hide input" option. Unlike toggling
// stdin.setRawMode()/pause()/resume() by hand (an earlier version of this
// script did that), this never touches raw mode itself — readline keeps
// managing that consistently for the interface's entire lifetime. Toggling
// raw mode manually mid-script left readline desynced afterward, so the
// *next* rl.question() call (for the MFA code) silently never resolved and
// the process exited once the event loop drained, with zero visible output.
// This approach was verified over a real pty (via `expect`): password stays
// masked and the following MFA prompt fires correctly.
let muted = false;
const maskedStdout = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) stdout.write(chunk);
    callback();
  },
});

// Masking only makes sense against a real terminal; forcing terminal-style
// handling onto piped/non-interactive input would fight readline's own
// detection, so fall back to plain visible input there.
const isInteractive = Boolean(stdin.isTTY);
const rl = createInterface({
  input: stdin,
  output: isInteractive ? maskedStdout : stdout,
  terminal: isInteractive,
});

async function secret(question) {
  if (!isInteractive) return rl.question(question);
  stdout.write(question);
  muted = true;
  let answer;
  try {
    answer = await rl.question('');
  } finally {
    muted = false;
  }
  stdout.write('\n');
  return answer;
}

const deviceUuid = randomUUID();

const headers = {
  'Content-Type': 'application/json',
  'device-uuid': deviceUuid,
  'Client-Platform': 'web',
  'monarch-client': 'monarch-core-web-app-graphql',
  Origin: 'https://app.monarch.com',
  Referer: 'https://app.monarch.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

async function attempt(body) {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = { error: `HTTP ${res.status}, non-JSON response` };
  }
  return { status: res.status, json };
}

function looksLikeMfa(status, json) {
  if (status === 403) return true;
  const blob = JSON.stringify(json ?? {}).toLowerCase();
  return (
    blob.includes('mfa') ||
    blob.includes('multi-factor') ||
    blob.includes('otp')
  );
}

const DEFAULT_APP_URL = 'https://fred.whitebirch.workers.dev';

function printManualFallback(token, deviceUuid) {
  stdout.write('\nFalling back to the manual path — add these yourself:\n\n');
  stdout.write(`MONARCH_TOKEN=${token}\n`);
  stdout.write(`MONARCH_DEVICE_UUID=${deviceUuid}\n\n`);
  stdout.write(
    'Locally: put them in .env. Deployed: `npx wrangler secret put MONARCH_TOKEN`\n' +
      'and `npx wrangler secret put MONARCH_DEVICE_UUID` (these only work as a\n' +
      'fallback the app checks if it has no database-stored token — see docs/SYNC.md).\n',
  );
}

// Pushes the token to the running app instead of making you copy/paste it.
// Never throws — any failure degrades to printing the raw values, the same
// manual path this replaces, so a broken push never strands you.
async function pushOrFallBack(token, deviceUuid) {
  const appUrl = (process.env.FRED_APP_URL ?? DEFAULT_APP_URL).replace(
    /\/$/,
    '',
  );
  const headers = { 'Content-Type': 'application/json' };
  if (
    process.env.CF_ACCESS_SERVICE_CLIENT_ID &&
    process.env.CF_ACCESS_SERVICE_CLIENT_SECRET
  ) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_SERVICE_CLIENT_ID;
    headers['CF-Access-Client-Secret'] =
      process.env.CF_ACCESS_SERVICE_CLIENT_SECRET;
  } else if (!appUrl.includes('localhost')) {
    stdout.write(
      '\n⚠ CF_ACCESS_SERVICE_CLIENT_ID/SECRET not set — the deployed app is behind\n' +
        'Cloudflare Access, so this push will almost certainly be rejected.\n' +
        'One-time setup: docs/SYNC.md § Keeping the token fresh.\n',
    );
  }

  console.info('HEADERS', headers);

  try {
    // redirect: "manual" is load-bearing. Cloudflare Access rejects an
    // unauthenticated request with a 302 to its own login page — and that
    // login page itself returns a normal HTTP 200 HTML document. Node's
    // fetch() follows redirects by default and reports `ok` on the *final*
    // response, so a plain `res.ok` check cannot tell "reached the API and
    // succeeded" apart from "got bounced to Access's sign-in page" — both
    // look like a 200. Manual mode surfaces the redirect instead of quietly
    // wandering off to it.
    const res = await fetch(`${appUrl}/api/monarch-credentials`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token, deviceUuid }),
      redirect: 'manual',
    });

    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      stdout.write(
        `\n✗ Push to ${appUrl} was redirected (HTTP ${res.status || 'opaque'}) instead of reaching the app —\n` +
          "Cloudflare Access didn't accept this request as authenticated.\n" +
          'Check CF_ACCESS_SERVICE_CLIENT_ID/SECRET in .env and that the service\n' +
          'token has an Allow policy on the Access application (docs/SYNC.md § Keeping\n' +
          'the token fresh).\n',
      );
      printManualFallback(token, deviceUuid);
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      stdout.write(
        `\n✗ Push to ${appUrl} failed: HTTP ${res.status} ${text}\n`,
      );
      printManualFallback(token, deviceUuid);
      return;
    }

    // Belt and braces: a 2xx alone doesn't prove this is *my* route — verify
    // the body actually looks like the response saveMonarchCredentials'
    // caller returns, not just "some server said OK".
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!body?.ok) {
      stdout.write(
        `\n✗ Push to ${appUrl} returned HTTP ${res.status} but not the expected response —\n` +
          `got: ${JSON.stringify(body).slice(0, 200)}\n`,
      );
      printManualFallback(token, deviceUuid);
      return;
    }

    stdout.write(`\n✓ Token refreshed and pushed to ${appUrl}.\n`);
    stdout.write('No further steps — the next sync will use it.\n');
  } catch (err) {
    stdout.write(`\n✗ Could not reach ${appUrl}: ${err.message}\n`);
    printManualFallback(token, deviceUuid);
  }
}

async function main() {
  const email = await rl.question('Monarch email: ');
  const password = await secret('Monarch password (hidden): ');

  const base = {
    username: email,
    password,
    trusted_device: true, // request a long-lived token
    supports_mfa: true,
    supports_email_otp: true,
    supports_recaptcha: true,
  };

  let { status, json } = await attempt(base);

  if (!json?.token && looksLikeMfa(status, json)) {
    stdout.write('\nMFA required.\n');
    const code = await rl.question(
      'Multi-factor code (authenticator app or emailed code): ',
    );
    ({ status, json } = await attempt({
      ...base,
      totp: code.trim(),
      email_otp: code.trim(),
    }));
  }

  rl.close();

  if (json?.token) {
    await pushOrFallBack(json.token, deviceUuid);
    process.exit(0);
  }

  stdout.write(
    `\n✗ Login did not return a token (HTTP ${status}). Raw response:\n`,
  );
  stdout.write(JSON.stringify(json, null, 2) + '\n\n');
  stdout.write(
    'If this shows a CAPTCHA/recaptcha requirement, use the monarchmoney-ts\n' +
      'or Python monarchmoney library instead (docs/SYNC.md); those handle it.\n',
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
