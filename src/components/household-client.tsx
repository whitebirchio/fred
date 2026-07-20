"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { money, dateLabel } from "@/lib/format";
import { CATEGORY_META } from "@/lib/categories";
import { Card, StatTile } from "@/components/ui";
import {
  linkSource,
  promoteSource,
  ignoreSource,
  unlinkSource,
  updateHouseholdAccount,
} from "@/app/actions";
import type { HouseholdAccount, PendingSource } from "@/lib/household";

const SOURCE_ICON: Record<string, string> = {
  statements: "📄",
  monarch: "Ⓜ",
};

const catLabel = (c: string) =>
  CATEGORY_META[c]?.name ??
  (c === "credit" ? "Credit card" : c === "loan" ? "Loan" : c);
const catColor = (c: string) =>
  CATEGORY_META[c]?.color ??
  (c === "credit" || c === "loan" ? "var(--series-6)" : "var(--series-8)");

/** Provenance badge: the answer to "where did this number come from, and why
 *  that source?" — the explanation is the title so it's always reachable. */
function ProvenanceBadge({ account }: { account: HouseholdAccount }) {
  const { balance } = account;
  if (!balance.source) {
    return <span className="text-xs text-ink-3">no data</span>;
  }
  const alt = balance.alternatives
    .map((a) => `${a.source}: ${money(a.value)} (${a.observedAt})`)
    .join(" · ");
  const title = `${balance.reason}${alt ? `\n\nOther sources — ${alt}` : ""}${
    balance.conflict
      ? `\n\nDisagreement: ${balance.conflict.source} differs by ${money(balance.conflict.delta, true)}.`
      : balance.alternatives.length
        ? "\n\nOther sources agree."
        : ""
  }`;
  return (
    <span className="inline-flex items-center gap-1" title={title}>
      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
        {SOURCE_ICON[balance.source] ?? "•"} {balance.observedAt?.slice(5)}
      </span>
      {balance.conflict ? (
        <span
          className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-bad"
          title={title}
        >
          Δ {money(Math.abs(balance.conflict.delta))}
        </span>
      ) : balance.alternatives.length > 0 ? (
        <span className="text-[11px] text-good" title={title}>
          ✓
        </span>
      ) : null}
    </span>
  );
}

function AccountRow({
  a,
  people,
}: {
  a: HouseholdAccount;
  people: { id: number; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div className={`border-t border-edge py-2 ${a.includeInHousehold ? "" : "opacity-45"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: catColor(a.category) }}
        />
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-left text-sm font-medium text-ink hover:underline"
        >
          {a.name}
        </button>
        <span className="text-xs text-ink-3">
          {a.institution ?? "—"} · {catLabel(a.category)}
        </span>
        {a.sources.map((s) => (
          <span
            key={s.source}
            className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3"
            title={`${s.externalName ?? "Fred statements"} — ${money(s.value)} as of ${s.observedAt}${
              s.status === "auto" ? " (auto-matched, unconfirmed)" : ""
            }`}
          >
            {SOURCE_ICON[s.source] ?? "•"} {s.source}
            {s.status === "auto" ? " ~" : ""}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <ProvenanceBadge account={a} />
          <span
            className={`w-28 text-right text-sm font-medium tabular-nums ${
              a.isLiability ? "text-bad" : "text-ink"
            }`}
          >
            {a.balance.value == null
              ? "–"
              : a.isLiability
                ? `−${money(Math.abs(a.balance.value))}`
                : money(a.balance.value)}
          </span>
        </span>
      </div>

      {open && (
        <form
          action={(fd) => start(() => updateHouseholdAccount(fd))}
          className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2"
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
            <Link
              href={`/accounts/${a.slug}`}
              className="text-accent hover:underline"
            >
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
      )}
    </div>
  );
}

function ReviewCard({
  p,
  people,
}: {
  p: PendingSource;
  people: { id: number; name: string }[];
}) {
  void people;
  const [pending, start] = useTransition();
  const top = p.suggestions[0];
  return (
    <div className="border-t border-edge py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-ink">{p.name}</span>
        <span className="text-xs text-ink-3">
          {p.institution ?? "—"} · {p.accountType} · via {p.provider}
        </span>
        <span
          className={`ml-auto text-sm font-medium tabular-nums ${p.isAsset ? "text-ink" : "text-bad"}`}
        >
          {p.isAsset ? money(p.balance) : `−${money(Math.abs(p.balance))}`}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {top ? (
          <form action={(fd) => start(() => linkSource(fd))} className="flex items-center gap-2">
            <input type="hidden" name="externalAccountId" value={p.id} />
            <select
              name="accountId"
              defaultValue={top.accountId}
              className="rounded-lg border border-edge bg-surface px-2 py-1 text-xs text-ink"
            >
              {p.suggestions.map((s) => (
                <option key={s.accountId} value={s.accountId}>
                  {s.name} ({s.score})
                </option>
              ))}
            </select>
            <button
              disabled={pending}
              className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Same account — link
            </button>
            <span className="text-[11px] text-ink-3">{top.why}</span>
          </form>
        ) : (
          <span className="text-[11px] text-ink-3">
            No confident match — likely a new account.
          </span>
        )}

        <form action={(fd) => start(() => promoteSource(fd))}>
          <input type="hidden" name="externalAccountId" value={p.id} />
          <button
            disabled={pending}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
              top
                ? "border border-edge text-ink-2 hover:bg-surface-2"
                : "bg-accent text-white"
            }`}
          >
            Add as new account
          </button>
        </form>

        <form action={(fd) => start(() => ignoreSource(fd))}>
          <input type="hidden" name="externalAccountId" value={p.id} />
          <button
            disabled={pending}
            className="rounded-lg border border-edge px-2.5 py-1 text-xs text-ink-3 hover:bg-surface-2 disabled:opacity-50"
          >
            Ignore
          </button>
        </form>
      </div>
    </div>
  );
}

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
  const [owner, setOwner] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [hideEmpty, setHideEmpty] = useState(true);

  const owners = useMemo(
    () => [...new Set(accounts.map((a) => a.ownerName))].sort(),
    [accounts],
  );
  const categories = useMemo(
    () => [...new Set(accounts.map((a) => a.category))].sort(),
    [accounts],
  );

  // The slice: every number below recomputes against exactly this list.
  const visible = useMemo(
    () =>
      accounts.filter((a) => {
        if (owner !== "all" && a.ownerName !== owner) return false;
        if (category !== "all" && a.category !== category) return false;
        if (hideEmpty && (a.balance.value ?? 0) === 0) return false;
        return true;
      }),
    [accounts, owner, category, hideEmpty],
  );

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

  const conflictCount = visible.filter((a) => a.balance.conflict).length;

  // Group by owner, then sort by size within each group.
  const groups = useMemo(() => {
    const m = new Map<string, HouseholdAccount[]>();
    for (const a of visible) {
      const list = m.get(a.ownerName) ?? [];
      list.push(a);
      m.set(a.ownerName, list);
    }
    for (const list of m.values()) {
      list.sort(
        (x, y) => Math.abs(y.balance.value ?? 0) - Math.abs(x.balance.value ?? 0),
      );
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Household net worth"
          value={money(totals.net)}
          sub={
            owner === "all" && category === "all"
              ? "everything included"
              : "current slice"
          }
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
          sub={
            pending.length
              ? `${pending.length} awaiting review`
              : conflictCount
                ? `${conflictCount} with source conflicts`
                : "all sources agree"
          }
        />
      </div>

      {pending.length > 0 && (
        <Card
          title={`Review queue — ${pending.length} ${pending.length === 1 ? "account" : "accounts"}`}
          subtitle="Nothing here counts toward any total until you decide. Link a duplicate to the account it already represents, or add it as a new household account."
        >
          {pending.map((p) => (
            <ReviewCard key={p.id} p={p} people={people} />
          ))}
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
          <span className="font-medium text-ink">Slice</span>
          <label className="flex items-center gap-1.5">
            Owner
            <select
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className="rounded-lg border border-edge bg-surface px-2 py-1 text-xs text-ink"
            >
              <option value="all">Everyone</option>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-lg border border-edge bg-surface px-2 py-1 text-xs text-ink"
            >
              <option value="all">All</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {catLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={(e) => setHideEmpty(e.target.checked)}
            />
            Hide zero balances
          </label>
          {(owner !== "all" || category !== "all") && (
            <button
              onClick={() => {
                setOwner("all");
                setCategory("all");
              }}
              className="text-accent hover:underline"
            >
              Reset
            </button>
          )}
          <span className="ml-auto text-ink-3">
            Totals above reflect this slice.
          </span>
        </div>
      </Card>

      {groups.map(([ownerName, list]) => (
        <Card
          key={ownerName}
          title={ownerName}
          subtitle={`${list.length} ${list.length === 1 ? "account" : "accounts"}`}
        >
          {list.map((a) => (
            <AccountRow key={a.id} a={a} people={people} />
          ))}
        </Card>
      ))}

      {ignored.length > 0 && (
        <Card
          title="Excluded sources"
          subtitle="Deliberately not counted — with the reason, so “ignored” never hides a decision"
        >
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
                Send back to review
              </button>
            </form>
          ))}
        </Card>
      )}

      <p className="text-xs text-ink-3">
        House equity is deliberately excluded here — a primary residence
        isn&apos;t spendable like an investment, so it lives on its own{" "}
        <Link href="/house" className="text-accent hover:underline">
          House page
        </Link>
        . Last synced values come from whichever source won for each account;
        hover a badge to see why.{" "}
        {dateLabel(new Date().toISOString().slice(0, 10))}
      </p>
    </div>
  );
}
