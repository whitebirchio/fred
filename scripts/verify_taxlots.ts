// Sanity harness for the tax-lot engine: run with `npx tsx scripts/verify_taxlots.ts`.
// Expected reference values were taken from the original workbooks at seed time
// (see docs/ANALYSIS.md) and cross-checked against an independent Python
// simulation of the 401(k) lineage. They are fixed historical constants — the
// workbooks are not consulted again.
import { loadAccounts, loadHouse, houseMonthly, portfolioSeries } from "../src/lib/metrics";
import { taxLotSeries, TAX_BUCKETS } from "../src/lib/taxlots";

async function main() {
  const accts = await loadAccounts();
  const house = await loadHouse();
  const houseMonths = house ? houseMonthly(house) : [];
  const { months } = portfolioSeries(accts, houseMonths);

  // 1. Net worth unchanged by the schema migration
  const nw = months[months.length - 1];
  console.log(`Net worth ${nw.date}: ${nw.balance.toLocaleString()} (expect 2,403,754)`);

  // 2. Roth contributions preserved through the split
  const lm = accts.find((a) => a.slug === "lm-401k")!;
  const roth = lm.entries.reduce((s, e) => s + e.contributionsRoth, 0);
  console.log(`LM 401(k) lifetime Roth contributions: ${roth.toFixed(2)} (expect 95,926.68)`);

  // 3. Tax-lot engine output
  const lots = taxLotSeries(accts);
  console.log("\nCurrent buckets:");
  for (const b of TAX_BUCKETS) {
    console.log(`  ${b.padEnd(9)} ${Math.round(lots.current[b]).toLocaleString().padStart(12)}`);
  }
  const total = TAX_BUCKETS.reduce((s, b) => s + lots.current[b], 0);
  console.log(`  total     ${Math.round(total).toLocaleString().padStart(12)} (expect investable 2,217,795)`);

  const k401 = lots.units.find((u) => u.mixed)!;
  console.log(`\n401(k) unit "${k401.name}": balance ${k401.balance.toLocaleString()} (expect 653,884.26)`);
  console.log(`  roth      ${Math.round(k401.buckets.roth).toLocaleString()} (Python sim ≈ 216,937 after tie-out scaling)`);
  console.log(`  pretax    ${Math.round(k401.buckets.pretax).toLocaleString()} (Python sim ≈ 434,507)`);
  console.log(`  afterTax  ${Math.round(k401.buckets.afterTax).toLocaleString()} (Python sim ≈ 2,440)`);
  console.log(`\nDrift absorbed: ${JSON.stringify(lots.drift)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
