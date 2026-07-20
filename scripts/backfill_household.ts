// Phase 0 backfill for the household model (docs/HOUSEHOLD.md).
// Idempotent — safe to re-run.
//
//  1. Removes synthetic `fixture` provider rows. These are test data from
//     development syncs that landed in the real database, and two were even
//     auto-linked to real Fred accounts — they would corrupt household
//     totals. Child rows (snapshots/transactions/holdings) cascade.
//  2. Marks the Monarch mortgage `ignored`, recording *why*: the property
//     ledger already nets it inside even-split equity, so counting it in the
//     roster would double count (docs/HOUSEHOLD.md decision 2).
//  3. Promotes already auto-linked Monarch rows to `confirmed`, and parks
//     everything else as `pending` for the review queue — pending never
//     counts, which is what keeps duplicates from inflating net worth while
//     triage is in progress.
//
// Usage: npm run household:backfill
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../src/db";
import { accounts, externalAccounts } from "../src/db/schema";

async function main() {
  // 1. purge synthetic fixture rows -----------------------------------------
  const fixtures = await db
    .select()
    .from(externalAccounts)
    .where(eq(externalAccounts.provider, "fixture"));
  if (fixtures.length) {
    await db
      .delete(externalAccounts)
      .where(eq(externalAccounts.provider, "fixture"));
    console.log(`removed ${fixtures.length} synthetic fixture rows:`);
    for (const f of fixtures) console.log(`   - ${f.name}`);
  } else {
    console.log("no fixture rows to remove");
  }

  // 2. ignore what the property ledger already represents ---------------------
  const propertyish = await db
    .select()
    .from(externalAccounts)
    .where(
      and(
        eq(externalAccounts.provider, "monarch"),
        eq(externalAccounts.accountType, "mortgage"),
      ),
    );
  // Only the primary-residence mortgage is represented elsewhere; other
  // "mortgage"-typed rows from Monarch (e.g. an auto loan) are real
  // liabilities that belong in the roster.
  const residence = propertyish.filter((e) => /mortgage/i.test(e.name));
  for (const e of residence) {
    await db
      .update(externalAccounts)
      .set({
        matchStatus: "ignored",
        matchNote:
          "Already represented by the property ledger (/house) — counting it here would double count against even-split equity.",
        linkedAccountId: null,
      })
      .where(eq(externalAccounts.id, e.id));
    console.log(`ignored (property ledger): ${e.name}`);
  }

  // 3. confirm existing auto-links, park the rest as pending ------------------
  const confirmed = await db
    .update(externalAccounts)
    .set({ matchStatus: "confirmed" })
    .where(
      and(
        eq(externalAccounts.provider, "monarch"),
        isNotNull(externalAccounts.linkedAccountId),
      ),
    )
    .returning({ name: externalAccounts.name });
  console.log(`confirmed ${confirmed.length} existing auto-links`);

  // Everything unlinked that wasn't deliberately ignored goes to the queue.
  const stillUnlinked = await db
    .select()
    .from(externalAccounts)
    .where(
      and(
        eq(externalAccounts.provider, "monarch"),
        isNull(externalAccounts.linkedAccountId),
      ),
    );
  let pendingCount = 0;
  for (const e of stillUnlinked) {
    if (e.matchStatus === "ignored") continue;
    await db
      .update(externalAccounts)
      .set({ matchStatus: "pending" })
      .where(eq(externalAccounts.id, e.id));
    pendingCount++;
  }
  console.log(`${pendingCount} accounts queued for review`);

  // 4. hub accounts are in the household by default --------------------------
  await db.update(accounts).set({ includeInHousehold: true });
  const hub = await db.select().from(accounts);
  console.log(`${hub.length} hub accounts marked household-included`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
