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

const LOGIN_URL = "https://api.monarch.com/auth/login/";

const rl = createInterface({ input: stdin, output: stdout });

// Minimal hidden input for the password (mutes echo while typing).
function secret(question) {
  stdout.write(question);
  return new Promise((resolve) => {
    let buf = "";
    const onData = (char) => {
      const s = char.toString("utf8");
      if (s === "\n" || s === "\r" || s === "") {
        // Enter / Ctrl-D
        stdin.removeListener("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
        stdout.write("\n");
        resolve(buf);
      } else if (s === "") {
        // Ctrl-C
        stdout.write("\n");
        process.exit(1);
      } else if (s === "" || s === "\b") {
        // backspace / DEL
        buf = buf.slice(0, -1);
      } else {
        buf += s;
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
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
