-- Account lifecycle: archiving.
--
-- Additive and idempotent, like scripts/sql/scope_model.sql. Archiving itself
-- rides on the existing is_active flag (a closed account already contributes
-- $0 to every rollup); this only records *when*, so the roster can say
-- "closed Mar 2027" instead of silently greying a row out.
--
-- Run as the database OWNER:
--   node --env-file=.env npx tsx scripts/apply_sql.ts scripts/sql/account_lifecycle.sql

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived_at date;

-- Backfill: an account already marked inactive was archived at some point in
-- the past, and its last statement is the best evidence of when. Accounts with
-- no statements at all are left null rather than guessed at.
UPDATE accounts a
SET archived_at = sub.last_statement
FROM (
  SELECT account_id, max(statement_date) AS last_statement
  FROM account_entries
  GROUP BY account_id
) sub
WHERE a.id = sub.account_id
  AND a.is_active = false
  AND a.archived_at IS NULL;

-- Self-check: the column exists, and no active account claims an archive date.
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'accounts' AND column_name = 'archived_at') AS column_present,
  (SELECT count(*) FROM accounts WHERE is_active = true AND archived_at IS NOT NULL) AS contradictions,
  (SELECT count(*) FROM accounts WHERE is_active = false) AS archived_accounts;
