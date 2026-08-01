-- Schema for the unified scope model (docs/HOUSEHOLD.md Phase 3).
--
-- Purely additive: new nullable columns, or NOT NULL with a default that
-- matches the previous behaviour. Nothing is dropped and nothing is rewritten,
-- so it is safe to run against a live database and safe to run twice. The two
-- superseded flags (accounts.include_in_net_worth, accounts.include_in_household)
-- are deliberately left in place — application code stops reading them, and
-- they stay as a fallback until the new model has proven itself.
--
-- Run as the database OWNER (the app role has no DDL rights, by design):
--   psql "$DATABASE_URL" -f scripts/sql/scope_model.sql
-- or via scripts/apply_sql.ts, which uses the same connection the app does.

-- Why an account is held out of net worth, or NULL when it counts.
-- Replaces the old include_in_net_worth/include_in_household pair, which
-- conflated ownership ("isn't Scott's") with deliberate exclusion.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS exclusion text;

-- Whether the monthly close asks for a statement here. Default true preserves
-- today's behaviour; the migration then turns it off for balance-only accounts.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS tracks_monthly_close boolean NOT NULL DEFAULT true;

-- Ties an account to the property ledger that supplies its value.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS property_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_property_id_properties_id_fk'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_property_id_properties_id_fk
      FOREIGN KEY (property_id) REFERENCES properties(id);
  END IF;
END $$;

-- Provider feed health. 'ok' as the default is the pre-existing assumption
-- made explicit; the next sync overwrites it with what the provider reports.
ALTER TABLE external_accounts
  ADD COLUMN IF NOT EXISTS connection_status text NOT NULL DEFAULT 'ok';
ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS disconnected_at date;

-- Self-check: every column above must now exist. A silently truncated session
-- (which has happened here before — see app_role.sql) shows up as a count
-- below 5 instead of appearing to succeed.
SELECT count(*) AS columns_present
FROM information_schema.columns
WHERE (table_name = 'accounts'
       AND column_name IN ('exclusion', 'tracks_monthly_close', 'property_id'))
   OR (table_name = 'external_accounts'
       AND column_name IN ('connection_status', 'disconnected_at'));
