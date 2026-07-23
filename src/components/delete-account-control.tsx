"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteAccount } from "@/app/actions";

/**
 * Permanently delete an account. Two-step: a quiet link that expands into a
 * type-the-name-to-confirm control, since this has no undo — unlike
 * unlinking a synced source (trivially reversible), deleting an account
 * removes its statement history for good.
 */
export function DeleteAccountControl({
  accountId,
  accountName,
  onDeleted,
}: {
  accountId: number;
  accountName: string;
  /** Called after a successful delete — e.g. to navigate away from a page
   *  that no longer exists once the account is gone. */
  onDeleted?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const matches = typed.trim() === accountName;

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="text-[11px] text-ink-3 hover:text-bad"
      >
        Delete account…
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-bad">
        This permanently deletes “{accountName}” and its statement history.
        Type the name to confirm:
      </span>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={accountName}
        autoFocus
        className="rounded border border-edge bg-surface px-1.5 py-0.5 text-ink"
      />
      <form
        action={(fd) =>
          start(async () => {
            await deleteAccount(fd);
            // The caller decides what "after" looks like — navigate away from
            // a page that no longer exists (account detail) vs. just refetch
            // in place (the household roster, where the row simply drops).
            if (onDeleted) onDeleted();
            else router.refresh();
          })
        }
      >
        <input type="hidden" name="accountId" value={accountId} />
        <button
          disabled={!matches || pending}
          className="rounded bg-bad px-2 py-1 font-medium text-white disabled:opacity-40"
        >
          {pending ? "Deleting…" : "Permanently delete"}
        </button>
      </form>
      <button
        onClick={() => {
          setConfirming(false);
          setTyped("");
        }}
        className="text-ink-3 hover:text-ink"
      >
        Cancel
      </button>
    </div>
  );
}
