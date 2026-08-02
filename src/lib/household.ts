import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accountEntries,
  accounts,
  externalAccounts,
  persons,
  propertyPayments,
  propertyValuations,
} from "@/db/schema";
import type { ConnectionStatus } from "./providers/types";

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

/** Source identifiers. `fred` is Fred's own month-end record — the entries the
 *  monthly close writes. It is deliberately modelled as just another source so
 *  that adding source N+1 changes nothing else.
 *
 *  Note this is Fred's data, not a spreadsheet's: the workbooks were a one-time
 *  bootstrap (see docs/SEED.md) and Fred owns these entries from then on. */
export type SourceId = "fred" | "monarch" | (string & {});

/** Display names and badge icons, kept here rather than in the UI because
 *  `resolve()` writes them into its human-readable reason strings. */
export const SOURCES: Record<string, { label: string; icon: string }> = {
  fred: { label: "Fred", icon: "Ⓕ" },
  monarch: { label: "Monarch", icon: "Ⓜ" },
};
export const sourceLabel = (id: SourceId) => SOURCES[id]?.label ?? id;
export const sourceIcon = (id: SourceId) => SOURCES[id]?.icon ?? "◆";

/** Household-wide default priority per domain. Account-level overrides live
 *  in `accounts.resolution`. Freshness fallback means these rarely need
 *  changing: a source that has no data for an account simply loses. */
export const DEFAULT_PRIORITY: Record<Domain, SourceId[]> = {
  // Provider feeds update daily; Fred's own entries are month-end, so the
  // provider wins "what is it worth now" whenever it has recent data.
  live_balance: ["monarch", "fred"],
  // No provider can decompose contributions/growth/tax character — that is
  // the monthly close's whole job, so Fred is definitionally authoritative
  // here and always will be.
  monthly_close: ["fred"],
};

/** How stale a source may be before the next priority tier gets a chance.
 *  Generous for Fred because a month-end close is expected to lag. */
const STALENESS_DAYS: Record<SourceId, number> = {
  monarch: 10,
  fred: 45,
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
  /** When the underlying value was last *observed at its origin* — not when
   *  Fred fetched it. A provider that reports "today" for everything makes
   *  every rule below inert. */
  observedAt: string; // ISO date
  /** Multiple rows from one provider can describe one real account (e.g. an
   *  HSA split into cash + investment sub-accounts); those are summed. */
  parts?: number;
  /** The source itself says this value can't be trusted as live — its feed to
   *  the institution is broken or switched off. Such an observation never wins
   *  on priority, however recent its timestamp claims to be, but still serves
   *  as a last resort when nothing else knows anything. */
  untrusted?: boolean;
  /** Plain-language cause, folded into the resolution reason. */
  untrustedReason?: string;
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

/** Name each higher-priority source that lost, and why. "Monarch's connection
 *  to this institution broke 277d ago" is an actionable sentence; the old
 *  catch-all "had no current data" was not. */
function describeLosers(
  skipped: SourceId[],
  bySource: Map<SourceId, Observation>,
  asOf: string,
): string {
  const parts = skipped.map((s) => {
    const label = sourceLabel(s);
    const o = bySource.get(s);
    if (!o) return `${label} has no data for this account`;
    if (o.untrusted) return `${label} ${o.untrustedReason ?? "has a broken connection"}`;
    return `${label} was last updated ${Math.round(daysBetween(asOf, o.observedAt))}d ago`;
  });
  return parts.join("; ");
}

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
    // A source that admits its own feed is dead can't win on freshness no
    // matter what date it stamps on the value.
    if (candidate.untrusted) continue;
    const limit = STALENESS_DAYS[candidate.source] ?? DEFAULT_STALENESS_DAYS;
    const age = daysBetween(asOf, candidate.observedAt);
    if (age <= limit) {
      winner = candidate;
      reason =
        i === 0
          ? `${sourceLabel(candidate.source)} is the highest-priority source for this data and is current (${Math.round(age)}d old).`
          : `${sourceLabel(candidate.source)} won because ${describeLosers(priority.slice(0, i), bySource, asOf)}.`;
      break;
    }
  }

  // Everything stale, untrusted, or unranked: fall back to the freshest
  // observation rather than reporting nothing — but say so plainly, because
  // "we have a number" and "the number is current" are different claims.
  if (!winner) {
    winner = [...observations].sort((a, b) =>
      a.observedAt < b.observedAt ? 1 : -1,
    )[0];
    const age = Math.round(daysBetween(asOf, winner.observedAt));
    reason = winner.untrusted
      ? `No source has a live value. Showing ${sourceLabel(winner.source)} from ${winner.observedAt} (${age}d old) — ${winner.untrustedReason ?? "its connection is broken"}.`
      : `Every source is past its freshness window. Showing the most recent (${sourceLabel(winner.source)}, ${winner.observedAt}, ${age}d old).`;
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
  status: "own" | "auto" | "confirmed";
  value: number;
  observedAt: string;
  externalAccountId?: number;
  externalName?: string;
  /** Provider feed health, so the UI can say "reconnect this in Monarch"
   *  rather than silently showing a fossilized balance. */
  connectionStatus?: ConnectionStatus;
  disconnectedAt?: string | null;
  /** Age of this observation in days, for the freshness badge. */
  ageDays?: number;
};

/** How an account is known across sources — the at-a-glance answer to "what
 *  exists and how does it relate", rendered as a badge:
 *   both     — closed monthly in Fred AND synced from a provider
 *   provider — synced only, no close history yet (Kate's, joint, liabilities)
 *   fred     — closed in Fred only, no live feed (older/closed accounts) */
export type Connectivity = "both" | "provider" | "fred" | "none";

export type HouseholdAccount = {
  id: number;
  slug: string;
  name: string;
  institution: string | null;
  institutionLabel: string;
  category: string;
  taxTreatment: string;
  isLiability: boolean;
  ownerPersonId: number | null;
  isJoint: boolean;
  ownerName: string;
  ownershipShare: number;
  /** Why this account is held out of net worth, or null when it counts.
   *  See `accounts.exclusion` in src/db/schema.ts. */
  exclusion: string | null;
  tracksMonthlyClose: boolean;
  isActive: boolean;
  /** When it was archived, if it was. */
  archivedAt: string | null;
  hasStatements: boolean;
  connectivity: Connectivity;
  balance: Resolved;
  /** Balance signed for rollups (liabilities negative), and zeroed for a
   *  closed account — its history stays, but it holds nothing today. */
  signedBalance: number;
  /** Set when the winning source is stale or its feed is broken. This is the
   *  "needs attention" signal: the number is still shown, but it is the last
   *  thing anyone knew rather than the current truth. */
  staleness: { days: number; connectionStatus: ConnectionStatus | null } | null;
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
  primaryPersonId: number | null;
  /** The date every balance in this view was resolved against. */
  asOf: string;
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

  const [hubs, externals, entries, people, valuations, loanPoints] =
    await Promise.all([
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
      // The property ledger is Fred's own evidence about the house, exactly
      // as account_entries are about every other account.
      db
        .select({
          propertyId: propertyValuations.propertyId,
          date: propertyValuations.date,
          marketValue: propertyValuations.marketValue,
        })
        .from(propertyValuations)
        .orderBy(desc(propertyValuations.date)),
      // ...and about the mortgage: the lender-reported running balance, which
      // gives the loan a second source to be resolved against the provider's.
      db
        .select({
          propertyId: propertyPayments.propertyId,
          date: propertyPayments.date,
          loanBalanceAfter: propertyPayments.loanBalanceAfter,
        })
        .from(propertyPayments)
        .orderBy(desc(propertyPayments.date)),
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
  type ProviderObs = Observation & {
    names: string[];
    ids: number[];
    connectionStatus: ConnectionStatus;
    disconnectedAt: string | null;
  };
  const providerObs = new Map<number, Map<string, ProviderObs>>();
  for (const x of externals) {
    if (!x.linkedAccountId) continue;
    if (x.matchStatus !== "auto" && x.matchStatus !== "confirmed") continue;
    const perAccount = providerObs.get(x.linkedAccountId) ?? new Map<string, ProviderObs>();
    const existing = perAccount.get(x.provider);
    // No balanceAsOf means the provider never told us — assume nothing and
    // treat it as unknown-age rather than silently stamping it "today".
    const observedAt = x.balanceAsOf ?? today;
    const status = (x.connectionStatus ?? "ok") as ConnectionStatus;
    if (existing) {
      existing.value = Math.round((existing.value + x.currentBalance) * 100) / 100;
      existing.parts = (existing.parts ?? 1) + 1;
      existing.names.push(x.name);
      existing.ids.push(x.id);
      // Several rows make one account: the combined figure is only as fresh
      // and only as trustworthy as its *worst* part, so keep the oldest date
      // and let any broken part taint the whole.
      if (observedAt < existing.observedAt) existing.observedAt = observedAt;
      if (status === "broken" || status === "disabled") {
        existing.connectionStatus = status;
        existing.disconnectedAt = x.disconnectedAt ?? existing.disconnectedAt;
      }
    } else {
      perAccount.set(x.provider, {
        source: x.provider,
        value: x.currentBalance,
        observedAt,
        names: [x.name],
        ids: [x.id],
        connectionStatus: status,
        disconnectedAt: x.disconnectedAt ?? null,
      });
    }
    providerObs.set(x.linkedAccountId, perAccount);
  }

  const personName = new Map(people.map((p) => [p.id, p.name]));

  // Newest ledger figures per property, for accounts backed by one.
  const latestValuation = new Map<number, { date: string; value: number }>();
  for (const v of valuations) {
    if (!latestValuation.has(v.propertyId)) {
      latestValuation.set(v.propertyId, { date: v.date, value: v.marketValue });
    }
  }
  const latestLoan = new Map<number, { date: string; value: number }>();
  for (const p of loanPoints) {
    if (p.loanBalanceAfter == null) continue;
    if (!latestLoan.has(p.propertyId)) {
      latestLoan.set(p.propertyId, { date: p.date, value: p.loanBalanceAfter });
    }
  }

  const householdAccounts: HouseholdAccount[] = hubs.map((h) => {
    const obs: Observation[] = [];
    const chips: SourceChip[] = [];

    // Fred's own evidence: a month-end statement for most accounts, the
    // property ledger for the ones backed by a property. Both are `fred` —
    // same source, different record within it.
    const stmt = latestStatement.get(h.id);
    const ledger =
      h.propertyId == null
        ? null
        : isLiability(h.category)
          ? latestLoan.get(h.propertyId)
          : latestValuation.get(h.propertyId);
    const own = stmt ?? (ledger ? { date: ledger.date, balance: ledger.value } : null);
    if (own) {
      obs.push({ source: "fred", value: own.balance, observedAt: own.date });
      chips.push({
        source: "fred",
        status: "own",
        value: own.balance,
        observedAt: own.date,
        ageDays: Math.round(daysBetween(today, own.date)),
      });
    }
    for (const [, o] of providerObs.get(h.id) ?? []) {
      const broken = o.connectionStatus === "broken" || o.connectionStatus === "disabled";
      obs.push({
        source: o.source,
        value: o.value,
        observedAt: o.observedAt,
        parts: o.parts,
        untrusted: broken,
        untrustedReason:
          o.connectionStatus === "broken"
            ? `lost its connection to this institution${o.disconnectedAt ? ` on ${o.disconnectedAt}` : ""} and needs reconnecting`
            : o.connectionStatus === "disabled"
              ? "has syncing switched off for this account"
              : undefined,
      });
      const row = externals.find((e) => e.id === o.ids[0]);
      chips.push({
        source: o.source,
        status: (row?.matchStatus === "confirmed" ? "confirmed" : "auto") as "auto" | "confirmed",
        value: o.value,
        observedAt: o.observedAt,
        externalAccountId: o.ids[0],
        externalName: o.names.join(" + "),
        connectionStatus: o.connectionStatus,
        disconnectedAt: o.disconnectedAt,
        ageDays: Math.round(daysBetween(today, o.observedAt)),
      });
    }

    const override = (h.resolution as Record<string, SourceId[]> | null)?.live_balance;
    const balance = resolve(obs, override ?? DEFAULT_PRIORITY.live_balance, today);

    const hasProvider = chips.some((c) => c.source !== "fred");
    const connectivity: Connectivity =
      own && hasProvider
        ? "both"
        : hasProvider
          ? "provider"
          : own
            ? "fred"
            : "none";

    // Flag when the winning number is past its own freshness window — the
    // figure is still the best available, but it is history, not the present.
    const winner = obs.find((o) => o.source === balance.source);
    const age = balance.observedAt ? daysBetween(today, balance.observedAt) : 0;
    const limit = balance.source
      ? (STALENESS_DAYS[balance.source] ?? DEFAULT_STALENESS_DAYS)
      : DEFAULT_STALENESS_DAYS;
    const winnerChip = chips.find((c) => c.source === balance.source);
    const staleness =
      balance.value != null && (age > limit || winner?.untrusted)
        ? {
            days: Math.round(age),
            connectionStatus: winnerChip?.connectionStatus ?? null,
          }
        : null;

    // A closed account contributes nothing to today's picture, whatever its
    // last known balance was; its history lives on in account_entries.
    const signedBalance = h.isActive
      ? signedValue(h.category, balance.value ?? 0)
      : 0;

    return {
      id: h.id,
      slug: h.slug,
      name: h.name,
      institution: h.institution,
      institutionLabel: canonicalizeInstitution(h.institution),
      category: h.category,
      taxTreatment: h.taxTreatment,
      isLiability: isLiability(h.category),
      ownerPersonId: h.ownerPersonId,
      isJoint: h.isJoint,
      ownerName: h.isJoint
        ? "Joint"
        : (h.ownerPersonId != null ? personName.get(h.ownerPersonId) : null) ?? "Unassigned",
      ownershipShare: h.ownershipShare,
      exclusion: h.exclusion,
      tracksMonthlyClose: h.tracksMonthlyClose,
      isActive: h.isActive,
      archivedAt: h.archivedAt,
      hasStatements: Boolean(stmt),
      connectivity,
      balance,
      signedBalance,
      staleness,
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
    primaryPersonId: people.find((p) => p.isPrimary)?.id ?? null,
    asOf: today,
  };
}

// ---------------------------------------------------------------------------
// Rollups — the single calculation every screen reads
//
// Every net-worth, asset and liability figure in Fred comes from here, over
// the resolved balances above. That is the whole point: two screens can only
// disagree if they compute separately, so nothing else is allowed to.
// ---------------------------------------------------------------------------

/** Whose money to count. `all` is the household (everything at 100%); a person
 *  id is that person's share; `joint` isolates what's shared. */
export type ScopeWho = "all" | "joint" | number;

export type Scope = {
  who: ScopeWho;
  /** Count the home and its mortgage. Off by default: you always need
   *  somewhere to live, so that equity isn't spendable wealth. Both sides
   *  carry the flag, so this never counts a mortgage without its house. */
  includeHome: boolean;
};

export const DEFAULT_SCOPE: Scope = { who: "all", includeHome: false };

/**
 * What fraction of this account belongs to the selected scope.
 *
 * Household scope takes everything whole. A person takes their own accounts
 * whole and their share of anything joint — `ownership_share` is the primary
 * person's cut, so the other person gets the remainder. The shares of the two
 * people therefore add back up to the household total exactly, which is the
 * property that makes the filter trustworthy rather than merely suggestive.
 */
export function weightFor(
  a: Pick<HouseholdAccount, "ownerPersonId" | "isJoint" | "ownershipShare">,
  scope: Scope,
  primaryPersonId: number | null,
): number {
  if (scope.who === "all") return 1;
  if (scope.who === "joint") return a.isJoint ? 1 : 0;
  if (a.isJoint) {
    return scope.who === primaryPersonId
      ? a.ownershipShare
      : 1 - a.ownershipShare;
  }
  return a.ownerPersonId === scope.who ? 1 : 0;
}

/** Whether an account's exclusion flag keeps it out under this scope. */
export function isExcluded(a: Pick<HouseholdAccount, "exclusion">, scope: Scope): boolean {
  if (!a.exclusion) return false;
  if (a.exclusion === "primary_residence" && scope.includeHome) return false;
  return true;
}

export type Rollup = {
  assets: number;
  liabilities: number;
  net: number;
  /** Accounts that actually contributed, for "N of M" labelling. */
  counted: number;
  /** Held out by an exclusion flag, grouped by reason — so the UI can say
   *  what is missing from a total instead of quietly dropping it. */
  excluded: { reason: string; count: number; net: number }[];
};

export function rollup(
  accts: HouseholdAccount[],
  scope: Scope = DEFAULT_SCOPE,
  primaryPersonId: number | null = null,
): Rollup {
  let assets = 0;
  let liabilities = 0;
  let counted = 0;
  const excludedBy = new Map<string, { count: number; net: number }>();

  for (const a of accts) {
    const weight = weightFor(a, scope, primaryPersonId);
    if (weight === 0) continue;
    if (a.balance.value == null) continue;

    // signedBalance already zeroes closed accounts and negates liabilities.
    const share = a.signedBalance * weight;

    if (isExcluded(a, scope)) {
      const bucket = excludedBy.get(a.exclusion!) ?? { count: 0, net: 0 };
      bucket.count++;
      bucket.net += share;
      excludedBy.set(a.exclusion!, bucket);
      continue;
    }

    counted++;
    if (share < 0) liabilities += Math.abs(share);
    else assets += share;
  }

  return {
    assets: round2(assets),
    liabilities: round2(liabilities),
    net: round2(assets - liabilities),
    counted,
    excluded: [...excludedBy.entries()].map(([reason, v]) => ({
      reason,
      count: v.count,
      net: round2(v.net),
    })),
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Human label for an exclusion reason, used wherever a total is qualified. */
export const EXCLUSION_LABELS: Record<string, string> = {
  primary_residence: "Home equity",
  unvested: "Unvested",
  other: "Set aside",
};
export const exclusionLabel = (r: string) => EXCLUSION_LABELS[r] ?? r;

/** Accounts whose best number is stale or whose feed is broken — the
 *  "needs attention" list, distinct from sources that merely disagree. */
export function needsAttention(accts: HouseholdAccount[]) {
  return accts
    .filter((a) => a.staleness && a.isActive && (a.balance.value ?? 0) !== 0)
    .sort((a, b) => b.staleness!.days - a.staleness!.days);
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
