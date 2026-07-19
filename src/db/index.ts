import { neon } from "@neondatabase/serverless";
import {
  drizzle as drizzleNeonHttp,
  type NeonHttpDatabase,
} from "drizzle-orm/neon-http";
import path from "node:path";
import * as schema from "./schema";

// Driver selection:
//   DATABASE_URL set (Workers or Node) -> Neon serverless driver (SQL over
//     HTTP; works in both runtimes, so the app never needs node-postgres)
//   Node without DATABASE_URL          -> embedded PGlite in .data/pglite
//     (zero-setup local dev)

export type Db = NeonHttpDatabase<typeof schema>;

const isWorkers =
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers";

// PGlite must never reach the Workers bundle (its WASM alone exceeds the free
// plan's 3 MB cap). Bundler tracers constant-fold plain string concatenation,
// so the specifier is built from an env read, which cannot be folded at
// build time.
const untraceable = (name: string) => name + (process.env.__FRED_NOOP__ ?? "");

function buildDb(): Db {
  const url = process.env.DATABASE_URL;
  if (url) {
    return drizzleNeonHttp(neon(url), { schema });
  }
  if (isWorkers) {
    throw new Error(
      "DATABASE_URL is not set. Add the Neon connection string with: npx wrangler secret put DATABASE_URL",
    );
  }

  // A genuine Node require, out of the bundler's reach: getBuiltinModule is a
  // runtime API bundlers don't rewrite, and anchoring at the project root's
  // real path (not a virtual module URL) makes resolution walk the real
  // node_modules.
  const nodeModule = process.getBuiltinModule(
    "node:module",
  ) as typeof import("node:module");
  const nodeRequire = nodeModule.createRequire(
    path.join(process.cwd(), "package.json"),
  );
  const { PGlite } = nodeRequire(
    untraceable("@electric-sql/pglite"),
  ) as typeof import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = nodeRequire(
    untraceable("drizzle-orm/pglite"),
  ) as typeof import("drizzle-orm/pglite");
  const dataDir = path.join(process.cwd(), ".data", "pglite");
  return drizzlePglite(new PGlite(dataDir), { schema }) as unknown as Db;
}

const globalForDb = globalThis as unknown as { __fredDb?: Db };

// Lazy proxy: the database client only instantiates on first query, keeping
// module import side-effect free (matters for build-time page collection).
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = (globalForDb.__fredDb ??= buildDb());
    const value = Reflect.get(real, prop) as unknown;
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
});

export * from "./schema";
