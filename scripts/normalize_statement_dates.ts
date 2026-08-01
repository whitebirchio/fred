// Snap close entries onto their month's last day.
//
// A close is a month-end figure, so the day-of-month carries no information —
// but a stray day makes the roster read oddly and defeats "one row per month"
// at a glance. Every row this touches already falls inside the same month
// (series bucketing compares date <= month end), so nothing about any total
// changes; only the label does.
//
// Rows whose canonical date is already taken by another entry are NOT touched:
// that is a genuine duplicate month needing a human decision about which
// figure is right, not a date to rewrite.
//
//   npx tsx scripts/normalize_statement_dates.ts            # dry run
//   npx tsx scripts/normalize_statement_dates.ts --apply
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { accountEntries, accounts } from "../src/db/schema";
import { monthEnd } from "../src/lib/format";

const APPLY = process.argv.includes("--apply");

async function main() {
  const [rows, accts] = await Promise.all([
    db.select().from(accountEntries),
    db.select().from(accounts),
  ]);
  const name = new Map(accts.map((a) => [a.id, a.name]));
  const taken = new Set(rows.map((r) => `${r.accountId}|${r.statementDate}`));

  let moved = 0;
  const blocked: string[] = [];

  for (const r of rows) {
    const [y, m] = r.statementDate.split("-").map(Number);
    const canonical = monthEnd(y, m);
    if (r.statementDate === canonical) continue;

    if (taken.has(`${r.accountId}|${canonical}`)) {
      blocked.push(
        `${name.get(r.accountId)} ${r.statementDate} -> ${canonical} BLOCKED: that month already has an entry`,
      );
      continue;
    }
    console.log(`  ${name.get(r.accountId)}: ${r.statementDate} -> ${canonical}`);
    moved++;
    if (APPLY) {
      await db
        .update(accountEntries)
        .set({ statementDate: canonical })
        .where(eq(accountEntries.id, r.id));
      taken.delete(`${r.accountId}|${r.statementDate}`);
      taken.add(`${r.accountId}|${canonical}`);
    }
  }

  if (blocked.length) {
    console.log("\nNeeds a human decision (two entries would land in one month):");
    for (const b of blocked) console.log(`  ${b}`);
  }
  console.log(
    `\n${APPLY ? "APPLIED" : "DRY RUN"} — ${moved} moved, ${blocked.length} left alone.${APPLY ? "" : " Re-run with --apply."}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
