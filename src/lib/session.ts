// Server-only: importing `next/headers` already fails in a client component,
// so no extra guard dependency is needed.
import { headers } from "next/headers";
import { IDENTITY_HEADER, accessConfig, authMode, logoutUrlFor } from "./access";

export type Session = {
  /** Verified email from the Access token; null when auth is not enforced. */
  email: string | null;
  /** Where to send the user to actually end the session (Access owns it). */
  logoutUrl: string | null;
  /** False in local dev, where there is no edge in front to authenticate. */
  enforced: boolean;
};

/**
 * Who is signed in, according to the Access token the proxy already verified.
 *
 * The proxy sets `IDENTITY_HEADER` from the token's claims and strips any
 * inbound copy, so this value cannot be forged by a client sending the header.
 */
export async function currentSession(): Promise<Session> {
  const enforced = authMode() === "enforce";
  if (!enforced) return { email: null, logoutUrl: null, enforced: false };
  const cfg = accessConfig();
  return {
    email: (await headers()).get(IDENTITY_HEADER),
    logoutUrl: cfg ? logoutUrlFor(cfg) : null,
    enforced: true,
  };
}
