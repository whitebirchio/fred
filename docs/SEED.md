# Seeding: a one-time bootstrap, not a data source

Fred's history came from three Google-Sheets workbooks. That import is a
**one-time bootstrap**. Once a database is seeded, Fred owns the data and the
monthly close is what adds to it. The workbooks are the *old* system; nothing
in the running app reads them, references them, or expects them to exist.

This matters because the workbooks will be retired. Anything that quietly
depended on them would break the day they go away — so nothing does.

## The two sources, going forward

| Source | What it is | Who writes it |
|---|---|---|
| **Fred** (`fred`) | The month-end record: balances, flows, growth, tax character | The monthly close, in the app |
| **Monarch** (`monarch`) | Live daily balances, transactions, holdings | Sync, from the provider |

The workbooks are not a third source. They were the origin of Fred's first
1,687 entries and nothing more. In the UI these read as `Ⓕ Fred` and
`Ⓜ Monarch`; see [HOUSEHOLD.md](HOUSEHOLD.md) for how the two are resolved when
they disagree.

## The pipeline

```
Finances (new).xlsx  ─┐
Pay Stubs.xlsx       ─┼─►  scripts/extract_seed.py  ─►  data/seed/*.json  ─►  npm run db:seed  ─►  database
13 Charron Cir.xlsx  ─┘         (run once, locally)         (committed)              │
                                                                                     └─►  monthly close from here on
```

The committed JSON is the durable artifact — the boundary where the workbooks
stop mattering. `extract_seed.py` needs the `.xlsx` files and `openpyxl`;
`db:seed` needs neither, only the JSON. That is what makes the seed work on a
fresh machine, in CI, or against production long after the workbooks are gone.

`data/seed/` holds real financial data. The repo is expected to stay private.

## Seeding a real (production) database

`db:seed` writes wherever `DATABASE_URL` points — Neon in production, embedded
PGlite when unset. Both `db:push` and `db:seed` load `.env` automatically.

```bash
# .env contains DATABASE_URL=postgres://…  (the pooled Neon string)
npm run db:push      # create the schema
npm run db:seed      # bootstrap it
```

The seed prints its target host before writing anything, so a mistargeted run
is visible before it does damage:

```
Target: Postgres at ep-xyz-123.us-east-2.aws.neon.tech/fred (DATABASE_URL)
Source: data/seed/*.json
```

Sanity check after seeding: net worth on `/` should read **$2,403,754.02**, the
figure the source workbook closed at.

## The guard

Re-running the seed would delete every monthly close entered since. So a
non-empty database is **refused**:

```
This database already has data:
  persons 2 · accounts 22 · account_entries 1,687 · properties 1 · …

Refusing to overwrite. The seed is a one-time bootstrap — re-running it
would delete every monthly close entered since.

  To reset this database anyway:  npm run db:seed -- --force
```

`--force` does a full reset. It first clears `external_accounts.linked_account_id`,
because that foreign key has no `ON DELETE` rule: without the unlink, the wipe
deletes `account_entries`, then fails on `accounts`, leaving a half-destroyed
database. Synced provider records are unlinked rather than deleted, so Monarch's
data survives and those accounts return to the review queue on `/household`.
