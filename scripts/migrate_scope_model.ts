// One-time migration onto the unified scope model (docs/HOUSEHOLD.md Phase 3).
//
// Everything here is derived from the state the old two-flag model left
// behind, so it is safe to re-run: each step is idempotent, and the whole
// thing refuses to write unless invoked with `--apply`.
//
//   npx tsx scripts/migrate_scope_model.ts            # dry run, prints a plan
//   npx tsx scripts/migrate_scope_model.ts --apply    # writes
//
// Against production, prefix with `node --env-file=.env`.
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import {
  accountEntries,
  accounts,
  properties,
  propertyValuations,
} from "../src/db/schema";

const APPLY = process.argv.includes("--apply");
const m = (v: number) =>
  (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });

type Change = { what: string; detail: string };
const planned: Change[] = [];
const plan = (what: string, detail: string) => planned.push({ what, detail });

async function main() {
  const [accts, props] = await Promise.all([
    db.select().from(accounts).orderBy(accounts.sortOrder),
    db.select().from(properties),
  ]);
  const property = props[0] ?? null;
  const byName = new Map(accts.map((a) => [a.name, a]));

  // -------------------------------------------------------------- exclusions
  // The old include_in_net_worth conflated "isn't Scott's" with "deliberately
  // excluded". Ownership now carries the first meaning, so only the genuine
  // exclusions survive: unvested equity, and the home + its mortgage.
  const UNVESTED = ["HS RSUs"];
  const RESIDENCE = ["Mortgage (...9242)"];

  for (const a of accts) {
    // The house account created below is itself a residence — matching on the
    // property link rather than only the name list keeps a second run from
    // un-excluding what the first run created.
    const isResidence =
      RESIDENCE.includes(a.name) ||
      (a.propertyId != null && a.category === "property");
    const want = UNVESTED.includes(a.name)
      ? "unvested"
      : isResidence
        ? "primary_residence"
        : null;
    if ((a.exclusion ?? null) !== want) {
      plan("exclusion", `${a.name}: ${a.exclusion ?? "counted"} -> ${want ?? "counted"}`);
      if (APPLY) {
        await db.update(accounts).set({ exclusion: want }).where(eq(accounts.id, a.id));
      }
    }
  }

  // ------------------------------------------------------- close tracking
  // An account is part of the monthly close if it has ever had a statement.
  // Everything else rides on its provider feed and should not be asked for
  // one it will never receive.
  const withEntries = new Set(
    (await db.select({ id: accountEntries.accountId }).from(accountEntries)).map(
      (r) => r.id,
    ),
  );
  for (const a of accts) {
    const want = withEntries.has(a.id);
    if (a.tracksMonthlyClose !== want) {
      plan("close tracking", `${a.name}: ${a.tracksMonthlyClose} -> ${want}`);
      if (APPLY) {
        await db
          .update(accounts)
          .set({ tracksMonthlyClose: want })
          .where(eq(accounts.id, a.id));
      }
    }
  }

  // ------------------------------------------------------- ownership shares
  // Joint means shared: an even split, matching how the house has always been
  // handled. This is what makes the per-person filters add back up to the
  // household total.
  for (const a of accts) {
    const want = a.isJoint ? 0.5 : 1;
    if (a.ownershipShare !== want) {
      plan("ownership", `${a.name}: share ${a.ownershipShare} -> ${want}`);
      if (APPLY) {
        await db
          .update(accounts)
          .set({ ownershipShare: want })
          .where(eq(accounts.id, a.id));
      }
    }
  }

  // --------------------------------------------------------- tax treatment
  // Accounts added from a provider feed default to 'na', which leaves the tax
  // bucketer guessing from category — and category alone calls every
  // retirement account pre-tax, silently converting a Roth IRA into a
  // taxed-at-withdrawal balance. Set what the name plainly says.
  for (const a of accts) {
    if (a.taxTreatment !== "na") continue;
    const n = a.name.toLowerCase();
    const want = /\broth\b/.test(n)
      ? "roth"
      : /\bhsa\b|health savings/.test(n)
        ? "hsa"
        : /pension/.test(n)
          ? "pension"
          : /traditional|\btrad\b|\bsep\b|401\s*\(?k\)?|\bira\b/.test(n)
            ? "traditional"
            : ["cash", "brokerage", "crypto"].includes(a.category)
              ? "taxable"
              : null;
    if (!want) continue;
    plan("tax treatment", `${a.name}: na -> ${want}`);
    if (APPLY) {
      await db
        .update(accounts)
        .set({ taxTreatment: want as typeof a.taxTreatment })
        .where(eq(accounts.id, a.id));
    }
  }

  // ------------------------------------------------------------ active flags
  // "Inactive" had been used loosely for "I don't use this much". It now means
  // the account is closed and holds nothing, so accounts still holding money
  // must be marked active or the new closed-is-zero rule would erase them.
  const REOPEN = ["BECU", "Alpaca", "Robinhood"];
  for (const name of REOPEN) {
    const a = byName.get(name);
    if (!a || a.isActive) continue;
    plan("is_active", `${name}: false -> true (still holds money / still syncing)`);
    if (APPLY) {
      await db.update(accounts).set({ isActive: true }).where(eq(accounts.id, a.id));
    }
  }

  // ----------------------------------------------------------- house account
  // The property becomes a first-class household account so the roster stops
  // showing a mortgage with no asset behind it. Its value comes from the
  // valuation ledger, not from statements.
  if (property) {
    const existing = accts.find(
      (a) => a.propertyId === property.id && a.category === "property",
    );
    const valuations = await db
      .select()
      .from(propertyValuations)
      .where(eq(propertyValuations.propertyId, property.id));
    const newest = valuations.sort((a, b) => (a.date < b.date ? 1 : -1))[0];

    if (!existing) {
      plan(
        "house account",
        `create "${property.name}" (property, joint, 50%, primary_residence) valued ${m(newest?.marketValue ?? 0)} as of ${newest?.date ?? "?"}`,
      );
      if (APPLY) {
        await db.insert(accounts).values({
          slug: property.slug,
          name: property.name,
          institution: null,
          category: "property",
          taxTreatment: "na",
          ownerPersonId: null,
          isJoint: true,
          ownershipShare: 0.5,
          isActive: true,
          exclusion: "primary_residence",
          tracksMonthlyClose: false,
          propertyId: property.id,
          sortOrder: 900,
          notes: "Value comes from the property ledger (valuations), not statements.",
        });
      }
    }

    // Point the mortgage at the same property so its ledger balance becomes a
    // second source to resolve against Monarch's.
    const mortgage = byName.get("Mortgage (...9242)");
    if (mortgage && mortgage.propertyId !== property.id) {
      plan("mortgage", `link to property ledger (adds a second balance source)`);
      if (APPLY) {
        await db
          .update(accounts)
          .set({ propertyId: property.id })
          .where(eq(accounts.id, mortgage.id));
      }
    }
  }

  // ------------------------------------------------------------------ report
  if (planned.length === 0) {
    console.log("Nothing to change — already migrated.");
  } else {
    const groups = new Map<string, string[]>();
    for (const c of planned) {
      const list = groups.get(c.what) ?? [];
      list.push(c.detail);
      groups.set(c.what, list);
    }
    for (const [what, details] of groups) {
      console.log(`\n${what.toUpperCase()} (${details.length})`);
      for (const d of details) console.log(`  ${d}`);
    }
  }
  console.log(
    `\n${APPLY ? "APPLIED" : "DRY RUN"} — ${planned.length} change(s).${APPLY ? "" : " Re-run with --apply to write."}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
