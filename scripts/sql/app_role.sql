-- Least-privilege database role for the deployed Worker.
--
-- Run this ONCE in the Neon SQL Editor (or psql) while connected to the Fred
-- database as the project's owner role. See docs/DEPLOY.md.
--
-- IMPORTANT: create this role with SQL, not from the Neon Console/CLI/API.
-- Roles created through those are automatically granted membership in
-- `neon_superuser` (CREATEDB, CREATEROLE, BYPASSRLS, REPLICATION, read/write
-- to every database) — that would produce a second admin, not a limited app
-- user. Roles created with SQL start with only the default public-schema
-- privileges, which is what we want.
--
-- Before running:
--   1. replace CHANGE_ME with a long random password — ALPHANUMERIC ONLY.
--      This password gets embedded in a postgresql:// URL (DEPLOY.md step 7),
--      where @ # % : / ? are all structural characters, not just symbols. A
--      password containing them produces a connection string that looks
--      right but fails to parse as a URL — every request throws and the app
--      500s. Generate a safe one with:
--        openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32; echo
--      Keep the result — Neon will not show it to you again; SQL-created
--      roles have no console-managed password.
--   2. replace neondb on the GRANT CONNECT line if your database has another
--      name
--
-- Re-running after a partial failure: if the role already exists, skip the
-- CREATE ROLE line (it errors as a duplicate) and run everything below it —
-- each GRANT/REVOKE/ALTER DEFAULT PRIVILEGES is safe to repeat.
--
-- Verify the result with: npm run verify:dbrole (against a throwaway copy of
-- the schema) — or just check the count this script prints at the end.

-- ---------------------------------------------------------------------------
-- The role
-- ---------------------------------------------------------------------------
CREATE ROLE fred_app WITH LOGIN PASSWORD 'CHANGE_ME';

-- No database-level powers. Spelled out rather than assumed: these are the
-- attributes that separate an app user from an administrator.
ALTER ROLE fred_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- Reach: this database, this schema, read-only structurally
-- ---------------------------------------------------------------------------
GRANT CONNECT ON DATABASE neondb TO fred_app;
GRANT USAGE ON SCHEMA public TO fred_app;

-- Cannot create objects. Postgres 15+ already withholds CREATE on `public`
-- from PUBLIC; both revokes are belt and braces.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM fred_app;

-- ---------------------------------------------------------------------------
-- Data: full DML, nothing else
--
-- Fred does no DDL at runtime — migrations are `npm run db:push` from a
-- laptop, using the owner role. So the Worker never needs CREATE/ALTER/DROP.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fred_app;

-- serial / identity columns need the sequence to INSERT.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fred_app;

-- ---------------------------------------------------------------------------
-- Future tables — the step that is easy to forget
--
-- The grants above cover only objects that exist right now. Without this, the
-- next `db:push` that adds a table would create it invisible to fred_app and
-- the app would start failing with "permission denied" on a table it has
-- never seen. FOR ROLE names the role that will own new objects (the same
-- owner role running this script).
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fred_app;

ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fred_app;

-- ---------------------------------------------------------------------------
-- Self-check — run as part of the script, not a separate step. If your SQL
-- editor stops at the first error or only part of the script got pasted, the
-- CREATE ROLE/ALTER ROLE above can succeed while everything after it silently
-- doesn't — the role exists but can't touch a single table. That surfaces
-- later as every page failing to load, not as an error here, so check now:
-- expect 64. Zero means go back and run the statements above this one again.
-- ---------------------------------------------------------------------------
select count(*) as fred_app_table_grants
from information_schema.role_table_grants
where grantee = 'fred_app';
