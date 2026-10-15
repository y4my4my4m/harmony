---
title: Database migrations
description: How Harmony's schema changes - migration files and versions, how instances apply them, grants for new functions and tables, the schema inventories, and the checks CI runs.
---

# Database migrations

This page is for contributors who change the database schema: tables, policies, functions or triggers. It covers where migrations live, how instances apply them, how to write one, and the generated inventories and checks that every schema change goes through. [Architecture](/contribute/architecture#database-design) explains why the database carries so much of the logic.

## Where migrations live

Every schema change is a SQL file in [`db_schema/migrations/`](https://github.com/y4my4my4m/harmony/tree/master/db_schema/migrations). `supabase/migrations` is a symbolic link to that directory, so the Supabase CLI reads the same files.

- `20260101000000_baseline.sql` creates the whole schema: every table, function, policy and trigger as of the baseline.
- Every later file is a change on top of it, applied in version order.

A file is named `<version>_<name>.sql`. The version is 14 digits, `YYYYMMDDNNNNNN`: the date, then a six-digit counter that orders files of the same day (for example `20261013800001_owned_bot_servers.sql`). The version must be unique across the directory, because it is the primary key of the ledger below.

## How instances apply migrations

[`self-host/bootstrap.sh`](https://github.com/y4my4my4m/harmony/blob/master/self-host/bootstrap.sh) applies migrations on a new install, on every `harmony update` (through `update.sh`, which runs `bootstrap.sh --migrations-only`), and on a development database. For each file in version order, it:

1. takes the first 14 characters of the file name as the version;
2. skips the file when `supabase_migrations.schema_migrations` already records that version;
3. runs the file with `ON_ERROR_STOP`, then records the version and name.

When a file fails, it is not recorded, the files after it are skipped, and the run stops. The database is left at the last migration that succeeded. After the loop, `bootstrap.sh` reloads PostgREST's schema cache.

The ledger is the table the Supabase CLI uses, so the CLI can read and continue an instance installed this way:

```bash
npx supabase@2.83.0 migration list   --db-url "$DATABASE_URL"
npx supabase@2.83.0 db push --dry-run --db-url "$DATABASE_URL"
```

### The ledger has no checksum

The ledger records versions only, not file contents. Editing a migration that an instance has already recorded changes nothing on that instance: it never runs the file again. Only databases installed after the edit see it.

- To change something that has shipped, write a new migration with a new version. Edit an existing file only while it is unmerged.
- The baseline is recorded on every existing instance, so an edit to `20260101000000_baseline.sql` reaches fresh installs only.
- Live instances can differ from a fresh install, from changes made before the baseline existed. A migration that converges an object should state the whole target definition (`CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS` then `CREATE POLICY`, explicit `GRANT` and `REVOKE`) rather than assume the previous one. The `*_convergence.sql` migrations follow this pattern.

## Write a migration

1. **Pick the version.** Use today's date and a counter that sorts after every migration already on `master`. Another open branch can claim the same version; check open pull requests before you pick one.
2. **Write the file** in `db_schema/migrations/`. Start with a comment that says what the migration changes and why. Most migrations wrap their statements in a transaction with a lock timeout: a statement that cannot take its lock within that time fails the migration instead of holding up the writers queued behind it.

   ```sql
   -- Servers each of the caller's bots is installed in, for the My bots list.

   BEGIN;

   SET LOCAL lock_timeout = '3s';

   -- statements

   COMMIT;

   NOTIFY pgrst, 'reload schema';
   ```

3. **Grant access explicitly** (next section).
4. **Add a pgTAP test** in `db_schema/tests/` and run `./scripts/run-db-tests.sh`. See [Testing](/contribute/testing#database-tests-pgtap).
5. **Apply it to your development database** with `bash self-host/bootstrap.sh --migrations-only`.
6. **Regenerate the inventories** and run the checks (below), then commit the regenerated files with the migration.

## Grant access to new functions and tables

Supabase's default privileges grant `EXECUTE` on every new function in `public` to `anon` and `authenticated`. Without a `REVOKE`, a new function is callable over HTTP with the anon key the moment it exists. Default privileges for tables are not present on every instance, so a new table also needs explicit grants or it is closed to the API roles there.

A function clients call, from `20261013800001_owned_bot_servers.sql`:

```sql
CREATE OR REPLACE FUNCTION public.get_owned_bot_servers()
RETURNS TABLE (bot_id uuid, server_id uuid, server_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT b.id, s.id, s.name
      FROM public.bots b
      JOIN public.bot_server_permissions p
        ON p.bot_id = b.id AND p.is_active
      JOIN public.servers s
        ON s.id = p.server_id
     WHERE b.owner_id = (SELECT public.get_current_profile_id())
     ORDER BY b.id, lower(s.name), s.id;
$$;

REVOKE ALL ON FUNCTION public.get_owned_bot_servers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_owned_bot_servers() TO authenticated;
```

A function only triggers or the backend call, from `20261013100001_user_emojis.sql`:

```sql
REVOKE ALL ON FUNCTION public.record_ai_emoji_generation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_emoji_generation() TO service_role;
```

A table only the backend uses, from the same migration:

```sql
ALTER TABLE public.ai_emoji_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_emoji_generations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ai_emoji_generations TO service_role;

DROP POLICY IF EXISTS ai_emoji_generations_service_role ON public.ai_emoji_generations;
CREATE POLICY ai_emoji_generations_service_role ON public.ai_emoji_generations
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
```

Give `authenticated` only the table privileges its policies are written for. A `SECURITY DEFINER` function bypasses row level security, so it sets `search_path` and checks the caller itself, typically through `public.get_current_profile_id()`.

## Schema inventories

Files in `db_schema/` describe what a fresh install exposes. `SURFACE.tsv` and `REACHABILITY.tsv` are generated from a throwaway database loaded with every migration, and CI fails when a committed file differs from a fresh run. Adding or removing an endpoint is therefore a visible, reviewed change.

| File | Regenerate with | Contents |
| --- | --- | --- |
| `SURFACE.tsv` | `./scripts/generate-surface.sh` | Every function PostgREST publishes: arguments, return type, `definer` or `invoker`, `search_path`, grants, how it is reached |
| `REACHABILITY.tsv` | `./scripts/generate-reachability.sh` | How execution enters each function: RPC call site, trigger, policy, view, default, cron job or another function |
| `PUBLISHED-NO-CALLER.tsv` | `./scripts/check-published-no-caller.sh --write` | The reviewed list of published functions that nothing in the repository reaches |
| `EXPECTED-PLPGSQL-ERRORS.tsv` | Edited by hand | `plpgsql_check` errors that are environmental, not defects, with the reason |

The two generators need Docker and Python 3; `check-published-no-caller.sh` reads `REACHABILITY.tsv`, so run it after `generate-reachability.sh`. Run both generators after any migration that adds, drops or changes a function, a trigger or a policy, and after code that adds or removes an `.rpc()` call.

## Checks

The Database workflow ([`.github/workflows/schema-drift.yml`](https://github.com/y4my4my4m/harmony/blob/master/.github/workflows/schema-drift.yml)) runs on every pull request, with no path filter, because some checks read the application code. Each job can run locally:

| Job | Command | Fails when |
| --- | --- | --- |
| `surface` | `./scripts/generate-surface.sh` | `SURFACE.tsv` differs from a fresh run |
| `reachability` | `./scripts/generate-reachability.sh` | `REACHABILITY.tsv` differs from a fresh run |
| `rpc-coverage` | `./scripts/check-rpc-coverage.sh` | A function called with `.rpc('name')` in `src/`, `federation-backend/src/` or `bot-gateway/src/` does not exist in the schema |
| `schema-usage` | `./scripts/check-schema-usage.sh` | A table or column reached through `.from('table')` in that code does not exist |
| `plpgsql` | `./scripts/check-plpgsql.sh` | `plpgsql_check` finds a function body that would fail when called, such as a reference to a missing column |
| `fresh-install` | `./scripts/check-fresh-install.sh` | `self-host/bootstrap.sh` cannot install an empty database to the latest migration, or a second run applies anything |
| `pgtap` | `./scripts/run-db-tests.sh` | A pgTAP file fails |
| `published-no-caller` | `./scripts/check-published-no-caller.sh` (after `generate-reachability.sh`) | The set of published functions with no caller changed |
| `upsert-conflicts` | `./scripts/check-upsert-conflicts.py` | An upsert's `onConflict` target has no matching unique index, which Postgres reports only at runtime |
| `db-verdict` | | Any job above did not succeed |

PL/pgSQL resolves column and table references when a statement first runs, not when the function is created, so a broken body installs cleanly. `check-plpgsql.sh` is the check that catches it before a user does.

`check-rpc-coverage.sh --dump FILE` and `check-schema-usage.sh --dump FILE` ask the same questions of a `pg_dump` of a live instance. CI has no such dump; operators run them before and after converging an instance.

## Record migrations without running them

[`scripts/baseline-migrations.sh`](https://github.com/y4my4my4m/harmony/blob/master/scripts/baseline-migrations.sh) writes versions into the ledger without running the files. It is for a database whose schema already matches the files, such as an instance whose migrations were applied by hand; without it, the first `bootstrap.sh` run would replay everything.

```bash
scripts/baseline-migrations.sh --docker supabase-db --dry-run
scripts/baseline-migrations.sh --docker supabase-db --through 20260809000001
scripts/baseline-migrations.sh --url "$DATABASE_URL"
```

`--through` records up to and including one version and leaves the rest for `bootstrap.sh` to apply. `--dry-run` prints what it would record. `--user`, `--db` and `--password` set the connection for `--docker`.

[`scripts/time-migrations.sh`](https://github.com/y4my4my4m/harmony/blob/master/scripts/time-migrations.sh) measures pending migrations against seeded copies built from schema-only dumps: duration, the locks each one takes and how long writers wait.
