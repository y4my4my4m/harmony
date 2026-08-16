# Database refactor — working memo

Internal notes for the schema refactor. Not user documentation; self-hosting
guides live in `docs/`.

Every number here was measured, not estimated. Method is recorded so results
can be reproduced or refuted.

## Why

`public` currently means three different things at once: the client-facing API,
internal helpers, and dead code. Nothing distinguishes them, so the only way to
learn what is real is to query production.

Measured against prod on 2026-08-09:

| | count |
|---|---|
| functions in `public` | 448 |
| `SECURITY DEFINER` (bypass RLS) | 289 |
| called by any client in any local repo | 138 |
| exposed as PostgREST RPC, never called | 310 |

PostgREST publishes every `public` function as an HTTP endpoint, so the third
row is reachable with an anon key.

## Environment survey

Prod and staging both run PostgreSQL 15.8.

| | functions | not in repo | missing vs repo |
|---|---|---|---|
| staging | 342 | 0 | 2 |
| prod | 446 | 113 | 11 |

Staging matches the repo and is the honest baseline. Prod carries 113 functions
that exist in no migration or init file, plus 23 extra triggers and ~213 extra
indexes.

Reachability from real entry points — RPC names across all local repos, trigger
bindings, RLS predicates, cron/view/defaults, then breadth-first through call
bodies:

- 307 of 446 prod functions reachable
- of the 113 untracked: **38 live**, **75 unreachable**
- a further **64 repo-defined functions** are unreachable

Dead list: `/home/y4my4m/temp/dead-functions.txt`.

Static reachability is sound here: the prod schema contains exactly one
`EXECUTE format(...)` site and it interpolates a column name, not a function, so
nothing is dispatched by computed name.

Not yet checked: whether `federation-backend` calls RPCs directly. It is not
among the local checkouts and ActivityPub names dominate the dead list. Confirm
before dropping anything.

## init.sql was not building a working schema

`psql -f init.sql` produced **149 errors** on a clean `supabase/postgres:15.8`
and still exited 0, because `ON_ERROR_STOP` was never set. A partial schema read
as a successful install.

Root cause, 85% of the errors: `03_tables_social.sql` declared
`emoji_id uuid REFERENCES public.emojis(id)` while `public.emojis` is created in
`04_tables_servers.sql`, one file later. `post_interactions` therefore never
existed, taking `user_bookmarks` and ~120 dependent triggers, policies and views
with it. No migration created them either, so every fresh instance was missing
favourites, reblogs, bookmarks and emoji reactions.

The table had already been relocated once for this same class of bug — the
comment at `04_tables_servers.sql` reads "moved here from 06_tables_misc.sql -
reactions FK depends on it" — just not far enough. The constraint is now
deferred to an `ALTER TABLE` after `emojis` exists.

Second bug: `99_cron_jobs.sql` opened `DO $$` and used `$$...$$` for an inner
cron command string, terminating the block early. The `cleanup-cron-job-run-details`
and `purge-stale-invites` jobs were never scheduled on a fresh install.
`migrations/20260407_cleanup_cron_job_run_details.sql` already carried the fix
and a comment explaining the trap; `init/` never received it. Duplication in one
file.

Current state: **0 errors**, exit 0, `ON_ERROR_STOP` on. A fresh build yields
116 tables, 337 functions, 255 policies, 140 triggers. Verified by injecting a
bad type reference: exit 3.

Of 233 migrations replayed on top, 227 apply cleanly. The 6 that fail assume a
pre-init state (`policy already exists` and similar) and are redundant against a
fresh baseline.

## Test harness notes

`supabase/postgres` ships `storage.buckets` with only
`(id, name, owner, created_at, updated_at)`. The remaining columns come from
storage-api's own migrations at service start, which a bare Postgres container
never runs, so `97_storage_buckets.sql` fails on every bucket insert.
`scripts/test-db/storage-compat.sql` adds them. The file is **not** a schema fix;
it exists only so a container matches a deployed instance.

pgTAP, verified working including a deliberately failing negative control:

- install into a dedicated schema, never `public` — it adds 1074 functions and
  would bury any `pg_dump --schema=public` diff
- `SET LOCAL search_path = tests, public` — pgTAP calls its own internals
  unqualified
- `GRANT USAGE ON SCHEMA tests TO authenticated` — the functions are invisible to
  that role otherwise
- `docker exec` needs `-i` for heredocs, or it discards stdin and the run looks
  like a silent pass

User impersonation, which makes RLS assertions expressible:

```sql
SELECT set_config('request.jwt.claims', json_build_object('sub', <auth_user_id>)::text, true);
SET LOCAL ROLE authenticated;
```

Note `auth.uid()` reads `request.jwt.claims`, and profiles join on
`auth_user_id`, not `user_id`.

## Plan

1. `init.sql` clean under `ON_ERROR_STOP` — **done**
2. Baseline generated from staging; migration runner with a tracking table
3. CI gates: schema drift (`migra`), RPC surface manifest, reachability
4. Drop the 75 + 64 dead functions; move internal helpers to `app_private`
5. pgTAP: topic-authorization matrix first, then per-RPC contracts
6. Playwright over `supabase start` for realtime, auth, federation

Order matters. Tests written before step 4 would cover code about to be deleted;
deletions before step 2 could not be verified against a fresh install.

## Open items

- prod group-icon storage policies are `(bucket_id = 'group-icons')` with no
  participant check. Repo and staging both require membership via
  `conversation_participants`. Confirm the policy role list — `anon` holds
  INSERT/UPDATE/DELETE on `storage.objects` — then apply the repo version.
- `ai-emojis` bucket exists in staging only and nothing references it; the 18
  code hits are a Klipy GIF provider category, not storage. Droppable.
- prod has the `http` extension and one function using it; staging does not, so
  that function fails there.
- prod carries duplicate avatar policies (singular and plural names, different
  predicates, OR'd together).
- prod-only tables `conversation_backup_pre_cleanup` and `hashtag_archive`.

## Drift gate results (first run)

`scripts/schema-drift-check.sh` builds two containers — one from `init/` alone,
one from `init/` plus all 233 migrations — dumps `public` from both, normalizes
to a sorted object inventory with digested bodies, and compares.

284 objects differ. Of the 74 functions among them:

- **51 differ only in their `SET search_path` clause.** A fresh init leaves
  `'public'`; the migrated schema has `'public', 'extensions', 'pg_temp'`.
  `99_performance_hardening.sql` and the hardening migration disagree on which
  functions get the tightened path. Systematic, one fix.
- **23 have genuinely different bodies.** A fresh install runs different code
  from a migrated instance. Several are security-relevant:
  `approve_device_request`, `get_user_permissions`, `generate_livekit_token`,
  `is_author_suspended`, `handle_message_federation`.

The remaining ~210 are policies, triggers, grants and `ALTER TABLE` statements.

Bodies are compared by digest with SQL comments stripped, so none of these are
reworded-comment noise. Verified: the first implementation reported all 284 as
body differences because comments were included; stripping them cut it to the
real set.

This is the concrete argument for a generated baseline. Reconciling 74 functions
by hand is the wrong move — the baseline should be produced from a database that
has had the migrations applied, which makes the difference structurally
impossible rather than manually corrected.
