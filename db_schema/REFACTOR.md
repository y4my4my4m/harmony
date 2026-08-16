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

`federation-backend` and `bot-gateway` are in-tree, not separate repositories,
and they call **36 distinct RPCs directly** — they do not only queue BullMQ
jobs. `NotificationListener.ts` additionally opens a raw `pg` client, though it
names no functions in SQL.

The reachability analysis already covered them (it walked the whole checkout),
and no worker RPC appears on the dead list. The surface manifest did not: its
first version scanned `src/` alone and reported 109 unreferenced functions.
Scanning the workers too gives **85**. The 24-function difference was
mislabelled and would have looked droppable.

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

## Surface manifest (`db_schema/SURFACE.tsv`)

Generated from a fresh `init/` build by `scripts/generate-surface.sh`, so it
describes what a new instance exposes rather than what one database happened to
accumulate. CI regenerates it and fails on any difference, which makes adding a
client-reachable endpoint a reviewed change.

From a fresh init: 337 functions, 241 `SECURITY DEFINER`, **334 granted to
`anon`**, 85 unreferenced by this repo. **47** sit in the worst quadrant at
once: `SECURITY DEFINER`, callable by `anon`, and called by nothing in this
repository.

The `anon` grant is not written anywhere in `db_schema/`. It is a default ACL
carried by the Supabase image:

```
postgres | f | postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres
```

So every function created in `public` becomes callable without authentication
the moment it exists, and `SECURITY DEFINER` means it runs with RLS bypassed.
Only three functions escape it — `bump_room_epoch`, `claim_ap_activity`,
`complete_ap_activity` — because something explicitly revoked them.

This settles the `app_private` question. Moving a helper out of `public` removes
it from PostgREST *and* from the default grant in one step; per-function
`REVOKE` would have to be remembered forever, on every new function, by every
contributor.

## Reachability (`db_schema/UNREACHABLE.tsv`)

`scripts/find-unreachable.sh` builds the schema from `init/`, then traverses the
call graph from every entry point: quoted strings anywhere in `src/`,
`federation-backend/src` and `bot-gateway/src`; triggers, RLS policies, cron
schedules, view definitions and column defaults, taken both from the built
schema and from `db_schema/` directly.

**47 of 336 functions are unreachable.** 30 are `SECURITY DEFINER` and
`anon`-callable. One, `get_timeline`, is documented in `docs/API_REFERENCE.md`
and is therefore an intentional endpoint regardless of internal callers.

Four defects in the analysis, each found by checking a result that looked wrong
rather than by reading the code:

1. `(?<![\w.])name\(` excluded every schema-qualified reference, so
   `EXECUTE FUNCTION public.foo()` and `public.foo(...)` were invisible. Live
   trigger handlers appeared dead. 211 → 51.
2. pg_dump heads each object with `-- Name: foo(...); Type: FUNCTION`, so every
   function named itself outside any body and became its own root. All 336
   looked reachable.
3. Roots were read from a `--schema=public` dump, which excludes cron schedules
   and policies on `realtime`/`storage`. Reading them from `db_schema/` as well
   fixed it; the container cannot create `realtime.messages` at all, since the
   schema is owned by `supabase_admin` and needs a running Realtime service.
4. Matching only `rpc('literal')` missed computed names.
   `postReactions.ts:125` picks between `add_` and `remove_post_emoji_reaction`
   with a ternary. Caller matching is now any quoted string: over-inclusive on
   purpose, since a false "reachable" costs nothing and a false "dead" is an
   outage.

The file is advisory. Nothing is dropped automatically.

## Surface reduction, step 1: revoke rather than drop

`migrations/20260809_revoke_unreachable_functions.sql` removes all 47
unreachable functions from `anon` and `authenticated`, mirrored into
`init/98_enable_rls.sql`.

Anon-callable functions: **334 → 287**.

Revoked instead of dropped deliberately. If something outside this repository
calls one, the failure is a permission error naming the function, undone by a
single `GRANT`. After a `DROP` the same call fails with a missing function and
the definition is gone. Dropping follows once a release passes without one.
`service_role` keeps access: it bypasses RLS by design and is not reachable
with a public key.

Three candidates were verified against the codebase rather than assumed, after
being wrongly flagged as needing a human decision:

- `generate_livekit_token`, `get_livekit_config` — superseded.
  `federation-backend/src/services/LiveKitService.ts` mints tokens with
  `livekit-server-sdk` from `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` in env, and
  the client fetches `/api/livekit/token`. The SQL implementation, which signs
  with `extensions.sign()` against a secret in `instance_config`, is legacy.
- `get_voice_channel_participants` — the app reads the
  `voice_channel_participants` table directly in five places.
- `get_timeline` — the `docs/API_REFERENCE.md` hit is
  `harmony.activitypub.get_timeline(...)`, a Python SDK method in an example,
  not the Postgres RPC. The "documented endpoint" flag was a bare-word false
  positive.

## Surface reduction, step 2: sequencing reversed

The plan above put pgTAP after the surface work. That order is wrong and the
analysis is why.

Of 337 functions, 123 return `trigger` and are not surface at all — Postgres
refuses a direct call (`ERROR: trigger functions can only be called as
triggers`), verified rather than assumed, so relocating them would be tidiness,
not security. Of the 214 that are callable over HTTP: 119 are client endpoints,
47 were unreachable and are revoked, and **47 are internal helpers** — reachable,
called only by other database code, exposed because of the default `anon` grant.

Classified in `db_schema/INTERNAL_HELPERS.tsv`:

- **11 keep-policy.** Referenced by an RLS policy: `get_current_profile_id`,
  `has_permission`, `is_conversation_participant`,
  `current_user_is_member_of_server`, `can_subscribe_to_topic` and others.
  Policy predicates execute as the querying role, so revoking any of these locks
  every user out of every table.
- **11 keep-invoker.** Called by a `SECURITY INVOKER` function, which runs them
  as the client. `enforce_message_length` calling `get_instance_config_int` is
  the clearest case.
- **24 revocable.** Every caller is `SECURITY DEFINER`.

24 is a real reduction and it is derived from static analysis, which has been
wrong four separate times in this work — each caught only by distrusting a
result that looked wrong. The failure mode here is not a wrong number in a
report; it is eleven functions one `REVOKE` away from locking every user out.

So pgTAP comes first. The revocations land afterwards, with tests that assert a
normal user can still read their channels, DMs and timeline, and that each
revoked helper is genuinely unreachable from a client session. Applying them
before there is a way to prove nothing broke is the exact habit this refactor
exists to end.

## pgTAP suite

`scripts/run-db-tests.sh` builds the schema from `init/`, installs pgtap into
the `tests` schema, loads fixtures once, then runs each file in `db_schema/tests/`
in its own rolled-back transaction. 27 assertions across topic authorization and
the RLS backbone.

Two defects were found by the suite itself, both of which had already produced
false confidence:

**`auth.uid()` is not the same function everywhere.** `supabase/postgres:15.8`
defines it as `current_setting('request.jwt.claim.sub')`; newer releases parse
the `request.jwt.claims` JSON. The harness set only the JSON form, so `auth.uid()`
returned null and **10 of 15 assertions passed for the wrong reason** — every
"cannot subscribe" case succeeded because the session authenticated as nobody.
The bootstrap now sets both forms.

**`REVOKE ... FROM anon, authenticated` does nothing on its own.** PostgreSQL
grants EXECUTE to `PUBLIC` by default, visible in `proacl` as the empty grantee
in `=X/postgres`. The named roles inherit from it, so the earlier migration left
all 47 functions callable. It was reported as effective because the surface
query listed explicit grantees from `information_schema` rather than asking
whether the role could execute.

Both are fixed: the revokes include `PUBLIC`, and the manifest uses
`has_function_privilege`. Verified after the fix — `archive_popular_hashtags` is
no longer executable by `anon`, `get_current_profile_id` still is.

The negative control matters more than the passing runs. Revoking
`get_current_profile_id` and re-running produces
`ERROR: permission denied for function get_current_profile_id`, which the runner
treats as failure. Before the `PUBLIC` fix the same sabotage left all 12
assertions green.
