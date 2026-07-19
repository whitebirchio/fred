import { loadHouse, houseMonthly } from "@/lib/metrics";
import { dateLabel, money, pct } from "@/lib/format";
import { Card, PageHeader, StatTile } from "@/components/ui";
import { TimeSeriesChart } from "@/components/charts";
import { addHousePayment, addValuation } from "@/app/actions";

export const dynamic = "force-dynamic";

const PAYMENT_LABEL: Record<string, string> = {
  down_payment: "Down payment",
  mortgage: "Mortgage",
  hoa: "HOA",
  fees: "Fees",
  escrow: "Escrow",
  other: "Other",
};

export default async function HousePage() {
  const house = await loadHouse();
  if (!house) return <p className="text-ink-2">No property data.</p>;
  const months = houseMonthly(house);
  const last = months.at(-1);
  if (!last) return <p className="text-ink-2">No payments yet.</p>;

  const { property, payments, shares, people } = house;
  const scott = people.find((p) => p.isPrimary);
  const kate = people.find((p) => !p.isPrimary);
  const totalPaid = last.cumScott + last.cumKate;

  const shareByPayment = new Map<number, Map<number, number>>();
  for (const s of shares) {
    const m = shareByPayment.get(s.paymentId) ?? new Map<number, number>();
    m.set(s.personId, s.amount);
    shareByPayment.set(s.paymentId, m);
  }

  const valueSeries = months.map((m) => ({
    date: m.date,
    market: m.marketValue,
    loan: m.loanBalance,
    equity: m.equity,
  }));
  const paidSeries = months.map((m) => ({
    date: m.date,
    scott: m.cumScott,
    kate: m.cumKate,
  }));
  const costSeries = months.map((m) => ({
    date: m.date,
    principal: m.cumPrincipal,
    interest: m.cumInterest,
    escrow: m.cumEscrow,
    hoa: m.cumHoa,
    fees: m.cumFees,
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title={property.name}
        subtitle={`Purchased ${dateLabel(property.purchaseDate)} for ${money(
          property.purchasePrice,
        )} · shared ledger with per-person splits`}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Market value" value={money(last.marketValue)} />
        <StatTile label="Loan balance" value={money(last.loanBalance)} />
        <StatTile label="Total equity" value={money(last.equity)} />
        <StatTile
          label="Even-split equity"
          value={money(last.equityShare)}
          sub="counted in net worth"
        />
        <StatTile
          label={`${scott?.name ?? "Scott"} paid`}
          value={money(last.cumScott)}
          sub={totalPaid ? pct(last.cumScott / totalPaid) : undefined}
        />
        <StatTile
          label={`${kate?.name ?? "Kate"} paid`}
          value={money(last.cumKate)}
          sub={totalPaid ? pct(last.cumKate / totalPaid) : undefined}
        />
      </div>

      <Card title="Value, loan and equity">
        <TimeSeriesChart
          data={valueSeries}
          series={[
            { key: "market", name: "Market value", color: "var(--series-1)" },
            { key: "loan", name: "Loan balance", color: "var(--series-6)" },
            { key: "equity", name: "Equity", color: "var(--series-2)" },
          ]}
          height={300}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cumulative paid, by person">
          <TimeSeriesChart
            data={paidSeries}
            series={[
              { key: "scott", name: scott?.name ?? "Scott", color: "var(--series-1)" },
              { key: "kate", name: kate?.name ?? "Kate", color: "var(--series-7)" },
            ]}
          />
        </Card>
        <Card title="Where payments went" subtitle="Cumulative allocation">
          <TimeSeriesChart
            data={costSeries}
            stacked
            series={[
              { key: "principal", name: "Principal", color: "var(--series-1)" },
              { key: "interest", name: "Interest", color: "var(--series-6)" },
              { key: "escrow", name: "Escrow", color: "var(--series-3)" },
              { key: "hoa", name: "HOA", color: "var(--series-5)" },
              { key: "fees", name: "Fees", color: "var(--series-8)" },
            ]}
          />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Add payment"
          subtitle="Mortgage, HOA or other — with per-person split"
        >
          <form action={addHousePayment} className="grid grid-cols-2 gap-3 text-xs text-ink-2 sm:grid-cols-3">
            <input type="hidden" name="propertyId" value={property.id} />
            <label className="block">
              Date
              <input
                type="date"
                name="date"
                required
                className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
              />
            </label>
            <label className="block">
              Type
              <select
                name="type"
                className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
              >
                <option value="mortgage">Mortgage</option>
                <option value="hoa">HOA</option>
                <option value="fees">Fees</option>
                <option value="escrow">Escrow</option>
                <option value="other">Other</option>
              </select>
            </label>
            <span />
            {[
              [`share_${scott?.slug ?? "scott"}`, `${scott?.name ?? "Scott"} paid`],
              [`share_${kate?.slug ?? "kate"}`, `${kate?.name ?? "Kate"} paid`],
              ["principal", "→ Principal"],
              ["interest", "→ Interest"],
              ["escrow", "→ Escrow"],
              ["hoa", "→ HOA"],
              ["fees", "→ Fees"],
              ["loanBalanceAfter", "Loan balance after"],
            ].map(([name, label]) => (
              <label key={name} className="block">
                {label}
                <input
                  inputMode="decimal"
                  name={name}
                  placeholder="0"
                  className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm tabular-nums text-ink"
                />
              </label>
            ))}
            <label className="col-span-2 block sm:col-span-3">
              Notes
              <input
                name="notes"
                className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
              />
            </label>
            <div className="col-span-2 sm:col-span-3">
              <button className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">
                Save payment
              </button>
            </div>
          </form>
        </Card>

        <Card
          title="Update market value"
          subtitle="Monthly estimate (e.g. Zillow) drives the equity series"
        >
          <form action={addValuation} className="flex flex-wrap items-end gap-3 text-xs text-ink-2">
            <input type="hidden" name="propertyId" value={property.id} />
            <label className="block">
              Date
              <input
                type="date"
                name="date"
                required
                className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
              />
            </label>
            <label className="block">
              Market value
              <input
                inputMode="decimal"
                name="marketValue"
                required
                placeholder="627300"
                className="mt-1 w-full rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm tabular-nums text-ink"
              />
            </label>
            <button className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">
              Save value
            </button>
          </form>
          <p className="mt-3 text-xs text-ink-3">
            Equity = market value − loan balance. Net worth counts{" "}
            {pct(property.equityShare, 0)} of it (even split).
          </p>
        </Card>
      </div>

      <Card title="Payment ledger" subtitle="Most recent first">
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-ink-3">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Date</th>
                <th className="py-1.5 pr-2 font-medium">Type</th>
                <th className="py-1.5 pr-2 text-right font-medium">{scott?.name}</th>
                <th className="py-1.5 pr-2 text-right font-medium">{kate?.name}</th>
                <th className="py-1.5 pr-2 text-right font-medium">Principal</th>
                <th className="py-1.5 pr-2 text-right font-medium">Interest</th>
                <th className="py-1.5 text-right font-medium">Loan after</th>
              </tr>
            </thead>
            <tbody>
              {[...payments].reverse().slice(0, 60).map((p) => {
                const s = shareByPayment.get(p.id);
                return (
                  <tr key={p.id} className="border-t border-edge">
                    <td className="py-1.5 pr-2 whitespace-nowrap">{dateLabel(p.date)}</td>
                    <td className="py-1.5 pr-2 text-ink-2">{PAYMENT_LABEL[p.type]}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(s?.get(scott?.id ?? -1) ?? 0, true)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(s?.get(kate?.id ?? -1) ?? 0, true)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(p.principal, true)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(p.interest, true)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {p.loanBalanceAfter != null ? money(p.loanBalanceAfter, true) : "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
