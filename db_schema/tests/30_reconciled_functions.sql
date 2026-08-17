-- Behaviour pinned for functions reconciled between init/ and migrations/.
--
-- Each entry in db_schema/RECONCILE.md gets an assertion here before its
-- migration is written, so the chosen behaviour is stated as a test rather than
-- inferred from whichever body happened to be applied last.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(26);

-- is_author_suspended --------------------------------------------------------
-- profiles.is_suspended is nullable and NULL for every row created before the
-- column existed. The migrated body returns NULL for those, which is neither
-- true nor false: callers written as `IF is_author_suspended(x) THEN` fall
-- through, and `WHERE NOT is_author_suspended(x)` drops the row entirely, so a
-- pre-existing author's posts silently vanish from any filtered listing.
-- False is the answer that matches the column's meaning: not suspended.
INSERT INTO public.profiles (id, username, is_local, is_suspended)
VALUES ('aaaa1111-0000-0000-0000-00000000aaaa', 'nullsuspend', true, NULL);

INSERT INTO public.profiles (id, username, is_local, is_suspended)
VALUES ('bbbb2222-0000-0000-0000-00000000bbbb', 'suspended', true, true);

SELECT is(public.is_author_suspended('aaaa1111-0000-0000-0000-00000000aaaa'), false,
          'a NULL is_suspended reads as not suspended, never NULL');
SELECT is(public.is_author_suspended('bbbb2222-0000-0000-0000-00000000bbbb'), true,
          'a suspended author reads as suspended');
SELECT is(public.is_author_suspended('11111111-0000-0000-0000-000000000001'), false,
          'an ordinary author reads as not suspended');
SELECT is(public.is_author_suspended('00000000-0000-0000-0000-000000000000'), false,
          'an unknown author reads as not suspended rather than NULL');

-- disable/enable_federation_triggers ------------------------------------------
-- A federation trigger is one whose handler reaches queue_federation_job. The
-- set is derived from the catalog rather than listed here, so a trigger added
-- later is covered without editing this file.
--
-- Both bodies name their triggers literally and neither kept up. The migration
-- that defined the pair, 20260310_backfill_archives.sql, names 20; every
-- federation trigger created after it was added to the table but not to the
-- list:
--
--   20260311  trg_conversation_participant_added
--   20260322  trg_group_participant_left
--   20260324  trigger_federate_channel{,_delete}, trigger_federate_category{,_delete},
--             trigger_federate_server_update
--   20260704  trigger_federate_follow_response
--
-- init/ picked up the 20260322 and 20260324 additions and production did not.
-- Neither picked up 20260311 or 20260704. A maintenance window that calls
-- disable_federation_triggers() still queues federation jobs for whatever the
-- caller's body omits, which is the failure this pins.
-- queue_federation_job is the general job queue, not only federation: the job
-- type is its first argument, and every federation job is named federate-*.
-- trigger_queue_push_notification queues 'send-push-notification' through the
-- same function, and a maintenance window that stops federating should not stop
-- notifying local users, so the seed matches on the job type rather than on the
-- function name.
CREATE TEMP VIEW fed_triggers AS
WITH RECURSIVE fed_fn AS (
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosrc ~ 'queue_federation_job[[:space:]]*\([[:space:]]*''federate-'
  UNION
    SELECT c.oid, c.proname
    FROM fed_fn f
    JOIN pg_proc c ON c.prosrc ~ ('(^|[^A-Za-z0-9_.])' || f.proname || '[[:space:]]*\(')
    JOIN pg_namespace cn ON cn.oid = c.pronamespace AND cn.nspname = 'public'
)
SELECT t.tgname::text AS tgname,
       t.tgrelid::regclass::text AS tbl,
       t.tgenabled AS tgenabled
FROM pg_trigger t
WHERE NOT t.tgisinternal AND t.tgfoid IN (SELECT oid FROM fed_fn);

-- Guards the derivation: an empty or broken fed_fn walk would make the two
-- assertions below pass without testing anything. 28 is the count at the time
-- of writing; more is fine, fewer means the walk stopped finding them.
SELECT cmp_ok((SELECT count(*) FROM fed_triggers), '>=', 28::bigint,
              'the catalog walk still finds every federation trigger');

SELECT public.disable_federation_triggers();
SELECT is_empty(
    $q$SELECT tgname, tbl FROM fed_triggers WHERE tgenabled <> 'D'$q$,
    'disable_federation_triggers() disables every trigger that queues federation work');

SELECT public.enable_federation_triggers();
SELECT is_empty(
    $q$SELECT tgname, tbl FROM fed_triggers WHERE tgenabled = 'D'$q$,
    'enable_federation_triggers() re-enables every one of them');

-- update_follow_counts --------------------------------------------------------
-- Only status = 'accepted' counts toward followers/following; 'pending' and
-- 'rejected' do not.
--
-- follows.status is nullable and CHECK (status IN (...)) admits NULL, because a
-- CHECK rejects only FALSE. `status = 'accepted'` is therefore NULL rather than
-- false, and both reconciled bodies let that NULL reach the branch test. They
-- spell the branch differently and so fail differently: init/ wrote
-- `IF v_is_accepted THEN ... ELSE decrement`, which takes the decrement arm on
-- NULL and drops both profiles' counts on an INSERT; the migrated body wrote
-- `IF v_is AND NOT v_was ... ELSIF v_was AND NOT v_is`, whose second arm is
-- NULL when v_is is NULL, so an UPDATE from 'accepted' to NULL leaks a count.
--
-- Neither body is safe. COALESCE(... , false) keeps both flags two-valued and
-- the two NULL cases below pin it; the rest pin the ordinary transitions, which
-- the two bodies already agreed on.
CREATE TEMP TABLE fc AS SELECT
    'dddd0000-0000-0000-0000-0000000000d1'::uuid AS a,
    'dddd0000-0000-0000-0000-0000000000d2'::uuid AS b;

CREATE OR REPLACE FUNCTION pg_temp.fc_reset() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  DELETE FROM public.follows
   WHERE follower_id IN (SELECT a FROM fc) OR following_id IN (SELECT a FROM fc);
  DELETE FROM public.profiles WHERE id IN (SELECT a FROM fc UNION SELECT b FROM fc);
  INSERT INTO public.profiles (id, username, is_local, followers_count, following_count)
  SELECT a, 'fc_a', true, 0, 0 FROM fc
  UNION ALL
  SELECT b, 'fc_b', true, 0, 0 FROM fc;
END;
$fn$;

-- counts as (follower.following_count, followee.followers_count)
CREATE OR REPLACE FUNCTION pg_temp.fc_counts() RETURNS text LANGUAGE sql AS $fn$
  SELECT (SELECT following_count FROM public.profiles WHERE id = (SELECT a FROM fc))::text
      || ',' ||
         (SELECT followers_count FROM public.profiles WHERE id = (SELECT b FROM fc))::text;
$fn$;

SELECT pg_temp.fc_reset();
INSERT INTO public.follows (follower_id, following_id, status)
SELECT a, b, 'pending' FROM fc;
SELECT is(pg_temp.fc_counts(), '0,0', 'a pending follow counts for neither side');

UPDATE public.follows SET status = 'accepted' WHERE follower_id = (SELECT a FROM fc);
SELECT is(pg_temp.fc_counts(), '1,1', 'pending -> accepted counts for both sides');

UPDATE public.follows SET status = 'accepted' WHERE follower_id = (SELECT a FROM fc);
SELECT is(pg_temp.fc_counts(), '1,1', 'a no-op status write does not double-count');

UPDATE public.follows SET status = 'rejected' WHERE follower_id = (SELECT a FROM fc);
SELECT is(pg_temp.fc_counts(), '0,0', 'accepted -> rejected gives the counts back');

SELECT pg_temp.fc_reset();
INSERT INTO public.follows (follower_id, following_id, status)
SELECT a, b, 'accepted' FROM fc;
SELECT is(pg_temp.fc_counts(), '1,1', 'a follow inserted already accepted counts once');

DELETE FROM public.follows WHERE follower_id = (SELECT a FROM fc);
SELECT is(pg_temp.fc_counts(), '0,0', 'deleting an accepted follow gives the counts back');

SELECT pg_temp.fc_reset();
INSERT INTO public.follows (follower_id, following_id, status)
SELECT a, b, 'pending' FROM fc;
DELETE FROM public.follows WHERE follower_id = (SELECT a FROM fc);
SELECT is(pg_temp.fc_counts(), '0,0', 'deleting a pending follow changes nothing');

-- Fails against init/: the decrement arm runs and both counts go to 0.
SELECT pg_temp.fc_reset();
UPDATE public.profiles SET followers_count = 5, following_count = 5
 WHERE id IN (SELECT a FROM fc UNION SELECT b FROM fc);
INSERT INTO public.follows (follower_id, following_id, status)
SELECT a, b, NULL FROM fc;
SELECT is(pg_temp.fc_counts(), '5,5',
          'a NULL status on INSERT counts for neither side rather than decrementing');

-- Fails against the migrated body: neither arm runs and the count leaks.
SELECT pg_temp.fc_reset();
INSERT INTO public.follows (follower_id, following_id, status)
SELECT a, b, 'accepted' FROM fc;
UPDATE public.follows SET status = NULL WHERE follower_id = (SELECT a FROM fc);
SELECT is(pg_temp.fc_counts(), '0,0',
          'accepted -> NULL gives the counts back rather than leaking them');

-- broadcast_* ----------------------------------------------------------------
-- RLS on realtime.messages, and so can_subscribe_to_topic, applies to private
-- channels only; a public topic is readable by anyone who can reach Realtime.
-- server-structure and server-presence carry channel, role, permission and
-- membership changes, so `private` is what engages authorization at all.
--
-- The two builds spell it differently -- init/ passes private => true, the
-- migrated bodies rely on realtime.send's DEFAULT true -- which is why no
-- assertion here can tell the eleven bodies apart. The property worth pinning
-- is not the spelling but the outcome: nothing this schema broadcasts is
-- public. That holds whichever body is loaded, and fails the moment someone
-- passes false or Realtime's default changes under a self-hosted deployment.
UPDATE public.servers SET description = 'reconcile-probe'
 WHERE id = '55555555-0000-0000-0000-000000000005';

SELECT isnt_empty(
    $q$SELECT topic FROM realtime.messages WHERE topic LIKE 'server-structure:%'$q$,
    'updating a server broadcasts on server-structure');

SELECT is_empty(
    $q$SELECT topic, event FROM realtime.messages WHERE private IS DISTINCT FROM true$q$,
    'every broadcast this schema emits is private, never public');

-- cleanup_dead_endpoint_users -------------------------------------------------
-- Reached from trigger_cleanup_dead_endpoint when an endpoint flips to dead,
-- not from an operator's session. The two bodies differ only in a RAISE NOTICE,
-- so no assertion separates them; what is pinned here is that the routine
-- deletes follows in both directions and clears the endpoint columns, since it
-- destroys rows and nothing else records what it removed.
INSERT INTO public.profiles (id, username, is_local, domain, inbox_url, shared_inbox_url)
VALUES ('eeee0000-0000-0000-0000-0000000000e1', 'deadremote', false, 'dead.example',
        'https://dead.example/inbox', 'https://dead.example/inbox');
INSERT INTO public.profiles (id, username, is_local)
VALUES ('eeee0000-0000-0000-0000-0000000000e2', 'livelocal', true);

INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('eeee0000-0000-0000-0000-0000000000e2', 'eeee0000-0000-0000-0000-0000000000e1', 'accepted'),
       ('eeee0000-0000-0000-0000-0000000000e1', 'eeee0000-0000-0000-0000-0000000000e2', 'accepted');

SELECT public.cleanup_dead_endpoint_users('https://dead.example/inbox');

SELECT is_empty(
    $q$SELECT follower_id, following_id FROM public.follows
        WHERE follower_id = 'eeee0000-0000-0000-0000-0000000000e1'
           OR following_id = 'eeee0000-0000-0000-0000-0000000000e1'$q$,
    'cleanup_dead_endpoint_users removes follows in both directions');

SELECT is((SELECT inbox_url IS NULL AND shared_inbox_url IS NULL
             FROM public.profiles WHERE id = 'eeee0000-0000-0000-0000-0000000000e1'), true,
          'cleanup_dead_endpoint_users clears the dead endpoint columns');

-- handle_post_reply_notifications and the mention handlers --------------------
-- The actor object in a notification payload comes from notification_actor_json
-- in init/ and from an inlined jsonb_build_object in the migrated bodies. The
-- inlined form omits `handle` and `user_id` and drops the COALESCE on
-- display_name and is_local, so a migrated database emits a weaker payload for
-- every reply and mention.
--
-- NotificationFormatter.getActorHandle is documented "set by DB via
-- notification_actor_json" and returns null without the key, so the helper is
-- the client's contract. These assertions fail against the inlined bodies.
--
-- The replier is created without a display_name on purpose: that is what
-- distinguishes COALESCE(display_name, username) from a bare column read.
INSERT INTO public.profiles (id, username, is_local, display_name)
VALUES ('f0000000-0000-0000-0000-00000000000a', 'parentauthor', true, 'Parent');
INSERT INTO public.profiles (id, username, is_local)
VALUES ('f0000000-0000-0000-0000-00000000000b', 'replier', true);

INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('f0000000-0000-0000-0000-0000000000e1', 'f0000000-0000-0000-0000-00000000000a',
        '[{"type":"text","text":"parent post"}]', 'public');
INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to)
VALUES ('f0000000-0000-0000-0000-0000000000e2', 'f0000000-0000-0000-0000-00000000000b',
        '[{"type":"text","text":"a reply"}]', 'public', 'f0000000-0000-0000-0000-0000000000e1');

SELECT is((SELECT data->'actor'->>'handle' FROM public.notifications
            WHERE type = 'activitypub_reply'), '@replier',
          'a reply notification carries the actor web handle');

SELECT is((SELECT data->'actor'->>'user_id' FROM public.notifications
            WHERE type = 'activitypub_reply'), 'f0000000-0000-0000-0000-00000000000b',
          'a reply notification carries the actor user_id alongside id');

SELECT is((SELECT data->'actor'->>'display_name' FROM public.notifications
            WHERE type = 'activitypub_reply'), 'replier',
          'a missing display_name falls back to the username rather than null');

-- reblogs_count -----------------------------------------------------------
-- A reblog is a posts row carrying metadata.reblog_of. The local path
-- (activityPubService.ts) writes only that row; an incoming federated Announce
-- writes it and a post_interactions row as well.
--
-- Counting from post_interactions alone missed every local reblog; counting
-- from both sources double-counted every federated one. reblogs_count is now
-- recomputed from posts.metadata->>'reblog_of' and nowhere else, so these three
-- hold regardless of which path created the reblog.
INSERT INTO public.profiles (id, username, is_local) VALUES
  ('ab000000-0000-0000-0000-000000000001', 'rb_orig',   true),
  ('ab000000-0000-0000-0000-000000000002', 'rb_local',  true),
  ('ab000000-0000-0000-0000-000000000003', 'rb_remote', true);

INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('ab000000-0000-0000-0000-0000000000f1', 'ab000000-0000-0000-0000-000000000001',
        '[{"type":"text","text":"original"}]', 'public');

CREATE OR REPLACE FUNCTION pg_temp.rb_count() RETURNS integer LANGUAGE sql AS $fn$
  SELECT reblogs_count FROM public.posts WHERE id = 'ab000000-0000-0000-0000-0000000000f1';
$fn$;

-- local reblog: posts row only
INSERT INTO public.posts (id, author_id, content, visibility, metadata)
VALUES ('ab000000-0000-0000-0000-0000000000f2', 'ab000000-0000-0000-0000-000000000002',
        '[{"type":"text","text":""}]', 'public',
        '{"reblog_of":"ab000000-0000-0000-0000-0000000000f1"}');
SELECT is(pg_temp.rb_count(), 1, 'a local reblog, which writes no post_interactions row, is counted');

-- federated reblog: posts row plus the interaction row
INSERT INTO public.posts (id, author_id, content, visibility, metadata)
VALUES ('ab000000-0000-0000-0000-0000000000f3', 'ab000000-0000-0000-0000-000000000003',
        '[{"type":"text","text":""}]', 'public',
        '{"reblog_of":"ab000000-0000-0000-0000-0000000000f1"}');
INSERT INTO public.post_interactions (user_id, post_id, interaction_type)
VALUES ('ab000000-0000-0000-0000-000000000003', 'ab000000-0000-0000-0000-0000000000f1', 'reblog');
SELECT is(pg_temp.rb_count(), 2, 'a federated reblog, which writes both rows, is counted once');

UPDATE public.posts SET is_deleted = true WHERE id = 'ab000000-0000-0000-0000-0000000000f2';
SELECT is(pg_temp.rb_count(), 1, 'soft-deleting a reblog gives the count back');

SELECT * FROM finish();
ROLLBACK;
