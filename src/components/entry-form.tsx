"use client";

import { useMemo, useState, useTransition } from "react";
import { upsertEntry } from "@/app/actions";
import { dateLabel, money, monthEnd } from "@/lib/format";

type ContributionField =
  | "contributionsPretax"
  | "contributionsRoth"
  | "contributionsAfterTax";

type Field =
  | "balance"
  | ContributionField
  | "employerContributions"
  | "transfersIn"
  | "withdrawals"
  | "transfersOut";

type Props = {
  accountId: number;
  accountName: string;
  /** Always a month-end date — see `dateMode`. */
  statementDate: string;
  prevBalance: number;
  // "mixed" (401(k)-style) shows all three tax-character fields; otherwise the
  // single contribution input writes to the account's natural column.
  contributionField: "mixed" | ContributionField;
  defaults?: Partial<Record<Field, number>>;
  /** How the statement date may be changed:
   *   fixed — not at all; the surrounding page already chose the month
   *           (/monthly, where a free date field was only ever a way to
   *           silently file an entry under the wrong month)
   *   month — pick a different month; the date still resolves to that
   *           month's last day, because a close is always a month-end figure */
  dateMode?: "fixed" | "month";
};

const LABELS: Record<Field, string> = {
  balance: "Statement balance",
  contributionsPretax: "Pre-tax contributions",
  contributionsRoth: "Roth contributions",
  contributionsAfterTax: "After-tax contributions",
  employerContributions: "Employer contributions",
  transfersIn: "Transfers in",
  withdrawals: "Withdrawals",
  transfersOut: "Transfers out",
};

export function EntryForm({
  accountId,
  accountName,
  statementDate,
  prevBalance,
  contributionField,
  defaults,
  dateMode = "month",
}: Props) {
  const fields: { key: Field; label: string }[] = [
    { key: "balance", label: LABELS.balance },
    ...(contributionField === "mixed"
      ? ([
          { key: "contributionsPretax", label: LABELS.contributionsPretax },
          { key: "contributionsRoth", label: LABELS.contributionsRoth },
          { key: "contributionsAfterTax", label: LABELS.contributionsAfterTax },
        ] as const)
      : ([{ key: contributionField, label: "Your contributions" }] as const)),
    { key: "employerContributions", label: LABELS.employerContributions },
    { key: "transfersIn", label: LABELS.transfersIn },
    { key: "withdrawals", label: LABELS.withdrawals },
    { key: "transfersOut", label: LABELS.transfersOut },
  ];

  const initialValues = () =>
    Object.fromEntries(
      fields.map((f) => [
        f.key,
        f.key === "balance"
          ? (defaults?.balance?.toString() ?? "")
          : (defaults?.[f.key]?.toString() ?? "0"),
      ]),
    );

  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [date, setDate] = useState(statementDate);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  // Re-point the form when it is asked to describe a different account/month.
  //
  // useState reads its initial value only on mount, and moving between months
  // on /monthly is a client-side navigation that re-renders the *same*
  // component in the same tree position. Without this the form silently keeps
  // the month it was first mounted with: you navigate June -> July, the header
  // reads July, the hidden statementDate still reads 2026-06-30, and pressing
  // Save writes to the month you just left — which looks exactly like two
  // months being bound together. Call sites also pass a `key`, which makes
  // this a remount in practice; the guard stays so a future call site that
  // forgets the key degrades into "correct" rather than "quietly wrong".
  const identity = `${accountId}|${statementDate}`;
  const [lastIdentity, setLastIdentity] = useState(identity);
  if (identity !== lastIdentity) {
    setLastIdentity(identity);
    setValues(initialValues());
    setDate(statementDate);
    setSaved(false);
  }

  // The date is editable on purpose (back-filling an odd statement date), so
  // it can legitimately differ from the month in view — but never silently.
  const retargeted = date !== statementDate;

  const n = (k: string) => {
    const v = parseFloat((values[k] ?? "0").replace(/[$,]/g, ""));
    return Number.isFinite(v) ? v : 0;
  };

  const growth = useMemo(() => {
    const inflows =
      n("contributionsPretax") +
      n("contributionsRoth") +
      n("contributionsAfterTax") +
      n("employerContributions") +
      n("transfersIn");
    return (
      Math.round(
        (n("balance") - prevBalance - inflows + n("withdrawals") + n("transfersOut")) *
          100,
      ) / 100
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, prevBalance]);

  return (
    <form
      className="space-y-3"
      action={(fd) => {
        startTransition(async () => {
          await upsertEntry(fd);
          setSaved(true);
          setTimeout(() => setSaved(false), 2500);
        });
      }}
    >
      <input type="hidden" name="accountId" value={accountId} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {/* A close describes a month, so the control names a month and the
            stored date is always that month's last day. On /monthly the month
            is already chosen at the top of the page, so there is nothing to
            pick here — just a statement of what will be written. */}
        {dateMode === "fixed" ? (
          <div className="block text-xs text-ink-2">
            Statement date
            <input type="hidden" name="statementDate" value={date} />
            <p className="mt-1 rounded-lg border border-edge bg-surface-2 px-2 py-1.5 text-sm tabular-nums text-ink">
              {dateLabel(date)}
            </p>
          </div>
        ) : (
          <label className="block text-xs text-ink-2">
            Statement month
            <input type="hidden" name="statementDate" value={date} />
            <input
              type="month"
              value={date.slice(0, 7)}
              onChange={(e) => {
                const [y, mth] = e.target.value.split("-").map(Number);
                if (y && mth) setDate(monthEnd(y, mth));
              }}
              className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
              required
            />
          </label>
        )}
        {fields.map((f) => (
          <label key={f.key} className="block text-xs text-ink-2">
            {f.label}
            <input
              inputMode="decimal"
              name={f.key}
              value={values[f.key]}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }
              placeholder="0"
              className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm tabular-nums text-ink"
              required={f.key === "balance"}
            />
          </label>
        ))}
      </div>
      {retargeted && (
        <p className="rounded-lg border border-bad/40 px-3 py-2 text-xs text-bad">
          Heads up: this will save to <strong>{dateLabel(date)}</strong>, not{" "}
          {dateLabel(statementDate)}.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">
        <span className="text-ink-2">
          Derived growth for {accountName}:{" "}
          <strong
            className={`tabular-nums ${growth >= 0 ? "text-good" : "text-bad"}`}
          >
            {money(growth, true)}
          </strong>
          <span className="ml-2 text-xs text-ink-3">
            balance − prior ({money(prevBalance, true)}) − net flows
          </span>
        </span>
        <span className="flex items-center gap-2">
          {saved && <span className="text-xs text-good">Saved ✓</span>}
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save entry"}
          </button>
        </span>
      </div>
    </form>
  );
}
