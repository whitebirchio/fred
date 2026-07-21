import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accountEntries,
  accounts,
  externalAccounts,
  persons,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// The household model (docs/HOUSEHOLD.md)
//
// A household account is the canonical entity; a source record is never an
// account, only *evidence about* one. This module resolves that evidence into
// a single answer per data domain, and always returns provenance alongside
// the number so the UI can explain which source won and why.
//
// The invariant that prevents double counting: only evidence that is linked
// to a hub account AND whose match status is auto|confirmed is ever read.
// Pending and ignored evidence contributes to nothing.
// ---------------------------------------------------------------------------

/** Data domains resolve independently — see the priority table in the doc. */
export type Domain = "live_balance" | "monthly_close";

/** Source identifiers. `statements` is Fred's own data, deliberately treated
 *  as just another source so that adding source N+1 changes nothing else. */
export type SourceId = "statements" | "monarch" | (string & {});

/** Household-wide default priority per domain. Account-level overrides live
 *  in `accounts.resolution`. Freshness fallback means these rarely need
 *  changing: a source that has no data for an account simply loses. */
export const DEFAULT_PRIORITY: Record<Domain, SourceId[]> = {
  // Provider feeds update daily; statements are month-end, so the provider
  // wins "what is it worth now" whenever it has recent data.
  live_balance: ["monarch", "statements"],
  // No provider can decompose contributions/growth/tax character — that is
  // the monthly close's whole job, so statements are definitionally
  // authoritative here.
  monthly_close: ["statements"],
};

/** How stale a source may be before the next priority tier gets a chance.
 *  Generous for statements because a month-end close is expected to lag. */
const STALENESS_DAYS: Record<SourceId, number> = {
  monarch: 10,
  statements: 45,
};
const DEFAULT_STALENESS_DAYS = 45;

const LIABILITY_CATEGORIES = new Set(["credit", "loan"]);
export const isLiability = (category: string) =>
  LIABILITY_CATEGORIES.has(category);

/** Liability balances are stored as positive magnitudes; the sign is applied
 *  here so a card balance can never read as an asset. */
export const signedValue = (category: string, value: number) =>
  isLiability(category) ? -Math.abs(value) : value;

export type Observation = {
  source: SourceId;
  value: number;
  observedAt: string; // ISO date
  /** Multiple rows from one provider can describe one real account (e.g. an
   *  HSA split into cash + investment sub-accounts); those are summed. */
  parts?: number;
};

export type Resolved = {
  value: number | null;
  source: SourceId | null;
  observedAt: string | null;
  /** Why this source won — rendered verbatim in the UI tooltip. */
  reason: string;
  alternatives: Observation[];
  /** Largest disagreement between the winner and any alternative. */
  conflict: { source: SourceId; value: number; delta: number } | null;
};

const daysBetween = (a: string, b: string) =>
  Math.abs(
    (Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000,
  );

const CONFLICT_TOLERANCE = 1; // dollars

/**
 * Resolve one domain for one account: walk the priority order, take the first
 * source with data inside its staleness window, and explain the choice. Falls
 * back to the freshest available source if every candidate is stale, so a
 * number is only ever null when there is genuinely no evidence.
 */
export function resolve(
  observations: Observation[],
  priority: SourceId[],
  asOf: string,
): Resolved {
  if (observations.length === 0) {
    return {
      value: null,
      source: null,
      observedAt: null,
      reason: "No source has data for this account.",
      alternatives: [],
      conflict: null,
    };
  }

  const bySource = new Map(observations.map((o) => [o.source, o]));
  let winner: Observation | undefined;
  let reason = "";

  for (let i = 0; i < priority.length; i++) {
    const candidate = bySource.get(priority[i]);
    if (!candidate) continue;
    const limit = STALENESS_DAYS[candidate.source] ?? DEFAULT_STALENESS_DAYS;
    const age = daysBetween(asOf, candidate.observedAt);
    if (age <= limit) {
      winner = candidate;
      reason =
        i === 0
          ? `${candidate.source} is the highest-priority source for this data and is current (${Math.round(age)}d old).`
          : `${candidate.source} won because ${priority
              .slice(0, i)
              .join(", ")} had no current data for this account.`;
      break;
    }
  }

  // Everything stale (or unranked): fall back to the freshest observation
  // rather than reporting nothing.
  if (!winner) {
    winner = [...observations].sort((a, b) =>
      a.observedAt < b.observedAt ? 1 : -1,
    )[0];
    reason = `All sources are stale; showing the most recent (${winner.source}, ${winner.observedAt}).`;
  }

  const alternatives = observations.filter((o) => o.source !== winner!.source);
  let conflict: Resolved["conflict"] = null;
  for (const alt of alternatives) {
    const delta = Math.round((alt.value - winner.value) * 100) / 100;
    if (Math.abs(delta) > CONFLICT_TOLERANCE) {
      if (!conflict || Math.abs(delta) > Math.abs(conflict.delta)) {
        conflict = { source: alt.source, value: alt.value, delta };
      }
    }
  }

  return {
    value: winner.value,
    source: winner.source,
    observedAt: winner.observedAt,
    reason,
    alternatives,
    conflict,
  };
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export type SourceChip = {
  source: SourceId;
  status: "statements" | "auto" | "confirmed";
  value: number;
  observedAt: string;
  externalAccountId?: number;
  externalName?: string;
};

/** How an account is known across sources — the at-a-glance answer to "what
 *  exists and how does it relate", rendered as a badge:
 *   both       — tracked in the spreadsheet AND synced from a provider
 *   provider   — synced only (Kate's, the kids', joint, liabilities)
 *   statements — spreadsheet only, no live feed (older/closed accounts) */
export type Connectivity = "both" | "provider" | "statements" | "none";

export type HouseholdAccount = {
  id: number;
  slug: string;
  name: string;
  institution: string | null;
  institutionLabel: string;
  category: string;
  isLiability: boolean;
  ownerPersonId: number | null;
  ownerName: string;
  ownershipShare: number;
  includeInHousehold: boolean;
  isActive: boolean;
  hasStatements: boolean;
  connectivity: Connectivity;
  balance: Resolved;
  /** Balance signed for rollups (liabilities negative). */
  signedBalance: number;
  sources: SourceChip[];
};

export type PendingSource = {
  id: number;
  provider: string;
  name: string;
  institution: string | null;
  accountType: string | null;
  isAsset: boolean;
  balance: number;
  balanceAsOf: string | null;
  suggestions: { accountId: number; name: string; score: number; why: string }[];
};

export type HouseholdView = {
  accounts: HouseholdAccount[];
  pending: PendingSource[];
  ignored: { id: number; name: string; note: string | null }[];
  people: { id: number; name: string; isPrimary: boolean }[];
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Canonical institution label for grouping — collapses "Ally Bank"/"Ally",
 *  "Fidelity"/"Fidelity NetBenefits", "Optum Bank - Health Savings Account"
 *  etc. onto one heading so an account and its synced twin land together. */
const INSTITUTION_ALIASES: [RegExp, string][] = [
  [/vanguard/i, "Vanguard"],
  [/ally/i, "Ally"],
  [/fidelity/i, "Fidelity"],
  [/coinbase/i, "Coinbase"],
  [/optum/i, "Optum"],
  [/chase/i, "Chase"],
  [/treasury/i, "TreasuryDirect"],
  [/robinhood/i, "Robinhood"],
  [/alpaca/i, "Alpaca"],
  [/td\s*ameritrade/i, "TD Ameritrade"],
  [/becu/i, "BECU"],
  [/lighthouse/i, "Lighthouse CU"],
  [/usaa/i, "USAA"],
  [/toyota/i, "Toyota Financial"],
];
export function canonicalizeInstitution(raw: string | null): string {
  if (!raw) return "Other";
  for (const [re, label] of INSTITUTION_ALIASES) if (re.test(raw)) return label;
  // Employer-plan codes (LM = Lockheed, HS = a prior employer) stay as-is.
  return raw.trim();
}

/** Person tokens appearing in account names. Monarch prefixes names with the
 *  owner ("Kate 401(k)", "Scott + Kate Savings"), which is the single most
 *  useful signal for *rejecting* a match: without it, "Kate 401(k)" happily
 *  scores against Scott's "LM 401(k)" on the shared "401k" token alone. */
const PERSON_TOKENS = ["scott", "kate", "sophia", "luke"];

export function peopleIn(name: string): string[] {
  const n = norm(name);
  return PERSON_TOKENS.filter((p) => n.includes(p));
}

/** Owner implied by an account name: one person, joint if several, else null. */
export function inferOwnerToken(name: string): string | "joint" | null {
  const found = peopleIn(name);
  if (found.length === 0) return null;
  return found.length > 1 ? "joint" : found[0];
}

/** Below this, a suggestion is noise — better to offer "add as new". */
const SUGGESTION_FLOOR = 45;

/** Rank hub accounts as candidate matches for an unreviewed source record.
 *  Name/institution similarity plus balance proximity — the same signals a
 *  human would use, surfaced as ranked suggestions rather than auto-applied. */
export function suggestMatches(
  ext: { name: string; institution: string | null; currentBalance: number },
  hubs: {
    id: number;
    name: string;
    institution: string | null;
    latestBalance: number | null;
  }[],
  takenAccountIds: Set<number>,
): PendingSource["suggestions"] {
  const extName = norm(ext.name);
  const extInst = norm(ext.institution ?? "");
  const out: PendingSource["suggestions"] = [];

  const extPeople = peopleIn(ext.name);

  for (const h of hubs) {
    if (takenAccountIds.has(h.id)) continue;
    const hubName = norm(h.name);
    const hubInst = norm(h.institution ?? "");
    let score = 0;
    const why: string[] = [];

    // Hard veto on cross-person matches. Fred's own accounts are Scott's, so
    // a source naming only someone else cannot be the same account no matter
    // how well the rest matches.
    const hubPeople = peopleIn(h.name);
    if (
      extPeople.length > 0 &&
      !extPeople.includes("scott") &&
      hubPeople.every((p) => !extPeople.includes(p))
    ) {
      continue;
    }

    // Institution agreement is a strong signal — but only for names long
    // enough to be distinctive. A 2-letter institution like "HS" otherwise
    // substring-matches inside "OptumBank-HealthSavings" ("healt-HS-avings")
    // and manufactures confident nonsense.
    const MIN_INST = 4;
    if (
      extInst.length >= MIN_INST &&
      hubInst.length >= MIN_INST &&
      (extInst.includes(hubInst) || hubInst.includes(extInst))
    ) {
      score += 30;
      why.push("same institution");
    }

    // A jointly-named source is not the same account as a single-owner hub
    // (and vice versa) — same institution and type is exactly when this
    // mistake is tempting.
    const extOwner = inferOwnerToken(ext.name);
    const hubOwner = inferOwnerToken(h.name);
    if (extOwner === "joint" && hubOwner !== "joint") {
      score -= 30;
      why.push("joint vs individual — verify");
    }
    // Shared distinctive name tokens ("roth", "sep", "pension", "hsa"…).
    const tokens = ["roth", "sep", "traditional", "pension", "hsa", "401k", "ibond", "brokerage", "savings", "checking", "crypto", "cashplus"];
    const hits = tokens.filter((t) => extName.includes(t) && hubName.includes(t));
    if (hits.length) {
      score += 25 * hits.length;
      why.push(`matches “${hits.join(", ")}”`);
    }
    // Balance proximity — the decisive tiebreaker for same-shaped names.
    if (h.latestBalance != null && h.latestBalance !== 0 && ext.currentBalance !== 0) {
      const rel =
        Math.abs(ext.currentBalance - h.latestBalance) /
        Math.max(Math.abs(h.latestBalance), 1);
      if (rel < 0.02) {
        score += 45;
        why.push("balance within 2%");
      } else if (rel < 0.1) {
        score += 25;
        why.push("balance within 10%");
      }
    }
    if (score >= SUGGESTION_FLOOR) {
      out.push({ accountId: h.id, name: h.name, score, why: why.join(", ") });
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// ---------------------------------------------------------------------------
// Auto-match
// ---------------------------------------------------------------------------

/** A source only auto-merges when its single best match is this confident.
 *  At this level a match requires same institution + a shared distinctive
 *  token + balance within 2% (30+25+45), which in practice is only ever the
 *  right account. Anything below stays in the guided review. */
export const AUTO_MATCH_THRESHOLD = 90;

/**
 * Link every pending source whose top match clears the confidence bar and is
 * unambiguous (no runner-up also above the bar). Fully reversible — it sets
 * matchStatus 'auto', which the roster flags with an undo. Idempotent; safe
 * to run after every sync and on the existing backlog.
 */
export async function autoMatchConfident(): Promise<
  { externalId: number; externalName: string; accountId: number; accountName: string; score: number }[]
> {
  const [hubs, externals, entries] = await Promise.all([
    db.select().from(accounts),
    db.select().from(externalAccounts),
    db
      .select({
        accountId: accountEntries.accountId,
        statementDate: accountEntries.statementDate,
        balance: accountEntries.balance,
      })
      .from(accountEntries)
      .orderBy(desc(accountEntries.statementDate)),
  ]);

  const latest = new Map<number, number>();
  for (const e of entries) if (!latest.has(e.accountId)) latest.set(e.accountId, e.balance);
  const hubSummaries = hubs.map((h) => ({
    id: h.id,
    name: h.name,
    institution: h.institution,
    latestBalance: latest.get(h.id) ?? null,
  }));

  const taken = new Set(
    externals
      .filter((e) => e.linkedAccountId && (e.matchStatus === "auto" || e.matchStatus === "confirmed"))
      .map((e) => e.linkedAccountId!),
  );

  // Highest-confidence first, so if two sources want the same hub the better
  // one claims it and the other falls through to review.
  const pending = externals
    .filter((e) => e.matchStatus === "pending")
    .map((e) => ({ e, sugg: suggestMatches(e, hubSummaries, taken) }))
    .filter((x) => x.sugg[0])
    .sort((a, b) => b.sugg[0].score - a.sugg[0].score);

  const merged: Awaited<ReturnType<typeof autoMatchConfident>> = [];
  for (const { e } of pending) {
    const sugg = suggestMatches(e, hubSummaries, taken); // fresh vs current taken
    const top = sugg[0];
    if (!top || top.score < AUTO_MATCH_THRESHOLD) continue;
    if (sugg[1] && sugg[1].score >= AUTO_MATCH_THRESHOLD) continue; // ambiguous
    await db
      .update(externalAccounts)
      .set({ linkedAccountId: top.accountId, matchStatus: "auto", matchNote: null })
      .where(eq(externalAccounts.id, e.id));
    taken.add(top.accountId);
    merged.push({
      externalId: e.id,
      externalName: e.name,
      accountId: top.accountId,
      accountName: top.name,
      score: top.score,
    });
  }
  return merged;
}

/** Count of sources still needing a human decision (drives the review band). */
export async function pendingCount(): Promise<number> {
  const rows = await db
    .select({ id: externalAccounts.id })
    .from(externalAccounts)
    .where(and(eq(externalAccounts.matchStatus, "pending")));
  return rows.length;
}

/** Build the whole household view in one pass. */
export async function loadHousehold(asOf?: string): Promise<HouseholdView> {
  const today = asOf ?? new Date().toISOString().slice(0, 10);

  const [hubs, externals, entries, people] = await Promise.all([
    db.select().from(accounts).orderBy(accounts.sortOrder),
    db.select().from(externalAccounts),
    db
      .select({
        accountId: accountEntries.accountId,
        statementDate: accountEntries.statementDate,
        balance: accountEntries.balance,
      })
      .from(accountEntries)
      .orderBy(desc(accountEntries.statementDate)),
    db.select().from(persons),
  ]);

  // Latest statement observation per hub account.
  const latestStatement = new Map<number, { date: string; balance: number }>();
  for (const e of entries) {
    if (!latestStatement.has(e.accountId)) {
      latestStatement.set(e.accountId, {
        date: e.statementDate,
        balance: e.balance,
      });
    }
  }

  // Counted evidence only: linked + auto|confirmed. Multiple rows from one
  // provider for the same hub are summed (HSA cash + investments, etc.).
  const providerObs = new Map<number, Map<string, Observation & { names: string[]; ids: number[] }>>();
  for (const x of externals) {
    if (!x.linkedAccountId) continue;
    if (x.matchStatus !== "auto" && x.matchStatus !== "confirmed") continue;
    const perAccount = providerObs.get(x.linkedAccountId) ?? new Map();
    const existing = perAccount.get(x.provider);
    const observedAt = x.balanceAsOf ?? today;
    if (existing) {
      existing.value = Math.round((existing.value + x.currentBalance) * 100) / 100;
      existing.parts = (existing.parts ?? 1) + 1;
      existing.names.push(x.name);
      existing.ids.push(x.id);
      if (observedAt > existing.observedAt) existing.observedAt = observedAt;
    } else {
      perAccount.set(x.provider, {
        source: x.provider,
        value: x.currentBalance,
        observedAt,
        names: [x.name],
        ids: [x.id],
      });
    }
    providerObs.set(x.linkedAccountId, perAccount);
  }

  const personName = new Map(people.map((p) => [p.id, p.name]));

  const householdAccounts: HouseholdAccount[] = hubs.map((h) => {
    const obs: Observation[] = [];
    const chips: SourceChip[] = [];

    const stmt = latestStatement.get(h.id);
    if (stmt) {
      obs.push({ source: "statements", value: stmt.balance, observedAt: stmt.date });
      chips.push({
        source: "statements",
        status: "statements",
        value: stmt.balance,
        observedAt: stmt.date,
      });
    }
    for (const [, o] of providerObs.get(h.id) ?? []) {
      obs.push({ source: o.source, value: o.value, observedAt: o.observedAt, parts: o.parts });
      const row = externals.find((e) => e.id === o.ids[0]);
      chips.push({
        source: o.source,
        status: (row?.matchStatus === "confirmed" ? "confirmed" : "auto") as "auto" | "confirmed",
        value: o.value,
        observedAt: o.observedAt,
        externalAccountId: o.ids[0],
        externalName: o.names.join(" + "),
      });
    }

    const override = (h.resolution as Record<string, SourceId[]> | null)?.live_balance;
    const balance = resolve(obs, override ?? DEFAULT_PRIORITY.live_balance, today);

    const hasProvider = chips.some((c) => c.source !== "statements");
    const connectivity: Connectivity =
      stmt && hasProvider
        ? "both"
        : hasProvider
          ? "provider"
          : stmt
            ? "statements"
            : "none";

    return {
      id: h.id,
      slug: h.slug,
      name: h.name,
      institution: h.institution,
      institutionLabel: canonicalizeInstitution(h.institution),
      category: h.category,
      isLiability: isLiability(h.category),
      ownerPersonId: h.ownerPersonId,
      ownerName: h.isJoint
        ? "Joint"
        : (h.ownerPersonId != null ? personName.get(h.ownerPersonId) : null) ?? "Unassigned",
      ownershipShare: h.ownershipShare,
      includeInHousehold: h.includeInHousehold,
      isActive: h.isActive,
      hasStatements: Boolean(stmt),
      connectivity,
      balance,
      signedBalance: signedValue(h.category, balance.value ?? 0),
      sources: chips,
    };
  });

  // Review queue, with ranked suggestions.
  const taken = new Set(
    externals
      .filter((e) => e.linkedAccountId && (e.matchStatus === "auto" || e.matchStatus === "confirmed"))
      .map((e) => e.linkedAccountId!),
  );
  const hubSummaries = hubs.map((h) => ({
    id: h.id,
    name: h.name,
    institution: h.institution,
    latestBalance: latestStatement.get(h.id)?.balance ?? null,
  }));

  const pending: PendingSource[] = externals
    .filter((e) => e.matchStatus === "pending")
    .sort((a, b) => Math.abs(b.currentBalance) - Math.abs(a.currentBalance))
    .map((e) => ({
      id: e.id,
      provider: e.provider,
      name: e.name,
      institution: e.institution,
      accountType: e.accountType,
      isAsset: e.isAsset,
      balance: e.currentBalance,
      balanceAsOf: e.balanceAsOf,
      suggestions: suggestMatches(e, hubSummaries, taken),
    }));

  const ignored = externals
    .filter((e) => e.matchStatus === "ignored")
    .map((e) => ({ id: e.id, name: e.name, note: e.matchNote }));

  return {
    accounts: householdAccounts,
    pending,
    ignored,
    people: people.map((p) => ({ id: p.id, name: p.name, isPrimary: p.isPrimary })),
  };
}

/** Rollup over whatever slice of the roster the user has selected. */
export function rollup(accts: HouseholdAccount[]) {
  let assets = 0;
  let liabilities = 0;
  for (const a of accts) {
    if (!a.includeInHousehold) continue;
    if (a.balance.value == null) continue;
    if (a.isLiability) liabilities += Math.abs(a.balance.value);
    else assets += a.balance.value;
  }
  return {
    assets: Math.round(assets * 100) / 100,
    liabilities: Math.round(liabilities * 100) / 100,
    net: Math.round((assets - liabilities) * 100) / 100,
  };
}

/** Accounts whose sources disagree beyond tolerance — the generalized form of
 *  the old /sync verification table. */
export function conflicts(accts: HouseholdAccount[]) {
  return accts
    .filter((a) => a.balance.conflict)
    .sort(
      (a, b) =>
        Math.abs(b.balance.conflict!.delta) - Math.abs(a.balance.conflict!.delta),
    );
}
