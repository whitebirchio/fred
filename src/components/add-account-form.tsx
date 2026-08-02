"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createAccount } from "@/app/actions";
import { CATEGORY_META, CATEGORY_ORDER } from "@/lib/categories";

/**
 * Create an account by hand.
 *
 * The guided review can only mint accounts a provider already knows about, so
 * anything outside the feed — a new employer's plan, a paper I-bond, a private
 * note — had no way in. Collapsed by default: adding an account is rare next
 * to reviewing sources, and the roster shouldn't open on a form.
 */

const TAX_TREATMENTS: { value: string; label: string }[] = [
  { value: "na", label: "Not applicable" },
  { value: "taxable", label: "Taxable" },
  { value: "traditional", label: "Pre-tax (traditional)" },
  { value: "roth", label: "Roth" },
  { value: "hsa", label: "HSA" },
  { value: "pension", label: "Pension" },
];

export function AddAccountForm({
  people,
}: {
  people: { id: number; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const thisMonth = new Date().toISOString().slice(0, 7);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2"
      >
        + Add account
      </button>
    );
  }

  return (
    <form
      action={(fd) =>
        start(async () => {
          await createAccount(fd);
          setOpen(false);
          router.refresh();
        })
      }
      className="space-y-3 rounded-xl border border-edge bg-surface-2 p-4 text-xs"
    >
      <p className="text-ink-2">
        For an account no source syncs. Anything Monarch already sees will show
        up in review instead — add it there so the two stay linked.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-ink-2">
          Name
          <input
            name="name"
            required
            autoFocus
            placeholder="e.g. Schwab Roth IRA"
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="block text-ink-2">
          Institution
          <input
            name="institution"
            placeholder="e.g. Schwab"
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="block text-ink-2">
          Type
          <select
            name="category"
            defaultValue="cash"
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_META[c].name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-ink-2">
          Tax treatment
          <select
            name="taxTreatment"
            defaultValue="na"
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
          >
            {TAX_TREATMENTS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-ink-2">
          Owner
          <select
            name="ownerPersonId"
            defaultValue={people[0]?.id ?? ""}
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
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
      </div>

      <div className="grid gap-3 border-t border-edge pt-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-ink-2">
          Opening balance
          <input
            name="openingBalance"
            inputMode="decimal"
            placeholder="optional"
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm tabular-nums text-ink"
          />
        </label>
        <label className="block text-ink-2">
          As of month
          <input
            type="month"
            name="openingMonth"
            defaultValue={thisMonth}
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <p className="self-end text-ink-3">
          Recorded as that month&apos;s close. Leave blank to start empty and
          enter it from Monthly close.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          disabled={pending}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add account"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-ink-3 hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
