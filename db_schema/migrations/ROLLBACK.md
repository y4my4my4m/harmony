# Undoing the pending migrations

26 migrations, `20260816000001` through `20260818000013`, are pending on every real
instance. None has a down-migration. This file is what an operator reads instead.

Entries are grouped IRREVERSIBLE, REVERSIBLE WITH LOSS, REVERSIBLE, and are in version
order inside each group. The index below is in version order.

`scripts/restore-drill.sh` is the tested path back. An entry that says restore from backup
means that; no untested statement sequence stands in for it.

## Rules that apply to every entry

- The undo of a migration is not the undo of what the application did while it was
  applied. Rows written under the new schema are not addressed by any statement here.
- Every undo also removes the ledger row, or the next run re-applies nothing and the
  ledger lies:

  ```sql
  DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260818000013';
  ```

  The ledger is `supabase_migrations.schema_migrations (version text PRIMARY KEY, name
  text, statements text[])`. `version` is the 14-character filename prefix.
- Any undo that touches a table, a column, a policy or a function ends with
  `NOTIFY pgrst, 'reload schema';`.
- Take a schema-only dump before applying. Three entries have no source for their undo
  other than that dump.

  ```sh
  pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > pre-20260816.sql
  ```

- Function bodies replaced by these migrations are recoverable from git. The merge base
  of this branch is `1b54e067`; a body that lives only in `init/` is read with
  `git show 1b54e067:db_schema/init/<file>`.
- There is no `20260818000010`. The gap is in the filenames, not in the ledger.

## Index

| version | change | class |
|---|---|---|
| 20260816000001 | drops `invites_select_all` | REVERSIBLE |
| 20260816000002 | 11 `broadcast_*` bodies | REVERSIBLE |
| 20260816000003 | `cleanup_dead_endpoint_users` body | REVERSIBLE |
| 20260816000004 | `enable/disable_federation_triggers` bodies | REVERSIBLE |
| 20260816000005 | `handle_group_participant_left` body | REVERSIBLE |
| 20260816000006 | 3 notification handler bodies | REVERSIBLE |
| 20260816000007 | `update_follow_counts` body | REVERSIBLE |
| 20260816000008 | `search_path` on 3 functions | REVERSIBLE |
| 20260816000009 | `trg_broadcast_home_feed_entry` | REVERSIBLE |
| 20260816000010 | 36 `ALTER POLICY` | REVERSIBLE, pre-image not recorded |
| 20260816000011 | reblog counting, and recounts `reblogs_count` | REVERSIBLE WITH LOSS |
| 20260816000012 | drops 94 functions, 2 triggers, 2 tables; recounts follows | IRREVERSIBLE |
| 20260817000001 | drops 10 permissive policies | REVERSIBLE |
| 20260817000002 | `profiles_auth_user_id_key` UNIQUE | REVERSIBLE |
| 20260818000001 | creates 6 functions | REVERSIBLE |
| 20260818000002 | creates 6 push/presence functions | REVERSIBLE |
| 20260818000003 | `oauth_providers` SELECT policy | REVERSIBLE |
| 20260818000004 | 3 function bodies that raise on call | REVERSIBLE WITH LOSS |
| 20260818000005 | `federated_voice_calls` to production shape | IRREVERSIBLE |
| 20260818000006 | prekey and encryption columns, FK, 10 indexes | REVERSIBLE WITH LOSS |
| 20260818000007 | drops 2 `WITH CHECK (true)` policies, revokes | REVERSIBLE |
| 20260818000008 | 8 columns the application reads | REVERSIBLE WITH LOSS |
| 20260818000009 | 4 function bodies | REVERSIBLE |
| 20260818000011 | `messages_bot_id_fkey` | REVERSIBLE WITH LOSS |
| 20260818000012 | `bot_tokens` liveness columns | REVERSIBLE WITH LOSS |
| 20260818000013 | names `pg_temp` in every `search_path` | IRREVERSIBLE without a pre-image |

---

# IRREVERSIBLE

## 20260816000012_drop_legacy_and_unreachable

Drops 94 functions, `unified_activitypub_processing_trigger`,
`trigger_update_follow_counters`, `public.conversation_backup_pre_cleanup`,
`public.hashtag_archive`, and recounts `profiles.followers_count` and
`profiles.following_count` from `public.follows`.

**IRREVERSIBLE.** None of the 94 function definitions exists in `db_schema/init/` or in
any migration. The migration file names them but does not carry their bodies. The two
tables are dropped with their rows. The two count columns are overwritten in place.

**Undo, functions:** restore from a schema-only dump of production taken before the
migration. Each definition appears once, as `CREATE FUNCTION public.<name>(`:

```sh
awk '/^CREATE FUNCTION public\.process_follow_activity\(/,/^\$[A-Za-z_]*\$;$/' pre-20260816.sql
```

The terminator pattern covers both dollar-quote tags pg_dump emits, `$$;` and `$_$;`.

The full list of 94 is the `DROP FUNCTION IF EXISTS` lines of the migration:

```sh
grep -oE 'DROP FUNCTION IF EXISTS public\.[a-z_0-9]+' \
  db_schema/migrations/20260816000012_drop_legacy_and_unreachable.sql | sed 's/.*public\.//'
```

18 are the database-side ActivityPub pipeline (`process_*_activity`,
`handle_incoming_messages`, `convert_*`, `build_*`, `strip_mentions_from_dm_content`), 75
are the unreachable set `scripts/find-unreachable.sh` produced, and one is
`update_follow_counters`. A plain rollback cannot recreate any of them.

Each drop is wrapped in a `DO` block catching `dependent_objects_still_exist`, so anything
a trigger, view, policy, default or constraint still referenced was kept and logged
`kept (still referenced here): <name>`. Read the migration's NOTICE output before assuming
all 94 are gone.

**Undo, triggers:** both bindings are recoverable only alongside their functions.

```sql
CREATE TRIGGER trigger_update_follow_counters
    AFTER INSERT OR DELETE OR UPDATE ON public.follows
    FOR EACH ROW EXECUTE FUNCTION public.update_follow_counters();

CREATE TRIGGER unified_activitypub_processing_trigger
    AFTER UPDATE ON public.ap_activities
    FOR EACH ROW EXECUTE FUNCTION public.handle_activitypub_activity_processing();
```

Both are the production dump's text. There is no `WHEN` clause on the second; the
`status = 'processing'` test is inside `handle_activitypub_activity_processing`, so
restoring the trigger without restoring that function leaves a broken binding on every
`ap_activities` update.

**Undo, tables:** none. `conversation_backup_pre_cleanup` and `hashtag_archive` are gone
with their rows. Restore from backup.

**Lost if undone after the application has run against it:** the pre-migration values of
`followers_count` and `following_count`. They were wrong — every accepted follow was
counted twice by the two triggers — and the backfill recomputed both from `follows`, which
is the source of truth. Restoring the duplicate trigger without restoring the counts
resumes double counting from the corrected values.

**Alone:** the function drops and the count backfill are independent of every other
pending migration. Restoring `trigger_update_follow_counters` while `20260816000007` is
applied puts two counters back on `public.follows`.

## 20260818000005_federated_voice_calls_production_shape

Replaces `public.federated_voice_calls` with production's shape, adds four indexes, four
policies, `megolm_session_shares_delete`, and production's `cleanup_expired_voice_calls`
body.

**IRREVERSIBLE.** The migration takes one of three paths under an ACCESS EXCLUSIVE lock,
and which one it took is visible only in its `RAISE NOTICE` output:

- table already carries `ap_id` (production) — no-op, nothing to undo
- old shape, zero rows — `DROP TABLE`, then create
- old shape, rows present — `RENAME TO federated_voice_calls_legacy`, then create

**Undo after the rename branch:**

```sql
BEGIN;
DROP TABLE public.federated_voice_calls;                          -- destroys every row written since
ALTER TABLE public.federated_voice_calls_legacy RENAME TO federated_voice_calls;
ALTER INDEX public.federated_voice_calls_legacy_pkey       RENAME TO federated_voice_calls_pkey;
ALTER INDEX public.idx_federated_voice_calls_legacy_channel RENAME TO idx_federated_voice_calls_channel;
DROP POLICY IF EXISTS megolm_session_shares_delete ON public.megolm_session_shares;
COMMIT;
NOTIFY pgrst, 'reload schema';
```

The old shape is `(id, channel_id, started_at, ended_at, participants, sfu_url, room_id)`.
It shares only `id` and `ended_at` with the new one, so a row written since the migration
— every federated call invite — has no representation in it and is destroyed by the
`DROP TABLE`. There is no conversion.

**Undo after the drop branch:** the table definition is at
`git show 1b54e067:db_schema/init/05_tables_federation.sql`, lines 321-342. Rows are gone;
the migration only takes that branch when there are none.

`cleanup_expired_voice_calls` must go back with it. The old body names `started_at` and
raises 42703 on every call against the new shape, so leaving production's body in place
after a revert is the safer of the two wrong states:

```sh
git show 1b54e067:db_schema/init/12_functions_rpc.sql   # cleanup_expired_voice_calls
```

**Lost if undone after the application has run against it:** every pending, accepted and
ended federated call invite. `federation-backend` writes them on every inbound and
outbound DM call (`VoiceActivityHandler.ts`, `src/routes/livekit.ts`), and
`LiveKitService.validateFederatedRoomAccess` reads them to admit a remote actor to a room.
Calls in flight at the moment of the revert lose their authorization row and the
participants are dropped.

**Alone:** no. `20260818000007` runs after it and drops the `"System can insert calls"`
policy this file creates, and revokes `anon` and `authenticated` on the table. Reverting
this one drops the table and takes that policy state with it. Revert `20260818000007`
first, or accept that its effect disappears.

## 20260818000013_name_pg_temp_in_every_search_path

Appends `pg_temp` to the `search_path` of every function in `public` that does not already
name it. Functions with no pin at all get `public, extensions, pg_temp`.

**IRREVERSIBLE without a pre-image.** The migration does not record what each function had
before. `ALTER FUNCTION ... RESET search_path` is not the inverse: it removes the pin
entirely, including pins that predate this file.

Measured from the schema dumps: 114 of production's 448 `public` functions lack `pg_temp`
(111 pinned without it, 3 with no pin at all); 118 of staging's 344. Capture the pre-image
before applying:

```sql
SELECT p.oid::regprocedure::text AS fn,
       (SELECT c FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
         WHERE c LIKE 'search_path=%') AS pin
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
 ORDER BY 1;
```

**Undo with a pre-image:** one statement per row, `ALTER FUNCTION <fn> SET search_path =
<pin>` for rows that had one, `ALTER FUNCTION <fn> RESET search_path` for rows that did
not.

**Undo without a pre-image:** restore from backup, or leave it applied. Reverting blind
strips pins from functions that were correctly pinned before, which is a wider hole than
the one this file closes.

**Lost if undone:** nothing stored. What returns is the shadow: a `SET search_path =
public` pin does not stop Postgres searching the session's temporary schema first for
relation names, so a caller with a temp table named `profiles` chooses what
`is_current_user_admin()` reads. That helper is called by most RLS policies.

**Alone:** no, in one direction. Every pending migration that runs `CREATE OR REPLACE
FUNCTION` must run before this one, because `CREATE OR REPLACE` resets a function's
attributes to exactly what the statement says. Reverting any of `20260816000002`,
`20260816000003`, `20260816000004`, `20260816000005`, `20260816000006`, `20260816000007`,
`20260816000009`, `20260818000001`, `20260818000002`, `20260818000004`, `20260818000005`
or `20260818000009` by re-applying an older body **drops the `pg_temp` naming this file
installed on those functions**, silently. Restate `SET search_path = public, extensions,
pg_temp` in any body you put back.

---

# REVERSIBLE WITH LOSS

## 20260816000011_reblog_count_authoritative

Makes `update_post_reblog_count` the only reblog counter, drops the reblog arm of
`update_post_reaction_counts`, binds three triggers on `public.posts`, and recounts
`posts.reblogs_count`.

**REVERSIBLE WITH LOSS.** The function and trigger changes revert cleanly. The two
`UPDATE`s over `posts.reblogs_count` overwrite values with no record of what they were.

**Undo:**

```sql
BEGIN;
DROP TRIGGER IF EXISTS update_reblog_count_on_post_delete ON public.posts;
DROP TRIGGER IF EXISTS update_reblog_count_on_post_insert ON public.posts;
DROP TRIGGER IF EXISTS update_reblog_count_on_post_update ON public.posts;
DROP FUNCTION IF EXISTS public.update_post_reblog_count();
COMMIT;
```

Production already has `update_post_reblog_count` and its three triggers; the migration is
a no-op for them there and the four `DROP`s above are not an undo. An instance built from a
pre-branch `init/` had neither, and there they are.

The old `update_post_reaction_counts` body, with the `reblog` arm, is in
`20260311000003_reaction_favorites_count_trigger.sql`. Restate the pin:

```sql
ALTER FUNCTION public.update_post_reaction_counts() SET search_path = public, extensions, pg_temp;
```

**Lost if undone:** the pre-migration `reblogs_count` on every post that is the target of
a reblog. Those values were wrong in both directions — 1 where the truth was 2 on a fresh
build, 3 where the truth was 2 on production — so the loss is of a known-bad number.

**Alone:** safe. Nothing later depends on it.

## 20260818000004_fix_functions_that_raise_on_every_call

Replaces `create_federated_emoji`, `cleanup_old_metrics` and `aggregate_hourly_metrics`
with bodies that resolve. The `aggregate_hourly_metrics` replacement is guarded on the
`(hour, metric_type, metric_name, source)` unique constraint and skipped where absent.

**REVERSIBLE WITH LOSS.** The bodies revert. The rows `cleanup_old_metrics` deleted while
it worked do not come back.

**Undo:** re-apply the pre-migration bodies, which these print.

```sh
git show 1b54e067:db_schema/init/12_functions_rpc.sql       # create_federated_emoji
git show 1b54e067:db_schema/init/71_views_performance.sql   # cleanup_old_metrics, aggregate_hourly_metrics
```

Restate `SET search_path = public, extensions, pg_temp` on each.

`create_federated_emoji` also has a body in
`20260622000001_message_reactions_and_federation_fixes.sql`; it is the one production runs
and it raises `column reference "id" is ambiguous` on every call.

**Lost if undone:** rows pruned from `public.slow_queries`. The old body deleted by
`created_at`, a column the table does not have, so the third of its three deletes never
ran and slow queries accumulated. After the migration they are pruned; reverting restores
the leak, not the rows.

**Alone:** safe. Reverting puts three functions back in the state where they install
cleanly and raise on first call — the bot emoji-creation endpoint returns HTTP 500
(`bot-gateway/src/api/BotRestAPI.ts:1602`), and the metrics rollup silently produces
nothing.

## 20260818000006_prekey_and_encryption_column_gaps

Adds `prekeys.is_used` (backfilled from `used_at`) and `prekeys.used_by`, redefines
`prekeys_used_by_fkey` with `ON DELETE SET NULL`, re-gates the prekey SELECT policy from
`used_at` to `is_used`, adds `conversation_encryption_settings.verified`, adds nine
foreign-key columns with their constraints, and creates ten indexes.

**REVERSIBLE WITH LOSS.** Dropping a column drops the data in it.

**Undo:**

```sql
BEGIN;
DROP POLICY IF EXISTS "Users can view others' unused public prekeys" ON public.prekeys;
CREATE POLICY "Users can view others' unused public prekeys" ON public.prekeys
    FOR SELECT USING (used_at IS NULL);

ALTER TABLE public.prekeys DROP COLUMN IF EXISTS is_used;
ALTER TABLE public.prekeys DROP COLUMN IF EXISTS used_by;   -- takes prekeys_used_by_fkey and idx_prekeys_used_by
ALTER TABLE public.conversation_encryption_settings DROP COLUMN IF EXISTS verified;

ALTER TABLE public.blocked_instances        DROP COLUMN IF EXISTS blocked_by;
ALTER TABLE public.bot_audit_log            DROP COLUMN IF EXISTS user_id;
ALTER TABLE public.encryption_audit_log     DROP COLUMN IF EXISTS related_conversation_id;
ALTER TABLE public.encryption_audit_log     DROP COLUMN IF EXISTS related_server_id;
ALTER TABLE public.encryption_audit_log     DROP COLUMN IF EXISTS related_user_id;
ALTER TABLE public.instance_config          DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.server_federation_events DROP COLUMN IF EXISTS ap_activity_id;
ALTER TABLE public.server_membership_events DROP COLUMN IF EXISTS initiated_by;
ALTER TABLE public.voice_federation_events  DROP COLUMN IF EXISTS ap_activity_id;
COMMIT;
NOTIFY pgrst, 'reload schema';
```

Drop the policy before the column; a policy naming `is_used` blocks `DROP COLUMN`.
`DROP COLUMN` also removes the nine `*_fkey` constraints and the indexes over those
columns. The remaining index, `idx_prekeys_used_by`, goes with `used_by`.

**Production is NOT a no-op, and the revert above must not be run there.** The nine columns
and all ten index names are production's, so those halves do nothing. The foreign key is
different. Production carries

```sql
ADD CONSTRAINT prekeys_used_by_fkey FOREIGN KEY (used_by) REFERENCES auth.users(id);
```

with no `ON DELETE` clause, so `confdeltype` is `'a'` (NO ACTION). The migration's guard is
`confdeltype <> 'n'`, which that satisfies, so on production this migration drops and
recreates the constraint with `ON DELETE SET NULL` — and does nothing else.

The undo on production is only:

```sql
ALTER TABLE public.prekeys DROP CONSTRAINT prekeys_used_by_fkey;
ALTER TABLE public.prekeys
    ADD CONSTRAINT prekeys_used_by_fkey FOREIGN KEY (used_by) REFERENCES auth.users(id);
```

Running the column drops above on production destroys `used_by` — which prekey was consumed
by whom — for nothing, because the migration never added those columns there. Getting it
back means restoring from backup.

**Lost if undone:** which one-time prekey was consumed by whom. `used_by` is written by
`get_user_prekey_bundle` at every Signal-protocol session setup. `is_used` can be
recomputed from `used_at`, which the revert leaves in place, but the audit columns
(`related_user_id`, `related_server_id`, `related_conversation_id` on
`encryption_audit_log`, `blocked_by`, `initiated_by`, `updated_by`) hold values the
application wrote and nothing else records.

**Alone:** safe with respect to the other migrations. The `DROP COLUMN` removes
`prekeys_used_by_fkey` outright rather than restoring its `NO ACTION` form; re-adding the
column later without `ON DELETE SET NULL` brings back the hazard where a consumed prekey
pins the consumer's auth row and `delete_my_account` fails 23503 after it has already
anonymised the profile. Without `is_used`, `get_user_prekey_bundle` raises
`column "is_used" does not exist` on any instance built from `init/`, which is where key
exchange stops.

## 20260818000008_columns_the_application_reads

Adds eight nullable columns: `server_roles.icon_url`, `.unicode_emoji`, `.ap_id`,
`thread_members.last_read_message_id`, `user_servers.temporary`,
`bot_presence.gateway_session_id`, `.latency_ms`, `bot_audit_log.metadata`.

**REVERSIBLE WITH LOSS.**

**Undo:**

```sql
BEGIN;
ALTER TABLE public.server_roles   DROP COLUMN IF EXISTS icon_url;
ALTER TABLE public.server_roles   DROP COLUMN IF EXISTS unicode_emoji;
ALTER TABLE public.server_roles   DROP COLUMN IF EXISTS ap_id;
ALTER TABLE public.thread_members DROP COLUMN IF EXISTS last_read_message_id;
ALTER TABLE public.user_servers   DROP COLUMN IF EXISTS temporary;
ALTER TABLE public.bot_presence   DROP COLUMN IF EXISTS gateway_session_id;
ALTER TABLE public.bot_presence   DROP COLUMN IF EXISTS latency_ms;
ALTER TABLE public.bot_audit_log  DROP COLUMN IF EXISTS metadata;
COMMIT;
NOTIFY pgrst, 'reload schema';
```

No-op on production, which has all eight. Undoing there removes columns production has
carried since before this branch.

**Lost if undone:** role icons and emoji, remote role identity (`ap_id`), per-thread read
position, the temporary-membership flag invites set, live bot gateway session ids and
latency, and bot audit payloads.

**Alone:** safe with respect to the other migrations, not with respect to the application.
An unknown column in a PostgREST select list fails the whole request with 400, it does not
return null. Dropping these puts `RoleService.ts`, `ThreadService.ts`, `inviteService.ts`,
`WebSocketGateway.ts` and `BotRestAPI.ts` back to failing requests.

## 20260818000011_messages_bot_id_foreign_key

Adds `messages_bot_id_fkey` — `messages.bot_id` references `bots(id) ON DELETE CASCADE`.
Validates every existing row; aborts with a count if any `bot_id` has no matching bot.

**REVERSIBLE WITH LOSS.** The constraint drops cleanly. What it deleted does not come
back.

**Undo:**

```sql
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_bot_id_fkey;
NOTIFY pgrst, 'reload schema';
```

`DROP CONSTRAINT` takes ACCESS EXCLUSIVE on `public.messages` for the catalog update only;
it does not scan.

**Lost if undone:** nothing by the drop itself. The loss is what happened while the
constraint was live: `ON DELETE CASCADE` means every bot deletion since removed that bot's
messages. Those rows are gone and dropping the constraint does not restore them. Restore
from backup if a bot was deleted in the window.

**Alone:** safe. `20260818000012` and the bot gateway do not reference it. Dropping it
returns PostgREST to answering PGRST200 for the five embeds written
`bots!messages_bot_id_fkey` (`bot-gateway/src/api/BotRestAPI.ts:196, 269, 352, 386, 456`),
so bot send, list, get, edit and delete of channel messages stop working on anything but
production.

## 20260818000012_bot_tokens_liveness_columns

Adds `bot_tokens.is_active` (default true), `.uses_count` (default 0), `.metadata`
(default `{}`), then sets `is_active = (revoked_at IS NULL)` where it is NULL.

**REVERSIBLE WITH LOSS.**

**Undo:**

```sql
BEGIN;
ALTER TABLE public.bot_tokens DROP COLUMN IF EXISTS is_active;
ALTER TABLE public.bot_tokens DROP COLUMN IF EXISTS uses_count;
ALTER TABLE public.bot_tokens DROP COLUMN IF EXISTS metadata;
COMMIT;
NOTIFY pgrst, 'reload schema';
```

No-op on production, which has all three.

**Lost if undone:** every token revocation recorded after the migration, and the use
counter. `src/components/settings/user/UserBotsManagement.vue` revokes by writing
`is_active = false` alongside `revoked_at`, so the revocation survives in `revoked_at` —
but only for tokens revoked through that path. `uses_count` has no other record.

**Alone:** no. `verify_bot_token` reads `is_active` and writes `uses_count`, and its body
is unchanged by this migration because it already matches production. Dropping the columns
makes every call raise `column "is_active" does not exist`.
`bot-gateway/src/auth/BotAuthMiddleware.ts` maps any error from that RPC to
401 "Invalid or expired token", so bot REST auth and the gateway handshake fail on every
request with a message that names the wrong cause.

---

# REVERSIBLE

## 20260816000001_drop_invites_select_all_regression

Drops `invites_select_all ON public.invites`.

**REVERSIBLE.** No data, one policy.

**Undo:**

```sql
CREATE POLICY invites_select_all ON public.invites FOR SELECT USING (true);
NOTIFY pgrst, 'reload schema';
```

**Lost if undone:** nothing. What returns is invite enumeration: `anon` holds SELECT on
the table and permissive policies are OR'd, so one `USING (true)` publishes every `code`
and `server_id` on the instance. The accept and preview paths do not need it — they go
through `lookup_invite_by_code`, which is SECURITY DEFINER and returns one row.

**Alone:** safe. Nothing later depends on it.

## 20260816000002_reconcile_broadcast_functions

Replaces 11 `broadcast_*` trigger function bodies with `init/`'s, which pass
`private => true` as the fourth argument to `realtime.send`, and pins `search_path` on all
11.

**REVERSIBLE.** Bodies only.

**Undo:** re-apply the prior definitions, each still in the repo.

| function | prior definition |
|---|---|
| `broadcast_category_change` | `20260324000003_broadcast_consolidation.sql` |
| `broadcast_profile_change` | `20260322000007_broadcast_presence_events.sql` |
| the other nine | `20260324000007_broadcast_private_channels_with_rls.sql` |

Restate `SET search_path = public, extensions, pg_temp` on each; see the note under
`20260818000013`.

**Lost if undone:** nothing stored. Broadcasts emitted meanwhile went to private topics;
after a revert they go to public ones, which is what the migration exists to stop.

**Alone:** safe.

## 20260816000003_reconcile_cleanup_dead_endpoint_users

Replaces `cleanup_dead_endpoint_users` with `init/`'s body, which raises one NOTICE per
cleaned profile.

**REVERSIBLE.** Body only.

**Undo:** re-apply the prior definition, in
`20260310000012_backfill_archives.sql`. Restate `SET search_path = public, extensions,
pg_temp`.

**Lost if undone:** the log line. The function deletes follow rows in both directions and
nulls `profiles.inbox_url` in both versions; that behaviour is unchanged.

**Alone:** safe.

## 20260816000004_reconcile_federation_trigger_toggles

Replaces `enable_federation_triggers` and `disable_federation_triggers` with bodies naming
all 28 federation triggers, and pins `search_path`.

**REVERSIBLE.** Bodies only.

**Undo:** re-apply the prior definitions, in
`20260310000012_backfill_archives.sql`, where each names 20 triggers. Restate
`SET search_path = public, extensions, pg_temp`.

**Lost if undone:** nothing stored.

**Alone:** safe, with a trap. Do not revert while the triggers are disabled. The old
`enable_federation_triggers` names 20 of the 28, so calling it after a revert leaves 8
federation triggers disabled with no error and no output. Federation for channels, threads,
voice and group participants stops silently. Call the new `enable_federation_triggers`
before reverting, or re-enable the remaining 8 by hand:

```sql
SELECT 'ALTER TABLE ' || c.relname || ' ENABLE TRIGGER ' || t.tgname || ';'
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE t.tgname LIKE 'trig%federate%' AND t.tgenabled = 'D';
```

## 20260816000005_reconcile_group_participant_left

Replaces `handle_group_participant_left` with `init/`'s body, which drops a `SELECT * INTO`
whose result is never read.

**REVERSIBLE.** Body only.

**Undo:** re-apply the prior definition, in
`20260322000001_federate_group_chat_changes.sql`. Restate `SET search_path = public,
extensions, pg_temp`.

**Lost if undone:** nothing. The `queue_federation_job` payload is identical on both sides.

**Alone:** safe.

## 20260816000006_reconcile_notification_actor_json

Replaces `handle_post_reply_notifications`, `handle_post_mention_notifications` and
`handle_local_post_mention_notifications` with bodies that build the notification `actor`
through `notification_actor_json()`.

**REVERSIBLE.** Bodies only.

**Undo:** re-apply the prior definitions, all three in
`20260315000003_fix_favorited_reply_notifications_mentions.sql`. Restate
`SET search_path = public, extensions, pg_temp`.

**Lost if undone:** nothing already written. Notifications produced after a revert lose
the `handle` and `user_id` keys from the actor object and stop coalescing `display_name`
and `is_local`. Rows written before keep the full payload; the client sees a mixed feed.

**Alone:** safe.

## 20260816000007_reconcile_update_follow_counts

Replaces `update_follow_counts` with a body that wraps both accepted-status flags in
`COALESCE(..., false)`.

**REVERSIBLE.** Body only — the four `UPDATE`s in this file are inside the function, not
executed at migration time.

**Undo:** re-apply the prior definition, in
`20260528000008_follower_counts_trigger_and_backfill.sql`. Restate `SET search_path =
public, extensions, pg_temp`.

**Lost if undone:** nothing stored. What returns is the NULL-status corruption:
`follows.status` is nullable, `status = 'accepted'` evaluates to NULL rather than false,
and the two pre-migration bodies corrupt in opposite directions — one decrements both
profiles on an INSERT carrying a NULL status, the other leaves both counts raised on an
UPDATE from `accepted` to NULL.

**Alone:** safe. `20260816000012` backfills the same two columns and runs later; reverting
this without reverting that leaves correct counts under a body that will drift them again.

## 20260816000008_repin_search_path_stripped_functions

Pins `search_path` on `get_batch_message_reactions`, `get_message_reactions` and
`update_post_reply_count`.

**REVERSIBLE.**

**Undo:**

```sql
ALTER FUNCTION public.get_batch_message_reactions(message_ids uuid[]) RESET search_path;
ALTER FUNCTION public.get_message_reactions(message_id uuid)          RESET search_path;
ALTER FUNCTION public.update_post_reply_count()                       RESET search_path;
```

None of the three is SECURITY DEFINER, so this is hygiene and a Supabase advisor finding
(`function_search_path_mutable`), not a privilege path.

**Lost if undone:** nothing.

**Alone:** safe, but pointless in isolation — `20260818000013` re-pins all three, so a
revert of this file that leaves that one applied changes nothing.

## 20260816000009_restore_home_feed_broadcast_trigger

Recreates `broadcast_home_feed_entry` with the body already in
`20260528000006_restore_home_feed_realtime_trigger.sql` and rebinds
`trg_broadcast_home_feed_entry AFTER INSERT ON public.timeline_entries`.

**REVERSIBLE.**

**Undo:**

```sql
DROP TRIGGER IF EXISTS trg_broadcast_home_feed_entry ON public.timeline_entries;
```

The function itself predates this migration on any instance that applied the 20260528 set;
leave it. Do not drop it on an instance built from `init/`.

**Lost if undone:** nothing stored. Nothing else emits `home_feed:new_post`
(`src/services/UserEventChannel.ts`, `src/stores/useActivityPub.ts`), so without the
trigger a new post never reaches an open follower timeline. The replacement described by
the 20260528 revert does not exist; `federation-backend/src/queue/handlers/postHandler.ts`
points back at this trigger.

**Alone:** safe.

## 20260816000010_rls_initplan_optimisation

36 `ALTER POLICY` statements wrapping `auth.uid()` and `auth.role()` in a scalar subquery
so the planner hoists them into an InitPlan. Each is wrapped in a `DO` block that skips a
policy the instance does not have.

**REVERSIBLE, pre-image not recorded.** Same rows either way; only the number of function
evaluations changes. Production already carries the wrapped form on 81 `auth.uid()` and
199 `get_current_profile_id()` policies, so there it is a no-op.

**Undo:** there is nothing worth undoing. If a policy must be returned to its exact prior
text, capture it first:

```sql
SELECT c.relname, p.polname,
       pg_get_expr(p.polqual, p.polrelid)      AS using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
 ORDER BY 1, 2;
```

The mechanical inverse is to replace `( SELECT auth.uid() AS uid)` with `auth.uid()` in
the 36 statements of the migration file. That trades an InitPlan for a per-row call on
nearly every RLS-protected table.

**Lost if undone:** nothing.

**Alone:** safe. The 36 policies it touches do not overlap the 10 that `20260817000001`
drops.

## 20260817000001_drop_permissive_legacy_policies

Drops ten legacy RLS policies that widen access past the stricter policy sitting beside
each.

**REVERSIBLE**, but the definitions are not in this repository. All ten are in the
production dump.

**Undo:** extract by name.

```sh
grep -A20 '^CREATE POLICY "Users can view posts from users they follow"' pre-20260816.sql \
  | awk '1;/;$/{exit}'
```

Seven are single statements. Reproduced here from the dump, reflowed:

```sql
CREATE POLICY "Anyone can read webrtc settings" ON public.instance_webrtc_settings
    FOR SELECT USING (true);
CREATE POLICY "Enable insert for authenticated users only" ON public.notifications
    FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "System can manage federated profiles" ON public.profiles
    USING (((is_local = false) OR (auth_user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "Users can insert their own profile." ON public.profiles
    FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE USING ((id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
    WITH CHECK ((id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)));
CREATE POLICY "Users can view public posts" ON public.posts
    FOR SELECT USING (((visibility = ANY (ARRAY['public'::text, 'unlisted'::text]))
        AND ((is_deleted = false) OR (is_deleted IS NULL))
        AND (COALESCE(public.is_author_suspended(author_id), false) = false)));
CREATE POLICY "Users can view their own posts" ON public.posts
    FOR SELECT USING (((author_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id))
        AND ((is_deleted = false) OR (is_deleted IS NULL))));
```

The remaining three — `messages_insert_own`, `"Senders can create session shares"`,
`"Users can view posts from users they follow"` — carry multi-line `EXISTS` subqueries.
Take them from the dump.

**Lost if undone:** nothing stored. What returns, in the migration's own order of severity:
any authenticated user can post into any channel of any server; any authenticated user can
rewrite or delete any remote profile, and a DELETE cascades through the 62 `ON DELETE
CASCADE` foreign keys pointing at `profiles(id)`; a user can rewrite their own
`auth_user_id`; a profile can be inserted carrying somebody else's; notifications can be
forged against any user; a Megolm room key can be shared with a non-member; `anon` can read
`instance_webrtc_settings`; and blocking stops being enforced when reading posts.

**Alone:** no, in one direction. `20260817000002` adds the UNIQUE constraint on
`profiles.auth_user_id` that makes the identity takeover in items 3 and 4 fail with 23505
instead of silently succeeding. Reverting this file while that constraint stands is less
bad than reverting both. Reverting both restores the full path.

## 20260817000002_profiles_auth_user_id_unique

Adds `profiles_auth_user_id_key UNIQUE (auth_user_id)`. Refuses to run if duplicates
exist, naming the count.

**REVERSIBLE.** No data change; the constraint builds an index and drops it again.

**Undo:**

```sql
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_auth_user_id_key;
```

`ADD CONSTRAINT ... UNIQUE` builds the index under ACCESS EXCLUSIVE on `public.profiles`;
`DROP CONSTRAINT` takes the same lock for the catalog update only. Re-applying afterwards
pays the build again — use `CREATE UNIQUE INDEX CONCURRENTLY` then `ADD CONSTRAINT ... USING
INDEX` if the window matters.

**Lost if undone:** nothing. Production carries `idx_profiles_auth_user_id_unique`, which
is a plain btree despite the name, so the revert leaves the column unconstrained as it has
always been.

**Alone:** safe, and it is the one to keep if only one can be kept.
`get_current_profile_id()` is `SELECT id FROM profiles WHERE auth_user_id = auth.uid()
LIMIT 1` with no `ORDER BY`; two rows sharing an `auth_user_id` resolve to whichever the
planner returns first, and that function is the identity behind most RLS policies.

## 20260818000001_restore_functions_missing_from_production

Creates six functions production does not have: `get_activitypub_conversation_context`,
`get_activitypub_conversation_thread`, `get_emoji_usage_analytics`, `get_most_used_emojis`,
`get_user_emoji_stats`, `reset_daily_hashtag_counters`.

**REVERSIBLE, environment-dependent.** Bodies are copied verbatim from
`init/13_functions_rpc_extended.sql`, so on staging and on any fresh install these already
exist and the migration is a no-op — dropping them there removes what `init/` created.

**Undo on an instance that did not have them (production):**

```sql
BEGIN;
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(post_id uuid);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(in_conversation_root_id text);
DROP FUNCTION IF EXISTS public.get_emoji_usage_analytics(p_server_id uuid, p_user_id uuid, p_limit integer);
DROP FUNCTION IF EXISTS public.get_most_used_emojis(server_ids uuid[], "limit" integer);
DROP FUNCTION IF EXISTS public.get_user_emoji_stats(p_user_id uuid, p_server_id uuid, p_limit integer);
DROP FUNCTION IF EXISTS public.reset_daily_hashtag_counters();
COMMIT;
NOTIFY pgrst, 'reload schema';
```

**Lost if undone:** nothing stored. The six `.rpc()` call sites go back to PGRST202
"function does not exist": `ConversationService.ts:50, :85`, `emojiService.ts:85, :105,
:575`, `TrendingService.ts:725`.

**Alone:** safe.

## 20260818000002_restore_push_rpcs_and_close_anon_grants

Creates `get_server_members_by_instance`, `get_user_push_subscriptions`,
`has_active_session`, `is_user_viewing_push_context`, `record_push_failure`,
`record_push_success`, and revokes all six from `PUBLIC`, `anon` and `authenticated`.

**REVERSIBLE, environment-dependent.** All six exist on production and the bodies are
byte-identical, so the `CREATE OR REPLACE` half is a no-op there. **Do not drop them on
production** — they predate this migration and push delivery depends on them.

**Undo on an instance that did not have them (staging):**

```sql
BEGIN;
DROP FUNCTION IF EXISTS public.get_server_members_by_instance(p_server_id uuid);
DROP FUNCTION IF EXISTS public.get_user_push_subscriptions(p_user_id uuid);
DROP FUNCTION IF EXISTS public.has_active_session(p_user_id uuid);
DROP FUNCTION IF EXISTS public.is_user_viewing_push_context(p_user_id uuid, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid);
DROP FUNCTION IF EXISTS public.record_push_failure(p_subscription_id uuid, p_reason text);
DROP FUNCTION IF EXISTS public.record_push_success(p_subscription_id uuid);
COMMIT;
NOTIFY pgrst, 'reload schema';
```

**Undo of the revokes only**, on production, where that is the sole effect of the file:

```sql
GRANT EXECUTE ON FUNCTION public.get_user_push_subscriptions(p_user_id uuid) TO anon, authenticated;
-- and the other five
```

Do not. `get_user_push_subscriptions` returns the `p256dh` and `auth` secrets of any user's
push subscriptions given a user id. The prior grants are not recorded either; reproducing
them exactly needs `pg_proc.proacl` from a pre-image.

**Lost if undone:** nothing stored. `federation-backend` push delivery and
presence-aware suppression stop on any instance where the functions are dropped
(`PushNotificationService.ts:235, :280, :296, :361, :387`, `federationUtils.ts:26`).

**Alone:** safe.

## 20260818000003_oauth_providers_secret_not_public

Replaces `oauth_providers_select_all` (`USING (true)`, PUBLIC) with
`oauth_providers_select_admin_only`. Guarded on the table existing — production does not
have it.

**REVERSIBLE.**

**Undo:**

```sql
BEGIN;
DROP POLICY IF EXISTS "oauth_providers_select_admin_only" ON public.oauth_providers;
CREATE POLICY "oauth_providers_select_all" ON public.oauth_providers FOR SELECT USING (true);
COMMIT;
NOTIFY pgrst, 'reload schema';
```

**Lost if undone:** nothing. The table is empty everywhere it exists; no code reads or
writes it and the login screen's provider list comes from `instance_config` under key
`oauth_providers`. What returns is that populating the table publishes `client_secret` to
`anon`.

**Alone:** safe.

## 20260818000007_close_always_true_insert_policies

Drops `"System can insert calls"` on `federated_voice_calls` and `"System can insert audit
logs"` on `encryption_audit_log`, and revokes `anon` and `authenticated` on
`federated_voice_calls` down to SELECT.

**REVERSIBLE.**

**Undo:**

```sql
BEGIN;
CREATE POLICY "System can insert calls" ON public.federated_voice_calls
    FOR INSERT WITH CHECK (true);
CREATE POLICY "System can insert audit logs" ON public.encryption_audit_log
    FOR INSERT WITH CHECK (true);
COMMIT;
NOTIFY pgrst, 'reload schema';
```

**Do not add `GRANT ALL ... TO anon, authenticated` here.** Production's only grants on
`federated_voice_calls` are

```sql
GRANT SELECT ON TABLE public.federated_voice_calls TO authenticated;
GRANT ALL    ON TABLE public.federated_voice_calls TO service_role;
```

and the migration's `GRANT SELECT ON public.federated_voice_calls TO authenticated` leaves
that intact. `GRANT ALL ... TO anon, authenticated` would not restore a prior state — it
would hand `anon` write access to a table this same migration exists to make unwritable,
which is worse than either side of the change.

If an instance genuinely needs the schema-wide default back, restore it per role from that
instance's own `pg_class.relacl` before the migration ran, not from a blanket `GRANT ALL`.

**Lost if undone:** nothing stored. A row in `federated_voice_calls` is an authorization
input, not a log: `LiveKitService.validateFederatedRoomAccess` admits a remote actor to a
LiveKit room when a row exists with that `room_name`, `status in ('pending','accepted')`
and a matching `caller_federated_id`, and the minted token carries `roomJoin`,
`canPublish`, `canSubscribe` and `canPublishData`. With the policy back, an authenticated
caller who is party to no conversation can insert that row. Every legitimate writer is
`federation-backend` on the service role, which bypasses both RLS and grants.

**Alone:** no. `20260818000005` creates the same `"System can insert calls"` policy and
runs first. Reverting `20260818000005` drops the table and this file's effect with it;
revert this one first if both are going.

## 20260818000009_functions_that_cannot_run

Replaces `get_conversation_context`, `get_conversation_thread`, `get_custom_status` and
`rotate_prekeys` with bodies that resolve. `get_custom_status` also changes STABLE to
VOLATILE.

**REVERSIBLE.** Bodies only.

**Undo:** the old bodies are in git.

```sh
git show 1b54e067:db_schema/init/13_functions_rpc_extended.sql  # get_conversation_thread, rotate_prekeys
git show 1b54e067:db_schema/init/10_functions_core.sql          # get_custom_status
```

`get_conversation_context`'s pre-migration body is in
`20260315000003_fix_favorited_reply_notifications_mentions.sql`, which is where the
shadowing `DECLARE` came from.

Restate `SET search_path = public, extensions, pg_temp` on each; see the note under
`20260818000013`.

**Lost if undone:** nothing. None of the four has a caller in `src/`,
`federation-backend/src` or `bot-gateway/src`. Reverting returns them to raising 42702,
42883, 0A000 and 42703 respectively on first call, and turns `scripts/check-plpgsql.sh`
red.

**Alone:** safe.
