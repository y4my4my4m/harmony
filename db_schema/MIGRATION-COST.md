# What the pending migrations cost against rows

The 26 migrations from `20260816000001` to `20260818000013` are pending on production and
on staging. Everything below was measured by `scripts/time-migrations.sh`, which builds a
throwaway PostgreSQL 15.8 from `schema-prod.sql` and `schema-staging.sql`, seeds it, and
applies the files one at a time. No number here is an estimate.

Production and staging are at different schema versions, so the same file does different
work on each. Both columns are measured; a dash means the file found its object already in
place and did nothing.

## Read this first

Three migrations decide whether a deploy needs a window:

| | at 150k profiles / 150k posts | at 600k profiles / 600k posts |
|---|---|---|
| `20260816000012` blocks `ap_activities` (prod) | 11.1 s | 47.6 s |
| `20260816000011` blocks `posts` | 1.51 s | 5.97 s |
| `20260818000006` blocks `prekeys` (staging) | 0.26 s @100k prekeys | 0.93 s @400k prekeys |

Four more cross 60 ms of blocked writes at scale 4 without being windows: `20260818000005`
staging 389 ms, `20260817000002` prod 150 ms, `20260818000011` staging 103 ms,
`20260818000012` 50 ms. Read the table rather than this paragraph — classification is per
row *and per environment*, and several files are a no-op on one instance while doing real
work on the other.

The remainder hold a write-blocking lock for under 60 ms at both scales, or take no lock on
a user table at all.

## The table

Durations are server-side (`\timing`, summed over the file's statements), so they exclude
connection setup. **block ms** is how long the heaviest write-blocking lock stayed held,
from the first to the last 2 ms sample; `<2` means it was taken but never seen across two
samples. **stall ms** is the longest a concurrent writer waited, measured directly by a
session taking `ROW EXCLUSIVE` on seven tables in a loop.

s1 = 150k profiles / 500k messages / 150k posts. s4 = four times that. Full row counts below.

| migration | class | prod s1 ms | prod s4 ms | prod block ms | stg s1 ms | stg s4 ms | stg block ms | heaviest lock, on what | stall ms |
|---|---|---|---|---|---|---|---|---|---|
| 20260816000001 drop_invites_select_all_regression | BRIEF LOCK | 3 | 3 | <2 | 3 | 2 | – | ACCESS EXCLUSIVE `invites` | 0 |
| 20260816000002 reconcile_broadcast_functions | SAFE ONLINE | 10 | 10 | – | 10 | 14 | – | ROW EXCLUSIVE `pg_proc` | 0 |
| 20260816000003 reconcile_cleanup_dead_endpoint_users | SAFE ONLINE | 4 | 3 | – | 4 | 5 | – | ACCESS SHARE `pg_proc` | 0 |
| 20260816000004 reconcile_federation_trigger_toggles | SAFE ONLINE | 5 | 8 | – | 4 | 9 | – | ACCESS SHARE `pg_class` | 0 |
| 20260816000005 reconcile_group_participant_left | SAFE ONLINE | 4 | 4 | – | 3 | 4 | – | ACCESS SHARE `pg_proc` | 1 |
| 20260816000006 reconcile_notification_actor_json | SAFE ONLINE | 6 | 7 | – | 5 | 5 | – | ACCESS SHARE `pg_proc` | 0 |
| 20260816000007 reconcile_update_follow_counts | SAFE ONLINE | 4 | 4 | – | 3 | 4 | – | ACCESS SHARE `pg_proc` | 0 |
| 20260816000008 repin_search_path_stripped_functions | SAFE ONLINE | 4 | 4 | – | 4 | 4 | – | ROW EXCLUSIVE `pg_proc` | 0 |
| 20260816000009 restore_home_feed_broadcast_trigger | BRIEF LOCK | 5 | 7 | <2 | 7 | 6 | <2 | ACCESS EXCLUSIVE `timeline_entries` | 0 |
| 20260816000010 rls_initplan_optimisation | BRIEF LOCK | 30 | 18 | 26 → 15 | 16 | 13 | 13 → 10 | ACCESS EXCLUSIVE on 20 tables | 16 / 252 |
| 20260816000011 reblog_count_authoritative | **NEEDS A WINDOW** | 1520 | 5978 | 1513 → 5969 | 1295 | 5067 | 1287 → 5059 | ACCESS EXCLUSIVE `posts` (prod), SHARE ROW EXCLUSIVE `posts` (stg) | 1477 |
| 20260816000012 drop_legacy_and_unreachable | **NEEDS A WINDOW** | 11150 | 47611 | 11145 → 47606 | 11155 | 45654 | – | ACCESS EXCLUSIVE `ap_activities`, `follows` (prod only) | 1 |
| 20260817000001 drop_permissive_legacy_policies | BRIEF LOCK | 7 | 8 | 3 → 3 | 3 | 5 | – | ACCESS EXCLUSIVE `messages`, `profiles`, +4 | 7 |
| 20260817000002 profiles_auth_user_id_unique | **NEEDS A WINDOW** | 105 | 429 | 36 → 150 | 3 | 2 | – | ACCESS EXCLUSIVE `profiles` | 30 |
| 20260818000001 restore_functions_missing_from_production | SAFE ONLINE | 9 | 9 | – | 9 | 16 | – | ROW EXCLUSIVE `pg_description` | 0 |
| 20260818000002 restore_push_rpcs_and_close_anon_grants | SAFE ONLINE | 7 | 10 | – | 10 | 8 | – | ROW EXCLUSIVE `push_subscriptions` | 0 |
| 20260818000003 oauth_providers_secret_not_public | BRIEF LOCK | 2 | 1 | – | 3 | 5 | <2 | ACCESS EXCLUSIVE `oauth_providers` | 0 |
| 20260818000004 fix_functions_that_raise_on_every_call | SAFE ONLINE | 4 | 6 | – | 5 | 200 | – | ACCESS SHARE `pg_class` | 0 |
| 20260818000005 federated_voice_calls_production_shape | **NEEDS A WINDOW** (stg) | 14 | 11 | 5 → 2 | 31 | 397 | 27 → 389 | ACCESS EXCLUSIVE `federated_voice_calls` | 60 / 63 |
| 20260818000006 prekey_and_encryption_column_gaps | **NEEDS A WINDOW** (stg) | 14 | 14 | 9 → 10 | 265 | 934 | 261 → 930 | ACCESS EXCLUSIVE `prekeys` +9 | 39 |
| 20260818000007 close_always_true_insert_policies | BRIEF LOCK | 4 | 5 | <2 → 3 | 5 | 10 | <2 → 6 | ACCESS EXCLUSIVE `federated_voice_calls` | 183 |
| 20260818000008 columns_the_application_reads | BRIEF LOCK | 11 | 14 | 8 → 10 | 25 | 18 | 22 → 15 | ACCESS EXCLUSIVE `server_roles` +4 | 14 |
| 20260818000009 functions_that_cannot_run | SAFE ONLINE | 5 | 12 | – | 6 | 15 | – | ACCESS SHARE `pg_class` | 0 |
| 20260818000011 messages_bot_id_foreign_key | **NEEDS A WINDOW** (stg) | 2 | 2 | – | 59 | 278 | 9 → 103 | SHARE ROW EXCLUSIVE `messages`, `bots` | 9 |
| 20260818000012 bot_tokens_liveness_columns | **NEEDS A WINDOW** | 18 | 54 | 14 → 50 | 12 | 47 | 3 → 44 | ACCESS EXCLUSIVE `bot_tokens` | 21 |
| 20260818000013 name_pg_temp_in_every_search_path | SAFE ONLINE | 15 | 19 | – | 14 | 17 | – | ROW EXCLUSIVE `pg_proc` | 0 |

`x → y` in a block column is the s1 value then the s4 value; a single value did not change
with scale. Stall is from the s1 loaded pass, prod / staging where they differ. The 200 ms
in `20260818000004` at staging s4 is not row work: that file's `DELETE`s land on
`performance_metrics` and `slow_queries`, which the seed leaves empty. Its lock does not
reach a user table at any scale.

The classes:

- **SAFE ONLINE** — takes nothing heavier than `ROW EXCLUSIVE` on a user table. Function
  bodies, grants and comments live in `pg_proc`, `pg_description` and `pg_shdepend`; none
  of those locks makes an application query wait.
- **BRIEF LOCK** — takes a write-blocking mode, holds it under 60 ms at both scales, and
  the hold does not grow with rows. `DROP POLICY`, `ALTER POLICY` and `ADD COLUMN` with a
  constant default are catalog edits: their cost is the number of statements, not the
  number of rows.
- **NEEDS A WINDOW** — the write-blocking hold grows with rows. The per-million figures and
  the row count at which each crosses one second are below.

## Nothing here rewrites a table

`relfilenode` was captured for every table in `public` before and after each migration.
Across all 26 files and both environments exactly one changed: `federated_voice_calls` on
staging, where `20260818000005` renames the pre-federation table aside and creates a new
one. That is a replacement, not a rewrite; the old heap keeps its filenode under
`federated_voice_calls_legacy`.

No `ADD COLUMN` in the set carries a volatile default, and there is no `ALTER TYPE`. In
PostgreSQL 11 and later a constant default is stored in `pg_attribute.attmissingval` and
existing rows are not touched, which is why the eight columns of `20260818000008` block
writes for 8–22 ms against 200k–800k `user_servers` rows.

The three files whose UPDATEs do write rows grow their table, measured at s1 / s4:

| migration | table | s1 growth | s4 growth |
|---|---|---|---|
| 20260816000012 | `profiles` | 64.9 MB | 264.9 MB |
| 20260816000011 | `posts` | 5.0 MB | 19.9 MB |
| 20260818000006 | `prekeys` (staging) | 3.9 MB | 15.8 MB |

Every other migration ended with the heap byte-for-byte the size it started.

`20260818000012` is in that list on neither side, and the reason is worth knowing:

```sql
ALTER TABLE public.bot_tokens ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
UPDATE public.bot_tokens SET is_active = (revoked_at IS NULL) WHERE is_active IS NULL;
```

`ADD COLUMN ... DEFAULT true` makes every existing row read `true`, so `WHERE is_active IS
NULL` matches nothing. Verified directly: after that `ALTER` on 100k rows, `count(*) FILTER
(WHERE is_active IS NULL)` is 0. The migration's whole cost is two sequential scans of
`bot_tokens` that update no row, taken while `ACCESS EXCLUSIVE` is held from the first
`ALTER` to `COMMIT` — 50 ms at 200k tokens.

## Projections

Every write-blocking hold that grows does so linearly in the rows of one table. Slope is
`(s4 block − s1 block) / (s4 rows − s1 rows)`, and "crosses 1 s" is the fitted line
`y = mx + b` solved for y = 1000 ms — not the slope applied through the origin, which is
optimistic wherever the intercept is negative.

> **`20260816000012` has since been split and its window removed.** Every figure below for
> that migration was measured with the four follow-counter UPDATEs inside the DDL
> transaction, where they inherited `ACCESS EXCLUSIVE` on `follows` and `ap_activities` for
> their whole duration. The backfill now runs after `COMMIT`, in its own transaction, taking
> only `ROW EXCLUSIVE` on `profiles` — measured at a 1 ms stall for a concurrent writer. The
> 47.6 s figure is what the file used to cost; re-run `scripts/time-migrations.sh` to
> confirm the current one. The row is kept because the *total* wall time is unchanged, and
> an operator should still expect the migration itself to take that long.

| migration | grows with | per million rows | crosses 1 s at |
|---|---|---|---|
| 20260816000012 | `profiles`, at 2 accepted follows each | **81 s** | 25k profiles |
| 20260816000011 | `posts` | **9.9 s** (prod), 8.4 s (staging) | 100k posts |
| 20260818000006 | `prekeys` | **2.2 s** | 450k prekeys |
| 20260818000005 | `federated_voice_calls` | **1.2 s** | 830k calls |
| 20260818000011 | `messages` | **63 ms** (1.25 s per million carrying a `bot_id`) | 16M messages |
| 20260818000012 | `bot_tokens` | **240 ms** | 4.2M tokens |
| 20260817000002 | `profiles` | **253 ms** blocking; 720 ms total | 4.0M profiles |

Two of those need reading with their shape in mind.

`20260816000012` is not slow because of what it drops. 94 `DROP FUNCTION`s and two `DROP
TABLE`s take milliseconds. The 47.6 s is four `UPDATE public.profiles` statements
recomputing `followers_count` and `following_count` from `follows`. Timed on their own,
outside any other statement, the two aggregating ones are 24.1 s and 23.7 s at 600k
profiles / 1.2M follows, which is the whole of the migration's 47.6 s. They hold only `ROW EXCLUSIVE`, which blocks no other writer — the
concurrent writer stalled 1 ms during them. The damage comes from the `DROP TRIGGER
... ON public.ap_activities` at the top of the same transaction: that takes `ACCESS
EXCLUSIVE` on `ap_activities` and holds it for all 47.6 s, so `ap_activities` is closed to
readers and writers for the length of the backfill.

`20260818000011` scales with `messages` only weakly because `idx_messages_bot_id` is
`btree (bot_id) WHERE bot_id IS NOT NULL`. Both the migration's orphan check and
PostgreSQL's own constraint validation can use it, so the work is proportional to the
messages that carry a `bot_id`, not to the table. The seed puts 5% of messages on a bot;
an instance with a different bot share scales from the per-million-bot-message figure.

`20260817000002` and `20260818000012` are listed as NEEDS A WINDOW because their hold
grows, but at any plausible size of this instance they are tens of milliseconds. Both cross
one second only past four million rows.

## The online rewrites

Measured at s4 — 600k profiles, 2M messages of which 100k carry a `bot_id`, 400k prekeys —
on the same database, each pair starting from the same schema.

**`20260817000002`, the unique constraint on `profiles.auth_user_id`.**

```sql
-- what the migration runs: 137 ms, writers blocked 133 ms
ALTER TABLE public.profiles ADD CONSTRAINT profiles_auth_user_id_key UNIQUE (auth_user_id);

-- online: 197 ms + 1 ms, writers blocked under 2 ms
CREATE UNIQUE INDEX CONCURRENTLY profiles_auth_user_id_key ON public.profiles (auth_user_id);
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_auth_user_id_key UNIQUE USING INDEX profiles_auth_user_id_key;
```

`CREATE INDEX CONCURRENTLY` takes `SHARE UPDATE EXCLUSIVE`, which conflicts with nothing a
writer takes; the attach is a catalog edit. Total wall time goes up by 44%, blocked writes
go to zero. Neither statement may run inside a transaction block, so this runs before the
migration; the migration's `DO` block then finds the constraint present and returns.

**`20260818000011`, the foreign key on `messages.bot_id`.**

```sql
-- what the migration runs: 194 ms, writers blocked 192 ms
ALTER TABLE public.messages ADD CONSTRAINT messages_bot_id_fkey
    FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;

-- online: 11 ms + 55 ms, writers blocked 6 ms
ALTER TABLE public.messages ADD CONSTRAINT messages_bot_id_fkey
    FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_bot_id_fkey;
```

`NOT VALID` skips the scan and takes `SHARE ROW EXCLUSIVE` for 11 ms. `VALIDATE CONSTRAINT`
does the scan under `SHARE UPDATE EXCLUSIVE`, which does not block writers. The constraint
is enforced on new rows from the first statement onward.

**`20260818000006`, the ten indexes.** Each is a plain `CREATE INDEX IF NOT EXISTS` inside
the migration's transaction, taking `SHARE` on its table, which blocks writes. Measured on
the largest of them:

```sql
-- what the migration runs: 52 ms, writers blocked 48 ms (SHARE on prekeys)
CREATE INDEX idx_prekeys_used_by ON public.prekeys(used_by);

-- online: 69 ms, no lock that blocks a writer (SHARE UPDATE EXCLUSIVE)
CREATE INDEX CONCURRENTLY idx_prekeys_used_by ON public.prekeys(used_by);
```

The other nine are on tables this seed leaves empty, so their measured cost is the
statement overhead alone. Building them concurrently beforehand makes the migration's
`IF NOT EXISTS` a no-op.

**`20260816000012` and `20260816000011`, the backfills.** No `CONCURRENTLY` form exists for
an `UPDATE`. What removes the window is taking the backfill out of the migration's
transaction, so no `DROP TRIGGER` or `CREATE TRIGGER` holds a table lock across it. Run
before the migration:

```sql
-- 24.1 s and 23.7 s at 600k profiles / 1.2M follows; ROW EXCLUSIVE only,
-- concurrent writer stalled 1 ms
UPDATE public.profiles p SET followers_count = c.n
  FROM (SELECT following_id AS id, count(*) AS n
          FROM public.follows WHERE status = 'accepted' GROUP BY 1) c
 WHERE p.id = c.id AND p.followers_count IS DISTINCT FROM c.n;
UPDATE public.profiles p SET following_count = c.n
  FROM (SELECT follower_id AS id, count(*) AS n
          FROM public.follows WHERE status = 'accepted' GROUP BY 1) c
 WHERE p.id = c.id AND p.following_count IS DISTINCT FROM c.n;
```

The migration then re-runs them against corrected counters, where `IS DISTINCT FROM`
matches nothing and the statements are a scan. The same applies to the two `UPDATE
public.posts` statements in `20260816000011`, whose 1.5–6.0 s is spent under a lock the
`CREATE TRIGGER` in the same file took on `posts`.

## The scale this was measured at

`--scale` multiplies a fixed row profile. The default, scale 1, is a medium instance:

| table | scale 1 | scale 4 |
|---|---|---|
| `profiles` (and `auth.users`) | 150,000 | 600,000 |
| `messages` | 500,000 | 2,000,000 |
| `posts` | 150,000 | 600,000 |
| `post_interactions` | 300,000 | 1,200,000 |
| `follows` | 300,000 | 1,200,000 |
| `user_servers` | 200,000 | 800,000 |
| `federated_voice_calls` | 100,000 | 400,000 |
| `prekeys` | 100,000 | 400,000 |
| `bot_tokens` | 50,000 | 200,000 |
| `servers` / `channels` / `bots` / `conversations` | 200 / 2,000 / 200 / 5,000 | unchanged |

Shape, not just size, decides two of the numbers, so the seed fixes it explicitly:

- one profile in five is remote and carries a NULL `auth_user_id`, the case a UNIQUE
  constraint has to keep permitting;
- one message in twenty carries a `bot_id` instead of a `user_id`, which is the row set
  `messages_bot_id_fkey` validates;
- one post in seven is a reblog, and `reblogs_count` is wrong on every reblog target plus
  5% of the rest, so `20260816000011` has work to do;
- `followers_count` and `following_count` hold exactly twice the truth on every profile
  that has a follower, which is the state `20260816000012` exists to repair. Both backfills
  cost what they cost because of how many rows are wrong; an instance whose counters are
  already close pays less.

Foreign keys and CHECK constraints are enforced during the seed. Row triggers are disabled
for the load only — `DISABLE TRIGGER USER` leaves internally generated constraint triggers
on — and re-enabled before any migration runs, so trigger cost during a migration is real.
The seed ends with `VACUUM (FULL, ANALYZE)`: without it the seed's own counter updates
leave free space exactly where the backfills will write, and the growth column reads zero.

Host: 32 cores, NVMe, `supabase/postgres:15.8.1.085` (PostgreSQL 15.8, the version both
dumps were taken from), `shared_buffers=1GB`, `work_mem=64MB`,
`maintenance_work_mem=512MB`, `max_wal_size=8GB`, `fsync` on. A production instance with
less `maintenance_work_mem` will build indexes more slowly than the figures above.

## Method

- **Duration** is the sum of psql's `\timing` lines over the file, so it is server-side and
  excludes the ~40 ms of connection setup that a `docker exec` adds. Wall clock is recorded
  alongside it in the TSVs.
- **Lock mode and table** come from two sources, and the TSV names which one per row. A
  `ddl_command_end` event trigger reads `pg_locks` for its own backend at the end of every
  DDL statement, where all locks the statement took are still held — exact, not sampled. A
  second session polls `pg_locks` filtered to the migration's pid every 2 ms, which covers
  the statements that are not DDL. `block ms` is first-to-last sample of the heaviest
  write-blocking mode, so it is sampled and rounds down; a lock held for less than one
  interval reads as `<2`.
- **Rewrite** is `pg_class.relfilenode` before and after, per table. Growth is
  `pg_relation_size` over the same pair.
- **Writer stall** is a session per table running `LOCK TABLE ... IN ROW EXCLUSIVE MODE`
  and committing in a loop. That is the mode every `INSERT`, `UPDATE` and `DELETE` takes
  and nothing else — no triggers fire, no rows are written — so the longest wait to acquire
  it is the length of the window in which writes to that table would have failed to
  proceed. Seven tables are probed: `profiles`, `messages`, `posts`, `post_interactions`,
  `bot_tokens`, `user_servers`, `federated_voice_calls`. A migration whose lock falls on
  another table shows no stall; `20260816000012` is the case to watch for, since its
  `ACCESS EXCLUSIVE` lands on `ap_activities`.
- The loaded pass costs the migration time it does not spend when idle: every `ACCESS
  EXCLUSIVE` request queues behind the probe's in-flight lock. `20260816000010` on staging is 16 ms
  quiet and 258 ms with a writer on seven tables. Both are measured; the quiet figure is
  the migration's own cost and the loaded one is what it becomes when it has to wait its
  turn.

## Re-measuring at another scale

```bash
scripts/time-migrations.sh --scale 1                        # both dumps, both passes
scripts/time-migrations.sh --scale 10 --variant prod --passes quiet
scripts/time-migrations.sh --scale 4 --passes alt           # the online rewrites
scripts/time-migrations.sh --render /tmp/migration-cost     # TSVs -> markdown
```

Output goes to `$TMPDIR/migration-cost` unless `--out` says otherwise, one TSV per variant
and pass, each named with the scale it was taken at. `--keep` leaves the container up.
`PROD_DUMP` and `STAGING_DUMP` override the dump paths; the defaults are `~/temp`.

To find the figure for a real instance, take its row count for the table in the projection
table above and multiply by the per-million figure. To check that projection rather than
trust it, run at two scales that bracket the instance and confirm the slope. The script
never connects to anything but the container it starts.
