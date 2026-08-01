import { cookies } from "next/headers";
import { DEFAULT_SCOPE, type Scope, type ScopeWho } from "./household";

// ---------------------------------------------------------------------------
// The viewing scope: whose money is on screen, everywhere at once.
//
// Read server-side from a cookie rather than passed per page, so every route
// answers the same question the same way. A page that forgot to thread the
// scope through would quietly show household totals under a "Scott" heading —
// exactly the class of inconsistency this work exists to remove.
// ---------------------------------------------------------------------------

export const SCOPE_COOKIE = "fred_scope";

/** Serialized as `who:includeHome`, e.g. `all:0`, `1:1`, `joint:0`. */
export function parseScope(raw: string | undefined): Scope {
  if (!raw) return DEFAULT_SCOPE;
  const [whoRaw, homeRaw] = raw.split(":");
  let who: ScopeWho;
  if (whoRaw === "all" || whoRaw === "joint") who = whoRaw;
  else if (/^\d+$/.test(whoRaw ?? "")) who = Number(whoRaw);
  else return DEFAULT_SCOPE;
  return { who, includeHome: homeRaw === "1" };
}

export function serializeScope(scope: Scope): string {
  return `${scope.who}:${scope.includeHome ? 1 : 0}`;
}

export async function getScope(): Promise<Scope> {
  const store = await cookies();
  return parseScope(store.get(SCOPE_COOKIE)?.value);
}

/** Heading for whatever slice is on screen — every page labels its totals with
 *  this, so a filtered number can never be mistaken for the whole. */
export function scopeLabel(
  scope: Scope,
  people: { id: number; name: string }[],
): string {
  if (scope.who === "all") return "Household";
  if (scope.who === "joint") return "Joint only";
  return people.find((p) => p.id === scope.who)?.name ?? "Unknown";
}
