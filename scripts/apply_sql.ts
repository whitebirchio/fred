// Run a .sql file against whichever database the app itself would use, so a
// schema change lands in exactly the place the code reads from — no separate
// psql setup, no chance of pointing at the wrong host.
//
//   npx tsx scripts/apply_sql.ts scripts/sql/scope_model.sql              # local
//   node --env-file=.env npx tsx scripts/apply_sql.ts scripts/sql/…       # prod
//
// Requires DDL rights, so with a production URL this must be the owner role
// (the app role deliberately has none — see docs/DEPLOY.md).
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../src/db";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx scripts/apply_sql.ts <file.sql>");
    process.exit(1);
  }
  const target = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@")
    : "local PGlite (.data/pglite)";
  console.log(`Applying ${file}\n     to ${target}\n`);

  // Split on statement boundaries, but keep dollar-quoted blocks ($$ … $$)
  // whole — a DO block contains semicolons that are not statement ends.
  const text = readFileSync(file, "utf8");
  const statements: string[] = [];
  let buf = "";
  let inDollar = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("--") && !buf.trim()) continue;
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    buf += line + "\n";
    if (!inDollar && line.trimEnd().endsWith(";")) {
      if (buf.trim()) statements.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) statements.push(buf.trim());

  for (const stmt of statements) {
    const label = stmt.replace(/\s+/g, " ").slice(0, 90);
    try {
      const res = (await db.execute(sql.raw(stmt))) as unknown as {
        rows?: Record<string, unknown>[];
      };
      const rows = res.rows ?? (res as unknown as Record<string, unknown>[]);
      const suffix =
        Array.isArray(rows) && rows.length
          ? ` -> ${JSON.stringify(rows[0])}`
          : "";
      console.log(`  ✓ ${label}${suffix}`);
    } catch (err) {
      console.error(`  ✗ ${label}`);
      throw err;
    }
  }
  console.log(`\n${statements.length} statement(s) applied.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
