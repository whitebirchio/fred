import { defineConfig } from "drizzle-kit";

// With DATABASE_URL set, drizzle-kit targets Neon/Postgres directly.
// Without it, it targets the local PGlite database used by the dev server.
export default process.env.DATABASE_URL
  ? defineConfig({
      dialect: "postgresql",
      schema: "./src/db/schema.ts",
      out: "./drizzle",
      dbCredentials: { url: process.env.DATABASE_URL },
    })
  : defineConfig({
      dialect: "postgresql",
      driver: "pglite",
      schema: "./src/db/schema.ts",
      out: "./drizzle",
      dbCredentials: { url: "./.data/pglite" },
    });
