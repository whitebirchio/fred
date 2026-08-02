import Link from "next/link";
import { money } from "@/lib/format";

// One synced source, reported rather than edited.
//
// This row used to carry Link / Owner / Household / share controls, from
// before /household existed. Three of them wrote columns the calculation layer
// stopped reading when ownership moved onto the hub account, so they saved
// successfully and changed nothing. The fourth set linked_account_id without
// match_status, which could leave a source looking linked while still counting
// toward nothing.
//
// Account management belongs on /household, where linking goes through review
// (and so sets status correctly) and ownership edits actually reach the
// numbers. /sync answers a different question — is the feed healthy, and what
// did it bring in — so this is now a read-only view of exactly that.

const STATUS: Record<string, { label: string; tone: string; title: string }> = {
  confirmed: {
    label: "linked",
    tone: "text-good",
    title: "Counted through the household account it belongs to.",
  },
  auto: {
    label: "auto-linked",
    tone: "text-good",
    title: "Machine-matched to a household account; counted, and reversible on Household.",
  },
  pending: {
    label: "needs review",
    tone: "text-bad",
    title: "Not counted toward anything until reviewed on Household.",
  },
  ignored: {
    label: "ignored",
    tone: "text-ink-3",
    title: "Deliberately excluded. Never counted.",
  },
};

export function ExternalAccountRow({
  external,
  linkedAccountName,
  linkedAccountSlug,
}: {
  external: {
    id: number;
    name: string;
    institution: string | null;
    accountType: string | null;
    currentBalance: number;
    balanceAsOf: string | null;
    matchStatus: string;
    connectionStatus: string;
    disconnectedAt: string | null;
  };
  linkedAccountName: string | null;
  linkedAccountSlug: string | null;
}) {
  const status = STATUS[external.matchStatus] ?? {
    label: external.matchStatus,
    tone: "text-ink-3",
    title: "",
  };
  const broken = external.connectionStatus === "broken";

  return (
    <div className="grid grid-cols-2 items-center gap-2 border-t border-edge py-2 text-sm sm:grid-cols-[1fr_auto_auto_auto]">
      <div className="col-span-2 sm:col-span-1">
        <div className="font-medium text-ink">{external.name}</div>
        <div className="text-xs text-ink-3">
          {external.institution ?? "—"} · {external.accountType}
          {external.balanceAsOf && ` · as of ${external.balanceAsOf}`}
          {broken && (
            <span className="ml-1 text-bad">
              · connection broken
              {external.disconnectedAt ? ` since ${external.disconnectedAt}` : ""},
              reconnect in Monarch
            </span>
          )}
          {external.connectionStatus === "manual" && (
            <span className="ml-1 text-ink-3">· manual in Monarch</span>
          )}
        </div>
      </div>
      <div className="text-right tabular-nums text-ink">
        {money(external.currentBalance)}
      </div>
      <div className="text-right text-xs">
        {linkedAccountName && linkedAccountSlug ? (
          <Link
            href={`/accounts/${linkedAccountSlug}`}
            className="text-ink-2 hover:underline"
            title="The household account this source is evidence about."
          >
            → {linkedAccountName}
          </Link>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </div>
      <span
        className={`justify-self-end text-[11px] ${status.tone}`}
        title={status.title}
      >
        {status.label}
      </span>
    </div>
  );
}
