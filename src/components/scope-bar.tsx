import { setScope } from "@/app/actions";
import type { Scope } from "@/lib/household";

// The one control that decides whose money every screen is showing. It lives
// in the shell rather than on a page so the answer can't differ between
// tabs — and it always states the current slice in words, because an
// unlabelled filtered total is the same failure as two totals disagreeing.

export function ScopeBar({
  scope,
  people,
}: {
  scope: Scope;
  people: { id: number; name: string; isPrimary: boolean }[];
}) {
  const options: { value: string; label: string }[] = [
    { value: "all", label: "Everyone" },
    ...people.map((p) => ({ value: String(p.id), label: p.name })),
    { value: "joint", label: "Joint" },
  ];
  const current = String(scope.who);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink-3">Showing</span>
      <div className="flex items-center gap-0.5 rounded-lg border border-edge p-0.5">
        {options.map((o) => (
          <form key={o.value} action={setScope}>
            <input type="hidden" name="who" value={o.value} />
            <input
              type="hidden"
              name="includeHome"
              value={scope.includeHome ? "1" : "0"}
            />
            <button
              type="submit"
              className={`rounded-md px-2 py-1 transition-colors ${
                current === o.value
                  ? "bg-accent text-white"
                  : "text-ink-2 hover:bg-surface-2"
              }`}
            >
              {o.label}
            </button>
          </form>
        ))}
      </div>
      <form action={setScope}>
        <input type="hidden" name="who" value={current} />
        <input
          type="hidden"
          name="includeHome"
          value={scope.includeHome ? "0" : "1"}
        />
        <button
          type="submit"
          title="The home and its mortgage are excluded by default — you always need somewhere to live, so that equity isn't spendable."
          className={`rounded-lg border px-2 py-1 transition-colors ${
            scope.includeHome
              ? "border-accent text-accent"
              : "border-edge text-ink-3 hover:bg-surface-2"
          }`}
        >
          {scope.includeHome ? "✓ " : ""}Home equity
        </button>
      </form>
    </div>
  );
}
