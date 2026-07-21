// Proves scripts/sql/app_role.sql actually confines the app: `npm run verify:dbrole`.
//
// A grant script nobody has tested is a guess. This builds Fred's real schema
// in a throwaway embedded Postgres, applies the role SQL, switches to the app
// role, and asserts both halves of the boundary — that ordinary application
// work succeeds, and that everything destructive is refused.
//
// It also covers the failure mode that bites later rather than immediately: a
// table added by a future `db:push` must be reachable by the app role via
// ALTER DEFAULT PRIVILEGES, or the app breaks on the next migration.
//
// Runs entirely on a temp database. It never touches .data/pglite or Neon.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_ROLE = "fred_app";
const TEST_PASSWORD = "test-only-password";

type Check = { name: string; ok: boolean; detail: string };

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fred-role-"));
  const checks: Check[] = [];

  try {
    // Fred's real schema as plain DDL, straight from the Drizzle definitions.
    const ddl = execFileSync(
      "node",
      ["node_modules/.bin/drizzle-kit", "export", "--sql"],
      { encoding: "utf8", cwd: process.cwd() },
    )
      // drizzle-kit prefixes progress lines; keep only SQL.
      .split("\n")
      .filter((l) => !/^\s*(Reading|\[|No config|Warning)/i.test(l))
      .join("\n");

    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(path.join(tmp, "pg"));

    for (const stmt of ddl.split("--> statement-breakpoint")) {
      if (stmt.trim()) await db.exec(stmt);
    }

    const [{ current_database: dbName }] = (
      await db.query<{ current_database: string }>("SELECT current_database()")
    ).rows;

    const roleSql = fs
      .readFileSync("scripts/sql/app_role.sql", "utf8")
      .replace("CHANGE_ME", TEST_PASSWORD)
      .replace("GRANT CONNECT ON DATABASE neondb", `GRANT CONNECT ON DATABASE ${dbName}`);
    await db.exec(roleSql);

    const owner = (
      await db.query<{ current_user: string }>("SELECT current_user")
    ).rows[0].current_user;

    // A table created *after* the grants ran — stands in for the next
    // migration. Created by the owner, so default privileges should apply.
    await db.exec(`CREATE TABLE future_migration_table (id serial primary key, note text)`);

    const asApp = async (sql: string) => {
      await db.exec(`SET ROLE ${APP_ROLE}`);
      try {
        await db.exec(sql);
        return null;
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      } finally {
        await db.exec(`RESET ROLE`);
      }
    };

    const allow = async (name: string, sql: string) => {
      const err = await asApp(sql);
      checks.push({
        name,
        ok: err === null,
        detail: err === null ? "allowed" : `BLOCKED: ${err.slice(0, 70)}`,
      });
    };
    const deny = async (name: string, sql: string) => {
      const err = await asApp(sql);
      checks.push({
        name,
        ok: err !== null,
        detail: err === null ? "ALLOWED — should not be!" : "denied",
      });
    };

    // --- what the app must be able to do -----------------------------------
    await allow("read accounts", "SELECT * FROM accounts LIMIT 1");
    await allow(
      "insert a person (uses a sequence)",
      "INSERT INTO persons (slug, name, is_primary) VALUES ('t', 'T', false)",
    );
    await allow("update", "UPDATE persons SET name = 'T2' WHERE slug = 't'");
    await allow("delete", "DELETE FROM persons WHERE slug = 't'");
    await allow("read a table added by a later migration", "SELECT * FROM future_migration_table");
    await allow(
      "write a table added by a later migration",
      "INSERT INTO future_migration_table (note) VALUES ('ok')",
    );

    // --- what it must not ---------------------------------------------------
    await deny("DROP TABLE", "DROP TABLE accounts");
    await deny("TRUNCATE", "TRUNCATE accounts");
    await deny("ALTER TABLE", "ALTER TABLE accounts ADD COLUMN evil text");
    await deny("CREATE TABLE", "CREATE TABLE evil (id int)");
    await deny("CREATE ROLE", "CREATE ROLE eviluser LOGIN PASSWORD 'x'");
    await deny("DROP the schema", "DROP SCHEMA public CASCADE");
    await deny("read another role's password hash", "SELECT rolpassword FROM pg_authid");

    // --- role attributes ----------------------------------------------------
    const attrs = (
      await db.query<{
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolbypassrls: boolean;
        rolreplication: boolean;
      }>(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
         FROM pg_roles WHERE rolname = $1`,
        [APP_ROLE],
      )
    ).rows[0];
    const flags = Object.entries(attrs).filter(([, v]) => v === true);
    checks.push({
      name: "no admin attributes on the role",
      ok: flags.length === 0,
      detail: flags.length === 0 ? "none set" : `SET: ${flags.map(([k]) => k).join(", ")}`,
    });

    console.log(`Schema owner: ${owner}   app role: ${APP_ROLE}\n`);
    for (const c of checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(44)} ${c.detail}`);
    }

    const failed = checks.filter((c) => !c.ok).length;
    console.log(
      `\n${checks.length - failed}/${checks.length} ${failed === 0 ? "— ALL PASS" : `— ${failed} FAILED`}`,
    );
    return failed === 0 ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  (code: number) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
