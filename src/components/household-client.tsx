"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { money } from "@/lib/format";
import { CATEGORY_META } from "@/lib/categories";
import { Card, StatTile } from "@/components/ui";
import {
  linkSource,
  promoteSource,
  ignoreSource,
  unlinkSource,
  updateHouseholdAccount,
} from "@/app/actions";
import { sourceIcon, sourceLabel } from "@/lib/household";
import type { HouseholdAccount, PendingSource, Connectivity } from "@/lib/household";
import { DeleteAccountControl } from "@/components/delete-account-control";

// ---------------------------------------------------------------------------
// Plain-language helpers. The model underneath talks "sources / provenance /
// match status"; the UI never does.
// ---------------------------------------------------------------------------

const catLabel = (c: string) => CATEGORY_META[c].name;
const catColor = (c: string) => CATEGORY_META[c].color;

const CONNECTIVITY: Record<
  Connectivity,
  { label: string; title: string; tone: string }
> = {
  both: {
    label: "Ⓕ + Ⓜ",
    title: "Closed monthly in Fred and synced from Monarch — one account, two sources kept in agreement.",
    tone: "text-good",
  },
  provider: {
    label: "Ⓜ Monarch",
    title: "Synced from Monarch. No monthly close history in Fred yet.",
    tone: "text-ink-2",
  },
  fred: {
    label: "Ⓕ only",
    title: "Fred's own record only — no live feed connected.",
    tone: "text-ink-3",
  },
  none: { label: "—", title: "No source data.", tone: "text-ink-3" },
};

function OwnerChip({ name }: { name: string }) {
  if (name === "Unassigned") return null;
  return (
    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Roster row — one real account. Collapsed: name, owner, connectivity,
// resolved balance. Expanded: the per-source breakdown that makes the merge
// and the "which value won" decision visible, plus household settings.
// ---------------------------------------------------------------------------

function AccountRow({
  a,
  people,
}: {
  a: HouseholdAccount;
  people: { id: number; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const conn = CONNECTIVITY[a.connectivity];
  const autoChip = a.sources.find((s) => s.status === "auto");

  return (
    <div className={`border-t border-edge ${a.includeInHousehold ? "" : "opacity-45"}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2 text-left"
      >
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: catColor(a.category) }}
        />
        <span className="text-sm font-medium text-ink">{a.name}</span>
        <OwnerChip name={a.ownerName} />
        <span className="text-xs text-ink-3">{catLabel(a.category)}</span>
        <span className={`text-[11px] ${conn.tone}`} title={conn.title}>
          {conn.label}
        </span>
        {autoChip && (
          <span
            className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3"
            title="Automatically matched because it was an unmistakable duplicate. Open to undo."
          >
            auto-matched
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {a.balance.conflict && (
            <span
              className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-bad"
              title={a.balance.reason}
            >
              Δ {money(Math.abs(a.balance.conflict.delta))}
            </span>
          )}
          <span
            className={`w-28 text-right text-sm font-medium tabular-nums ${a.isLiability ? "text-bad" : "text-ink"}`}
          >
            {a.balance.value == null
              ? "–"
              : a.isLiability
                ? `−${money(Math.abs(a.balance.value))}`
                : money(a.balance.value)}
          </span>
          <span className="text-ink-3">{open ? "▾" : "▸"}</span>
        </span>
      </button>

      {open && (
        <div className="mb-2 space-y-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
          {/* Per-source breakdown — the merge, made visible. */}
          <div className="space-y-1">
            {a.sources.map((s) => {
              const isWinner = s.source === a.balance.source;
              return (
                <div
                  key={s.source + s.externalAccountId}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="text-ink-2">
                    {sourceIcon(s.source)} {sourceLabel(s.source)}
                    {s.externalName && s.source !== "fred" && (
                      <span className="ml-1 text-ink-3">({s.externalName})</span>
                    )}
                    <span className="ml-2 text-ink-3">as of {s.observedAt}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-ink">{money(s.value)}</span>
                    {isWinner ? (
                      <span className="text-[10px] text-good" title="Shown as the account's balance.">
                        shown
                      </span>
                    ) : (
                      <span className="w-10" />
                    )}
                    {/* Any linked provider source can be sent back to review —
                        auto-matched or manually confirmed. Only Fred's own
                        statements (source "fred") can't be unlinked. */}
                    {(s.status === "auto" || s.status === "confirmed") &&
                      s.externalAccountId && (
                        <form action={(fd) => start(() => unlinkSource(fd))}>
                          <input type="hidden" name="externalAccountId" value={s.externalAccountId} />
                          <button
                            className="text-[10px] text-ink-3 hover:text-bad disabled:opacity-50"
                            disabled={pending}
                            title={
                              s.status === "auto"
                                ? "Not the same account? Send it back to review."
                                : "Linked by mistake? Unlink and send it back to review."
                            }
                          >
                            {s.status === "auto" ? "undo" : "unlink"}
                          </button>
                        </form>
                      )}
                  </span>
                </div>
              );
            })}
          </div>
          {a.sources.length > 1 && (
            <p className="text-ink-3">{a.balance.reason}</p>
          )}

          {/* Household settings */}
          <form
            action={(fd) => start(() => updateHouseholdAccount(fd))}
            className="flex flex-wrap items-center gap-3 border-t border-edge pt-2 text-ink-2"
          >
            <input type="hidden" name="accountId" value={a.id} />
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                name="includeInHousehold"
                defaultChecked={a.includeInHousehold}
              />
              Count in household
            </label>
            <label className="flex items-center gap-1.5">
              Owner
              <select
                name="ownerPersonId"
                defaultValue={a.ownerName === "Joint" ? "joint" : (a.ownerPersonId ?? "")}
                className="rounded border border-edge bg-surface px-1.5 py-1 text-xs text-ink"
              >
                <option value="">Unassigned</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="joint">Joint</option>
              </select>
            </label>
            {a.hasStatements && (
              <Link href={`/accounts/${a.slug}`} className="text-accent hover:underline">
                Statement history →
              </Link>
            )}
            <button
              disabled={pending}
              className="ml-auto rounded-lg border border-edge px-2.5 py-1 font-medium text-ink-2 hover:bg-surface disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </form>

          <div className="flex justify-end border-t border-edge pt-2">
            <DeleteAccountControl accountId={a.id} accountName={a.name} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Guided review — one card at a time. The user chose this over a wall of rows.
// ---------------------------------------------------------------------------

function ReviewCard({ p }: { p: PendingSource }) {
  const [pending, start] = useTransition();
  const [targetId, setTargetId] = useState(p.suggestions[0]?.accountId);
  const top = p.suggestions.find((s) => s.accountId === targetId) ?? p.suggestions[0];

  return (
    <div className="rounded-xl border border-edge bg-surface-2 p-4">
      {/* The incoming record */}
      <div className="text-sm">
        <span className="font-medium text-ink">
          {sourceIcon(p.provider)} {p.name}
        </span>
        <span className="ml-2 text-xs text-ink-3">
          {p.institution ?? "—"} · {p.accountType}
        </span>
      </div>
      <div className={`text-sm font-medium tabular-nums ${p.isAsset ? "text-ink" : "text-bad"}`}>
        {p.isAsset ? money(p.balance) : `−${money(Math.abs(p.balance))}`}
      </div>

      {top ? (
        <>
          <div className="my-2 flex items-center gap-2 text-xs text-ink-3">
            <span className="h-px flex-1 bg-edge" />
            looks like the same account as
            <span className="h-px flex-1 bg-edge" />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span title="An account Fred already tracks">{sourceIcon("fred")}</span>
            {p.suggestions.length > 1 ? (
              <select
                value={targetId}
                onChange={(e) => setTargetId(Number(e.target.value))}
                className="rounded-lg border border-edge bg-surface px-2 py-1 text-sm text-ink"
              >
                {p.suggestions.map((s) => (
                  <option key={s.accountId} value={s.accountId}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="font-medium text-ink">{top.name}</span>
            )}
            <span className="text-xs text-ink-3">{top.why}</span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <form action={(fd) => start(() => linkSource(fd))}>
              <input type="hidden" name="externalAccountId" value={p.id} />
              <input type="hidden" name="accountId" value={targetId} />
              <button
                disabled={pending}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Yes, same account
              </button>
            </form>
            <form action={(fd) => start(() => promoteSource(fd))}>
              <input type="hidden" name="externalAccountId" value={p.id} />
              <button
                disabled={pending}
                className="rounded-lg border border-edge px-3 py-1.5 text-sm font-medium text-ink-2 hover:bg-surface disabled:opacity-50"
              >
                No — it&apos;s a new account
              </button>
            </form>
            <form action={(fd) => start(() => ignoreSource(fd))}>
              <input type="hidden" name="externalAccountId" value={p.id} />
              <button
                disabled={pending}
                className="rounded-lg px-3 py-1.5 text-sm text-ink-3 hover:bg-surface disabled:opacity-50"
              >
                Ignore
              </button>
            </form>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-xs text-ink-3">
            Not seen before in the household. Add it as a new account?
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={(fd) => start(() => promoteSource(fd))}>
              <input type="hidden" name="externalAccountId" value={p.id} />
              <button
                disabled={pending}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Add to household
              </button>
            </form>
            <form action={(fd) => start(() => ignoreSource(fd))}>
              <input type="hidden" name="externalAccountId" value={p.id} />
              <button
                disabled={pending}
                className="rounded-lg px-3 py-1.5 text-sm text-ink-3 hover:bg-surface disabled:opacity-50"
              >
                Ignore
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

function ReviewBand({ pending }: { pending: PendingSource[] }) {
  const [idx, setIdx] = useState(0);
  const [showAll, setShowAll] = useState(false);
  if (pending.length === 0) return null;

  const matches = pending.filter((p) => p.suggestions.length).length;
  const cur = Math.min(idx, pending.length - 1);
  const p = pending[cur];

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            {pending.length} {pending.length === 1 ? "account" : "accounts"} to review
          </h2>
          <p className="text-xs text-ink-3">
            {matches} likely {matches === 1 ? "match" : "matches"} · {pending.length - matches} new.
            Nothing here counts toward your totals until you decide.
          </p>
        </div>
        <button
          onClick={() => setShowAll((s) => !s)}
          className="text-xs text-accent hover:underline"
        >
          {showAll ? "One at a time" : "Show all"}
        </button>
      </div>

      {showAll ? (
        <div className="space-y-3">
          {pending.map((q) => (
            <ReviewCard key={q.id} p={q} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-ink-3">
            <span>
              Reviewing {cur + 1} of {pending.length}
            </span>
            <span className="flex gap-2">
              <button
                onClick={() => setIdx((i) => (i - 1 + pending.length) % pending.length)}
                className="rounded border border-edge px-2 py-0.5 hover:bg-surface-2"
              >
                ←
              </button>
              <button
                onClick={() => setIdx((i) => (i + 1) % pending.length)}
                className="rounded border border-edge px-2 py-0.5 hover:bg-surface-2"
                title="Decide later — skip to the next"
              >
                Skip →
              </button>
            </span>
          </div>
          {/* key is load-bearing: ReviewCard seeds its target selection from
              useState(p.suggestions[0]) on mount only. Without a key that
              changes with the card, React reuses the instance across
              different pending items, so the first card's target sticks and
              every subsequent link is submitted against the wrong account. */}
          <ReviewCard key={p.id} p={p} />
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function HouseholdClient({
  accounts,
  pending,
  ignored,
  people,
}: {
  accounts: HouseholdAccount[];
  pending: PendingSource[];
  ignored: { id: number; name: string; note: string | null }[];
  people: { id: number; name: string; isPrimary: boolean }[];
}) {
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState("all");
  const [category, setCategory] = useState("all");
  const [hideEmpty, setHideEmpty] = useState(true);

  const owners = useMemo(
    () => [...new Set(accounts.map((a) => a.ownerName))].sort(),
    [accounts],
  );
  const categories = useMemo(
    () => [...new Set(accounts.map((a) => a.category))].sort(),
    [accounts],
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return accounts.filter((a) => {
      if (owner !== "all" && a.ownerName !== owner) return false;
      if (category !== "all" && a.category !== category) return false;
      if (hideEmpty && (a.balance.value ?? 0) === 0) return false;
      if (
        needle &&
        !`${a.name} ${a.institutionLabel} ${a.ownerName}`.toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
  }, [accounts, q, owner, category, hideEmpty]);

  const totals = useMemo(() => {
    let assets = 0;
    let liabilities = 0;
    for (const a of visible) {
      if (!a.includeInHousehold || a.balance.value == null) continue;
      if (a.isLiability) liabilities += Math.abs(a.balance.value);
      else assets += a.balance.value;
    }
    return { assets, liabilities, net: assets - liabilities };
  }, [visible]);

  // Group by institution, biggest first.
  const groups = useMemo(() => {
    const m = new Map<string, HouseholdAccount[]>();
    for (const a of visible) {
      const list = m.get(a.institutionLabel) ?? [];
      list.push(a);
      m.set(a.institutionLabel, list);
    }
    const arr = [...m.entries()].map(([label, list]) => {
      list.sort((x, y) => Math.abs(y.balance.value ?? 0) - Math.abs(x.balance.value ?? 0));
      const subtotal = list.reduce(
        (s, a) => s + (a.includeInHousehold ? a.signedBalance : 0),
        0,
      );
      return { label, list, subtotal };
    });
    arr.sort((a, b) => Math.abs(b.subtotal) - Math.abs(a.subtotal));
    return arr;
  }, [visible]);

  const sliced = owner !== "all" || category !== "all" || q.trim() !== "";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Net worth"
          value={money(totals.net)}
          sub={sliced ? "this slice" : "everything included"}
        />
        <StatTile label="Assets" value={money(totals.assets)} />
        <StatTile
          label="Liabilities"
          value={totals.liabilities ? `−${money(totals.liabilities)}` : "$0"}
          deltaGood={totals.liabilities ? false : undefined}
        />
        <StatTile
          label="Accounts"
          value={String(visible.length)}
          sub={pending.length ? `${pending.length} to review` : "all reviewed"}
        />
      </div>

      <ReviewBand pending={pending} />

      {/* Filter toolbar — secondary, quiet */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search accounts…"
          className="w-44 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-3"
        />
        <select
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className="rounded-lg border border-edge bg-surface px-2 py-1.5 text-xs text-ink"
        >
          <option value="all">Everyone</option>
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-edge bg-surface px-2 py-1.5 text-xs text-ink"
        >
          <option value="all">All types</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {catLabel(c)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => setHideEmpty(e.target.checked)}
          />
          Hide $0
        </label>
        {sliced && (
          <button
            onClick={() => {
              setOwner("all");
              setCategory("all");
              setQ("");
            }}
            className="text-accent hover:underline"
          >
            Clear
          </button>
        )}
        <span className="ml-auto text-ink-3">Totals reflect this slice.</span>
      </div>

      {groups.map((g) => (
        <Card key={g.label}>
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink">{g.label}</h2>
            <span className="text-xs tabular-nums text-ink-3">
              {g.subtotal < 0 ? `−${money(Math.abs(g.subtotal))}` : money(g.subtotal)}
            </span>
          </div>
          {g.list.map((a) => (
            <AccountRow key={a.id} a={a} people={people} />
          ))}
        </Card>
      ))}

      {ignored.length > 0 && (
        <details className="rounded-xl border border-edge bg-surface px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-ink-2">
            Not tracked ({ignored.length})
          </summary>
          <div className="mt-2">
            {ignored.map((i) => (
              <form
                key={i.id}
                action={unlinkSource}
                className="flex flex-wrap items-center gap-3 border-t border-edge py-2 text-sm"
              >
                <input type="hidden" name="externalAccountId" value={i.id} />
                <span className="text-ink-2">{i.name}</span>
                <span className="text-xs text-ink-3">{i.note}</span>
                <button className="ml-auto text-xs text-ink-3 hover:text-accent">
                  Track it after all
                </button>
              </form>
            ))}
          </div>
        </details>
      )}

      <p className="text-xs text-ink-3">
        Your home isn&apos;t here on purpose — a house you live in isn&apos;t
        spendable like an investment, so it has its own{" "}
        <Link href="/house" className="text-accent hover:underline">
          House page
        </Link>
        . Open any account to see its sources and which value is shown.
      </p>
    </div>
  );
}
