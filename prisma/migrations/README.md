# Migrations

This project previously used `prisma db push`, which applies schema changes without
recording them. That is unsafe for what comes next: renaming a Prisma model without an
`@@map` makes `db push` **drop the underlying table**, and with `--accept-data-loss` it
does so without prompting. `StockReconciliation` holds ~148k audit rows.

`0_init` is the baseline: the full current schema, generated from `schema.prisma`.

## Baselining an existing database (do this once, per environment)

An existing database already has these tables, so the baseline must be **recorded as
applied, not executed**. Check for drift first — this repo's history means the physical
schema may not match `schema.prisma`.

```bash
# 1. Back up first. Non-negotiable.
cp prisma/dev.db "prisma/dev.db.pre-baseline-$(date +%Y%m%d%H%M).bak"

# 2. Stop the cron so nothing writes mid-migration (SQLite is single-writer).

# 3. What differs between the live database and schema.prisma?
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

**If that prints nothing** — no drift. Record the baseline and you are done:

```bash
npx prisma migrate resolve --applied 0_init
```

**If it prints SQL** — the database is behind `schema.prisma`. Read the SQL before
running anything. Prisma redefines a SQLite table by creating `new_<Table>`, copying
rows with `INSERT ... SELECT`, dropping the original and renaming — so a `DROP TABLE`
in that block is expected and does not lose data. A `DROP TABLE` **outside** such a
block does.

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --script > /tmp/drift.sql
# review /tmp/drift.sql, then:
sqlite3 "${DATABASE_URL#file:}" < /tmp/drift.sql
```

> **Then mark *every* migration as applied, not just `0_init`.**
>
> The diff is taken against the current `schema.prisma`, so the drift SQL brings the
> database all the way to the present state — including whatever later migrations
> already add. Marking only `0_init` leaves the rest pending, and the next
> `migrate deploy` fails with `table ... already exists` and blocks all further
> migrations until you run `migrate resolve` by hand.

```bash
for dir in prisma/migrations/*/; do
  npx prisma migrate resolve --applied "$(basename "$dir")"
done
npx prisma migrate status   # should report no pending migrations
```

### Known drift in `dev.db.before-audit-20260804.bak`

That backup predates two schema changes, so it is not a like-for-like production
replica:

- `SyncRunLock` table absent entirely — `syncLockService` would fail against it
- `ProductMetricSnapshot` missing `views`, `visitors`, `addToCartUnits`,
  `confirmedUnits`, `confirmedBuyers`

Production is presumably ahead of this backup (syncs succeed there, and they require
`SyncRunLock`), but that has not been verified against the live database.

## Regenerate the client after every schema change

`generator client` in `schema.prisma` writes to `node_modules/.prisma/client-active`,
a non-standard path. Nothing regenerates it automatically, so a client built before a
model existed will report that model as `undefined` at runtime.

```bash
npx prisma generate
```

Run this after pulling any change to `schema.prisma`, and after applying migrations.

## From here on

Use `npm run prisma:migrate:deploy`. Do not use `db push` on any database holding data.

```bash
npx prisma migrate dev --name describe_the_change   # development
npm run prisma:migrate:deploy                       # production
npx prisma generate                                 # always, after either
```
