// Exercise the whole account lifecycle against whichever database is
// configured — create, edit, archive, reopen, delete — asserting what each
// step does to the rollup. Intended for the local PGlite database; it creates
// and then removes its own account, touching nothing else.
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { accountEntries, accounts } from "../src/db/schema";
import { DEFAULT_SCOPE, loadHousehold, rollup } from "../src/lib/household";
import { monthEnd } from "../src/lib/format";

const m = (v: number) =>
  (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const SLUG = "lifecycle-probe-account";
const OPENING = 12_345.67;

async function netWorth() {
  const hh = await loadHousehold();
  return { net: rollup(hh.accounts, DEFAULT_SCOPE, hh.primaryPersonId).net, hh };
}

async function main() {
  // Clean up anything a previous interrupted run left behind.
  const [stale] = await db.select().from(accounts).where(eq(accounts.slug, SLUG));
  if (stale) await db.delete(accounts).where(eq(accounts.id, stale.id));

  const before = (await netWorth()).net;
  console.log(`Baseline net worth ${m(before)}\n`);

  // ---------------------------------------------------------------- create
  console.log("CREATE");
  const now = new Date();
  const [created] = await db
    .insert(accounts)
    .values({
      slug: SLUG,
      name: "Lifecycle Probe",
      institution: "Test Bank",
      category: "cash",
      taxTreatment: "taxable",
      isJoint: false,
      ownershipShare: 1,
      isActive: true,
      exclusion: null,
      tracksMonthlyClose: true,
      sortOrder: 999,
    })
    .returning();
  await db.insert(accountEntries).values({
    accountId: created.id,
    statementDate: monthEnd(now.getUTCFullYear(), now.getUTCMonth() + 1),
    balance: OPENING,
    notes: "Opening balance",
  });

  const afterCreate = await netWorth();
  check(
    "a new account with an opening balance raises net worth by exactly that",
    Math.abs(afterCreate.net - before - OPENING) < 0.01,
    `${m(before)} -> ${m(afterCreate.net)}`,
  );
  const row = afterCreate.hh.accounts.find((a) => a.id === created.id)!;
  check("it appears in the roster", Boolean(row), row?.name);
  check("its balance resolves from Fred", row?.balance.source === "fred", row?.balance.source ?? "none");
  check("it is in the monthly close by default", row?.tracksMonthlyClose === true);

  // ------------------------------------------------------------------ edit
  console.log("\nEDIT");
  await db
    .update(accounts)
    .set({ name: "Lifecycle Probe (renamed)", category: "brokerage" })
    .where(eq(accounts.id, created.id));
  const afterEdit = await netWorth();
  const edited = afterEdit.hh.accounts.find((a) => a.id === created.id)!;
  check("rename and retype take effect", edited.name.endsWith("(renamed)") && edited.category === "brokerage");
  check(
    "editing identity does not move net worth",
    Math.abs(afterEdit.net - afterCreate.net) < 0.01,
    `${m(afterEdit.net)}`,
  );

  // --------------------------------------------------------------- archive
  console.log("\nARCHIVE");
  await db
    .update(accounts)
    .set({ isActive: false, archivedAt: now.toISOString().slice(0, 10) })
    .where(eq(accounts.id, created.id));
  const afterArchive = await netWorth();
  const archived = afterArchive.hh.accounts.find((a) => a.id === created.id)!;
  check(
    "archiving removes exactly its balance from net worth",
    Math.abs(afterArchive.net - before) < 0.01,
    `${m(afterCreate.net)} -> ${m(afterArchive.net)} (baseline ${m(before)})`,
  );
  check("it contributes $0", archived.signedBalance === 0, m(archived.signedBalance));
  check("it is still in the roster", Boolean(archived));
  check("its statement history survives", archived.hasStatements === true);
  check("archivedAt is recorded", Boolean(archived.archivedAt), archived.archivedAt ?? "null");

  // ---------------------------------------------------------------- reopen
  console.log("\nREOPEN");
  await db
    .update(accounts)
    .set({ isActive: true, archivedAt: null })
    .where(eq(accounts.id, created.id));
  const afterReopen = await netWorth();
  const reopened = afterReopen.hh.accounts.find((a) => a.id === created.id)!;
  check(
    "reopening restores the balance exactly",
    Math.abs(afterReopen.net - afterCreate.net) < 0.01,
    `${m(afterReopen.net)}`,
  );
  check("archivedAt is cleared", reopened.archivedAt === null);

  // ---------------------------------------------------------------- delete
  console.log("\nDELETE (cleanup)");
  await db.delete(accounts).where(eq(accounts.id, created.id));
  const afterDelete = await netWorth();
  check(
    "deleting returns net worth to the baseline",
    Math.abs(afterDelete.net - before) < 0.01,
    `${m(afterDelete.net)} vs ${m(before)}`,
  );
  const orphans = await db
    .select()
    .from(accountEntries)
    .where(eq(accountEntries.accountId, created.id));
  check("its entries cascade away", orphans.length === 0, `${orphans.length} left`);

  console.log(
    `\n${failures === 0 ? "LIFECYCLE OK" : `${failures} FAILURE(S)`} — baseline restored at ${m(afterDelete.net)}.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
