"use client";

import { useTransition } from "react";
import { updateExternalAccount } from "@/app/actions";
import { money } from "@/lib/format";

type Props = {
  external: {
    id: number;
    name: string;
    institution: string | null;
    accountType: string | null;
    currentBalance: number;
    balanceAsOf: string | null;
    isAsset: boolean;
    linkedAccountId: number | null;
    ownerPersonId: number | null;
    includeInHousehold: boolean;
    ownershipShare: number;
  };
  fredAccounts: { id: number; name: string }[];
  people: { id: number; name: string }[];
};

export function ExternalAccountRow({ external, fredAccounts, people }: Props) {
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(fd) => startTransition(() => updateExternalAccount(fd))}
      className={`grid grid-cols-2 items-center gap-2 border-t border-edge py-2 text-sm sm:grid-cols-[1fr_auto_auto_auto_auto_auto] ${
        pending ? "opacity-50" : ""
      }`}
    >
      <input type="hidden" name="externalAccountId" value={external.id} />
      <div className="col-span-2 sm:col-span-1">
        <div className="font-medium text-ink">{external.name}</div>
        <div className="text-xs text-ink-3">
          {external.institution ?? "—"} · {external.accountType}
          {external.balanceAsOf && ` · as of ${external.balanceAsOf}`}
        </div>
      </div>
      <div className="text-right tabular-nums text-ink">
        {money(external.currentBalance)}
      </div>
      <label className="text-xs text-ink-3">
        Link
        <select
          name="linkedAccountId"
          defaultValue={external.linkedAccountId ?? ""}
          className="ml-1 rounded-lg border border-edge bg-surface px-1.5 py-1 text-xs text-ink"
        >
          <option value="">— additive —</option>
          {fredAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-ink-3">
        Owner
        <select
          name="ownerPersonId"
          defaultValue={external.ownerPersonId ?? ""}
          className="ml-1 rounded-lg border border-edge bg-surface px-1.5 py-1 text-xs text-ink"
        >
          <option value="">Joint / —</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ink-3">
        <input
          type="checkbox"
          name="includeInHousehold"
          defaultChecked={external.includeInHousehold}
          disabled={external.linkedAccountId != null}
          title={
            external.linkedAccountId != null
              ? "Linked accounts are already counted via statements"
              : undefined
          }
        />
        Household
        <input
          inputMode="decimal"
          name="ownershipShare"
          defaultValue={external.ownershipShare}
          className="w-12 rounded-lg border border-edge bg-surface px-1.5 py-1 text-right text-xs tabular-nums text-ink"
          title="Share of this account counted toward household"
        />
      </label>
      <button
        disabled={pending}
        className="justify-self-end rounded-lg border border-edge px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
