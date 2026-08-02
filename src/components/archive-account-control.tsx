"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setAccountArchived } from "@/app/actions";
import { money } from "@/lib/format";

/**
 * Archive an account, or bring it back.
 *
 * The non-destructive counterpart to deleting: history stays, but the account
 * stops counting toward today's net worth and leaves the monthly close. That
 * second effect is the whole reason this needs a confirmation step — archiving
 * an account that still holds money silently subtracts it from every total in
 * the app, so the amount is stated before you commit rather than discovered
 * afterwards in a net-worth figure that moved for no visible reason.
 */
export function ArchiveAccountControl({
  accountId,
  accountName,
  archived,
  currentValue,
  archivedAt,
  providerStillReporting,
}: {
  accountId: number;
  accountName: string;
  archived: boolean;
  /** Signed contribution to net worth today; zero once archived. */
  currentValue: number;
  archivedAt?: string | null;
  /** A linked feed still reports a balance — worth saying out loud, since a
   *  live feed contradicts "this account is closed". */
  providerStillReporting?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const submit = (fd: FormData) =>
    start(async () => {
      await setAccountArchived(fd);
      setConfirming(false);
      router.refresh();
    });

  if (archived) {
    return (
      <form action={submit} className="flex items-center gap-2 text-[11px]">
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="archived" value="false" />
        <span className="text-ink-3">
          Archived{archivedAt ? ` ${archivedAt}` : ""} · counts as $0
        </span>
        <button
          disabled={pending}
          className="text-accent hover:underline disabled:opacity-50"
        >
          {pending ? "Reopening…" : "Reopen"}
        </button>
      </form>
    );
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="text-[11px] text-ink-3 hover:text-ink"
      >
        Archive account…
      </button>
    );
  }

  const holdsMoney = Math.abs(currentValue) > 0.5;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-ink-2">
        Archive “{accountName}”? Its statement history is kept and nothing is
        deleted — it stops counting toward net worth and leaves the monthly
        close.
        {holdsMoney && (
          <strong className="ml-1 text-bad">
            Net worth will drop by {money(Math.abs(currentValue))}.
          </strong>
        )}
        {providerStillReporting && (
          <strong className="ml-1 text-bad">
            A synced source still reports a balance here — check it&apos;s really
            closed.
          </strong>
        )}
      </span>
      <form action={submit}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="archived" value="true" />
        <button
          disabled={pending}
          className="rounded border border-edge px-2 py-1 font-medium text-ink-2 hover:bg-surface disabled:opacity-40"
        >
          {pending ? "Archiving…" : "Archive"}
        </button>
      </form>
      <button
        onClick={() => setConfirming(false)}
        className="text-ink-3 hover:text-ink"
      >
        Cancel
      </button>
    </div>
  );
}
