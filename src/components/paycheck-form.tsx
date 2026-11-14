"use client";

import { useMemo, useState, useTransition } from "react";
import { savePaycheck } from "@/app/actions";
import { dateLabel, money } from "@/lib/format";
import type { EmployerCatalog } from "@/lib/metrics";
import {
  SECTIONS,
  SECTION_LABELS,
  deriveStub,
  emptyItems,
  itemFieldName,
  parseMoney,
  type Section,
  type StubItems,
} from "@/lib/paystubs";

/** Advance an ISO date by n days without tripping over month ends or DST. */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const key = (section: Section, name: string) => `${section}:${name}`;

export function PaycheckForm({ catalog }: { catalog: EmployerCatalog[] }) {
  const [employerId, setEmployerId] = useState(
    () => catalog[0]?.employerId ?? 0,
  );
  const employer = catalog.find((c) => c.employerId === employerId);

  // Everything a stub records, prefilled from the previous one for this
  // employer. Consecutive cheques are near-identical — the whole reason the
  // spreadsheet was quicker was that you filled down and changed one cell —
  // so the form starts from last time and asks you to correct it.
  const seed = (c: EmployerCatalog | undefined) => {
    const values: Record<string, string> = {};
    for (const section of SECTIONS) {
      for (const line of c?.lines[section] ?? []) {
        if (line.current) values[key(section, line.name)] = String(line.lastValue);
      }
    }
    return values;
  };

  const [values, setValues] = useState<Record<string, string>>(() =>
    seed(catalog[0]),
  );
  const [extra, setExtra] = useState<Record<Section, string[]>>(() => ({
    income: [],
    preTax: [],
    taxes: [],
    postTax: [],
  }));
  const [adding, setAdding] = useState<Section | null>(null);
  const [newName, setNewName] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  const nextPayday = employer?.last
    ? addDays(employer.last.paymentDate, 14)
    : new Date().toISOString().slice(0, 10);
  const [paymentDate, setPaymentDate] = useState(nextPayday);
  const [payBegin, setPayBegin] = useState("");
  const [payEnd, setPayEnd] = useState("");
  const [annualSalary, setAnnualSalary] = useState(
    String(catalog[0]?.last?.annualSalary ?? ""),
  );
  const [netPay, setNetPay] = useState(String(catalog[0]?.last?.netPay ?? ""));

  // Switching employer switches vocabulary, so the typed stub no longer means
  // anything — re-seed rather than carry LM's lines over to a Trellis stub.
  const [lastEmployer, setLastEmployer] = useState(employerId);
  if (employerId !== lastEmployer) {
    setLastEmployer(employerId);
    setValues(seed(employer));
    setExtra({ income: [], preTax: [], taxes: [], postTax: [] });
    setPaymentDate(nextPayday);
    setAnnualSalary(String(employer?.last?.annualSalary ?? ""));
    setNetPay(String(employer?.last?.netPay ?? ""));
    setResult(null);
    setAck(false);
  }

  // The form's own copy of what the server will compute, from the same module,
  // so the tie-out you watch while typing is the one that gets enforced.
  const items: StubItems = useMemo(() => {
    const out = emptyItems();
    for (const [k, raw] of Object.entries(values)) {
      const idx = k.indexOf(":");
      const section = k.slice(0, idx) as Section;
      const name = k.slice(idx + 1);
      const v = parseMoney(raw);
      if (v !== 0) out[section][name] = v;
    }
    return out;
  }, [values]);

  const totals = deriveStub(items, employer?.slug ?? "");
  const typedNet = parseMoney(netPay);
  const gap = Math.round((totals.computedNet - typedNet) * 100) / 100;
  const ties = Math.abs(gap) <= 0.01;
  const lineCount = SECTIONS.reduce(
    (a, s) => a + Object.keys(items[s]).length,
    0,
  );

  const linesFor = (section: Section) => {
    const known = employer?.lines[section] ?? [];
    const names = [
      ...known.filter((l) => l.current || showRetired).map((l) => l.name),
      ...extra[section],
    ];
    // A retired line still shows while it holds a value, so a stub that
    // revives one (an HSA restarting) never hides what it is about to save.
    for (const l of known) {
      if (!names.includes(l.name) && parseMoney(values[key(section, l.name)]) !== 0) {
        names.push(l.name);
      }
    }
    return names;
  };

  const retiredCount = SECTIONS.reduce(
    (a, s) => a + (employer?.lines[s] ?? []).filter((l) => !l.current).length,
    0,
  );

  return (
    <form
      className="space-y-4"
      action={(fd) => {
        startTransition(async () => {
          setResult(await savePaycheck(fd));
        });
      }}
    >
      <input type="hidden" name="employerId" value={employerId} />
      {ack && <input type="hidden" name="acknowledgeMismatch" value="1" />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <label className="block text-xs text-ink-2">
          Employer
          <select
            value={employerId}
            onChange={(e) => setEmployerId(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
          >
            {catalog.map((c) => (
              <option key={c.employerId} value={c.employerId}>
                {c.name}
                {c.isActive ? "" : " (former)"}
              </option>
            ))}
          </select>
        </label>
        {(
          [
            ["Payment date", paymentDate, setPaymentDate, "paymentDate", true],
            ["Pay period begin", payBegin, setPayBegin, "payBeginDate", false],
            ["Pay period end", payEnd, setPayEnd, "payEndDate", false],
          ] as const
        ).map(([label, value, set, name, required]) => (
          <label key={name} className="block text-xs text-ink-2">
            {label}
            <input
              type="date"
              name={name}
              value={value}
              onChange={(e) => set(e.target.value)}
              required={required}
              className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
            />
          </label>
        ))}
        <label className="block text-xs text-ink-2">
          Annual salary
          <input
            inputMode="decimal"
            name="annualSalary"
            value={annualSalary}
            onChange={(e) => setAnnualSalary(e.target.value)}
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm tabular-nums text-ink"
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SECTIONS.map((section) => (
          <div
            key={section}
            className="rounded-lg border border-edge bg-surface-2/40 p-3"
          >
            <h4 className="mb-2 text-xs font-medium text-ink">
              {SECTION_LABELS[section]}
            </h4>
            <div className="space-y-1.5">
              {linesFor(section).map((name) => (
                <label
                  key={name}
                  className="flex items-center justify-between gap-2 text-xs text-ink-2"
                >
                  <span className="min-w-0 flex-1 truncate" title={name}>
                    {name}
                  </span>
                  <input
                    inputMode="decimal"
                    name={itemFieldName(section, name)}
                    value={values[key(section, name)] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [key(section, name)]: e.target.value,
                      }))
                    }
                    placeholder="0"
                    className="w-24 shrink-0 rounded-md border border-edge bg-surface px-1.5 py-1 text-right text-sm tabular-nums text-ink"
                  />
                </label>
              ))}
              {linesFor(section).length === 0 && (
                <p className="text-xs text-ink-3">No lines yet.</p>
              )}
            </div>
            {adding === section ? (
              <div className="mt-2 flex gap-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Line name"
                  className="min-w-0 flex-1 rounded-md border border-edge bg-surface px-1.5 py-1 text-xs text-ink"
                />
                <button
                  type="button"
                  onClick={() => {
                    const n = newName.trim();
                    if (n) {
                      setExtra((x) => ({ ...x, [section]: [...x[section], n] }));
                      setValues((v) => ({ ...v, [key(section, n)]: "" }));
                    }
                    setNewName("");
                    setAdding(null);
                  }}
                  className="rounded-md border border-edge px-2 py-1 text-xs text-ink-2 hover:bg-surface"
                >
                  Add
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(section)}
                className="mt-2 text-xs text-ink-3 hover:text-ink-2"
              >
                + add a line
              </button>
            )}
          </div>
        ))}
      </div>

      {retiredCount > 0 && (
        <button
          type="button"
          onClick={() => setShowRetired((s) => !s)}
          className="text-xs text-ink-3 hover:text-ink-2"
        >
          {showRetired ? "Hide" : "Show"} {retiredCount} line
          {retiredCount === 1 ? "" : "s"} this employer no longer uses
        </button>
      )}

      {/* The workbook's Checksum column, live. Net pay is the one figure typed
          rather than derived — it is what the cheque actually says — so the
          gap between it and the arithmetic is the check that the stub is
          complete. */}
      <div className="space-y-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-ink-2">
          <span className="tabular-nums">
            income {money(totals.taxableIncome, true)}
          </span>
          {totals.imputed !== 0 && (
            <span className="tabular-nums">
              − imputed {money(totals.imputed, true)}
            </span>
          )}
          <span className="tabular-nums">
            − pre-tax {money(totals.preTaxTotal, true)}
          </span>
          <span className="tabular-nums">
            − taxes {money(totals.taxesTotal, true)}
          </span>
          <span className="tabular-nums">
            − post-tax {money(totals.postTaxTotal, true)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-ink-2">
            computes to{" "}
            <strong className="tabular-nums text-ink">
              {money(totals.computedNet, true)}
            </strong>
            {ties ? (
              <span className="ml-2 text-xs text-good">
                ✓ ties out to net pay
              </span>
            ) : (
              <span className="ml-2 text-xs text-bad">
                off by {money(gap, true)} against net pay
              </span>
            )}
          </span>
          <label className="block text-xs text-ink-2">
            Net pay{" "}
            <input
              inputMode="decimal"
              name="netPay"
              value={netPay}
              onChange={(e) => setNetPay(e.target.value)}
              required
              className={`ml-1 w-28 rounded-md border bg-surface px-1.5 py-1 text-right text-sm tabular-nums text-ink ${
                ties ? "border-edge" : "border-bad/60"
              }`}
            />
          </label>
        </div>
        <p className="text-xs text-ink-3">
          Derived and stored: gross {money(totals.totalIncome, true)} · federal{" "}
          {money(totals.federalTax, true)} · taxes{" "}
          {money(totals.taxesTotal, true)} · 401(k){" "}
          {money(totals.retirement401k, true)} (trad{" "}
          {money(totals.k401Split.traditional, true)} / Roth{" "}
          {money(totals.k401Split.roth, true)} / after-tax{" "}
          {money(totals.k401Split.afterTax, true)}) · HSA{" "}
          {money(totals.hsa, true)} · bonus {money(totals.bonus, true)}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-3">
          {lineCount} line item{lineCount === 1 ? "" : "s"}
          {employer?.last
            ? ` · prefilled from ${dateLabel(employer.last.paymentDate)}`
            : ""}
        </p>
        <span className="flex items-center gap-3">
          {!ties && (
            <label className="flex items-center gap-1.5 text-xs text-bad">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              save anyway
            </label>
          )}
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save stub"}
          </button>
        </span>
      </div>

      {result && (
        <p
          aria-live="polite"
          className={`rounded-lg border px-3 py-2 text-xs ${
            result.ok
              ? "border-good/40 text-good"
              : "border-bad/40 text-bad"
          }`}
        >
          {result.message}
        </p>
      )}
    </form>
  );
}
