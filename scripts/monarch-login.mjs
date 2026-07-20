// Mint a Monarch Money API token by logging in programmatically.
//
// WHY THIS EXISTS: Monarch's web app authenticates with an httpOnly session
// cookie + CSRF token, so there is no bearer token to copy from the browser's
// Network tab. API clients instead POST credentials to /auth/login/ and get
// back a token usable as `Authorization: Token <token>`. This script does
// exactly that, prompting for your credentials locally — they are sent only to
// Monarch, never stored, printed, or shared.
//
// Usage: npm run monarch:login
// Then paste the printed values into .env (MONARCH_TOKEN, MONARCH_DEVICE_UUID).
//
// Monarch has no official API; if the login shape has drifted, this prints the
// raw server response so the payload below can be adjusted (see docs/SYNC.md).

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

const LOGIN_URL = "https://api.monarch.com/auth/login/";

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
    answer = await rl.question("");
  } finally {
    muted = false;
  }
  stdout.write("\n");
  return answer;
}

const deviceUuid = randomUUID();

const headers = {
  "Content-Type": "application/json",
  "device-uuid": deviceUuid,
  "Client-Platform": "web",
  "monarch-client": "monarch-core-web-app-graphql",
  Origin: "https://app.monarch.com",
  Referer: "https://app.monarch.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

async function attempt(body) {
  const res = await fetch(LOGIN_URL, {
    method: "POST",
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
  return blob.includes("mfa") || blob.includes("multi-factor") || blob.includes("otp");
}

async function main() {
  const email = await rl.question("Monarch email: ");
  const password = await secret("Monarch password (hidden): ");

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
    stdout.write("\nMFA required.\n");
    const code = await rl.question(
      "Multi-factor code (authenticator app or emailed code): ",
    );
    ({ status, json } = await attempt({
      ...base,
      totp: code.trim(),
      email_otp: code.trim(),
    }));
  }

  rl.close();

  if (json?.token) {
    stdout.write("\n✓ Success. Add these to .env:\n\n");
    stdout.write(`MONARCH_TOKEN=${json.token}\n`);
    stdout.write(`MONARCH_DEVICE_UUID=${deviceUuid}\n\n`);
    stdout.write(
      "Then set FRED_SYNC_PROVIDER=monarch and run a sync from the /sync page.\n",
    );
    process.exit(0);
  }

  stdout.write(
    `\n✗ Login did not return a token (HTTP ${status}). Raw response:\n`,
  );
  stdout.write(JSON.stringify(json, null, 2) + "\n\n");
  stdout.write(
    "If this shows a CAPTCHA/recaptcha requirement, use the monarchmoney-ts\n" +
      "or Python monarchmoney library instead (docs/SYNC.md); those handle it.\n",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
