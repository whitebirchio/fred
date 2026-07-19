"use client";

import { useMemo, useState, useTransition } from "react";
import { upsertEntry } from "@/app/actions";
import { money } from "@/lib/format";

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
  statementDate: string; // default month-end
  prevBalance: number;
  // "mixed" (401(k)-style) shows all three tax-character fields; otherwise the
  // single contribution input writes to the account's natural column.
  contributionField: "mixed" | ContributionField;
  defaults?: Partial<Record<Field, number>>;
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

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.key,
        f.key === "balance"
          ? (defaults?.balance?.toString() ?? "")
          : (defaults?.[f.key]?.toString() ?? "0"),
      ]),
    ),
  );
  const [date, setDate] = useState(statementDate);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

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
        <label className="block text-xs text-ink-2">
          Statement date
          <input
            type="date"
            name="statementDate"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
            required
          />
        </label>
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
