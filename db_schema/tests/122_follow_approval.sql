-- Locked accounts after 20261011900001_follow_approval.sql.
--
--   locked122   local, turns follow approval on and off
--   fan122      local follower of locked122
--   other122    local, no approval; a third party to locked122's follows
--   mention122  local, mentioned in a followers-only post of locked122
--   blocked122  local, blocked by locked122
--   rtarget122  remote account fan122 follows
--   rfan122     remote account requesting to follow locked122
--
-- queue_federation_job is replaced for the transaction so queued jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(43);

CREATE TABLE tests.jobs122 (name text, data jsonb);
GRANT INSERT, SELECT, DELETE ON tests.jobs122 TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs122 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1220000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'locked122@test.local'),
  ('f1220000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fan122@test.local'),
  ('f1220000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other122@test.local'),
  ('f1220000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mention122@test.local'),
  ('f1220000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'blocked122@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1220000-0000-0000-0000-0000000000c1', 'f1220000-0000-0000-0000-0000000000a1', 'locked122', 'Locked', true),
  ('f1220000-0000-0000-0000-0000000000c2', 'f1220000-0000-0000-0000-0000000000a2', 'fan122', 'Fan', true),
  ('f1220000-0000-0000-0000-0000000000c3', 'f1220000-0000-0000-0000-0000000000a3', 'other122', 'Other', true),
  ('f1220000-0000-0000-0000-0000000000c4', 'f1220000-0000-0000-0000-0000000000a4', 'mention122', 'Mentioned', true),
  ('f1220000-0000-0000-0000-0000000000c5', 'f1220000-0000-0000-0000-0000000000a5', 'blocked122', 'Blocked', true);
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url) VALUES
  ('f1220000-0000-0000-0000-0000000000d1', 'rtarget122', 'Remote target', false, 'remote122.test',
   'https://remote122.test/users/rtarget122', 'https://remote122.test/users/rtarget122/inbox'),
  ('f1220000-0000-0000-0000-0000000000d2', 'rfan122', 'Remote fan', false, 'remote122.test',
   'https://remote122.test/users/rfan122', 'https://remote122.test/users/rfan122/inbox');

INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('f1220000-0000-0000-0000-0000000000c1', 'f1220000-0000-0000-0000-0000000000c5');

-- locked122's posts: followers-only, followers-only mentioning mention122, followers-only with a
-- remote mention that shares other122's username.
INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('f1223000-0000-0000-0000-000000000001', 'f1220000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"for followers"}]', 'followers'),
  ('f1223000-0000-0000-0000-000000000002', 'f1220000-0000-0000-0000-0000000000c1',
   '[{"type":"mention","userId":"f1220000-0000-0000-0000-0000000000c4","username":"mention122","domain":"localhost","isLocal":true},{"type":"text","text":" hi"}]',
   'followers'),
  ('f1223000-0000-0000-0000-000000000003', 'f1220000-0000-0000-0000-0000000000c1',
   '[{"type":"mention","userId":"https://elsewhere.test/users/other122","username":"other122","domain":"elsewhere.test","isLocal":false},{"type":"text","text":" hi"}]',
   'followers');

-- Locking --------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
UPDATE public.profiles SET manually_approves_followers = true
 WHERE id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM tests.jobs122
            WHERE name = 'federate-profile'
              AND data->>'profile_id' = 'f1220000-0000-0000-0000-0000000000c1'),
          1, 'turning follow approval on federates the actor');

-- Requests -------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a2');
INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f1220000-0000-0000-0000-0000000000c2', 'f1220000-0000-0000-0000-0000000000c1', 'accepted'),
  ('f1220000-0000-0000-0000-0000000000c2', 'f1220000-0000-0000-0000-0000000000d1', 'accepted'),
  ('f1220000-0000-0000-0000-0000000000c2', 'f1220000-0000-0000-0000-0000000000c3', 'pending');
SELECT tests.clear_authentication();

SELECT is((SELECT status FROM public.follows
            WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
              AND following_id = 'f1220000-0000-0000-0000-0000000000c1'),
          'pending', 'a follow of a locked account is a request whatever status the client sends');
SELECT is((SELECT status FROM public.follows
            WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
              AND following_id = 'f1220000-0000-0000-0000-0000000000d1'),
          'pending', 'a follow of a remote account waits for its Accept');
SELECT is((SELECT status FROM public.follows
            WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
              AND following_id = 'f1220000-0000-0000-0000-0000000000c3'),
          'accepted', 'a follow of a local account without approval is accepted whatever status the client sends');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f1220000-0000-0000-0000-0000000000c1'
              AND type = 'activitypub_follow_request'
              AND data->>'follower_id' = 'f1220000-0000-0000-0000-0000000000c2'),
          1, 'the locked account is notified of the request');

-- A withdrawn request.
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a4');
INSERT INTO public.follows (follower_id, following_id)
VALUES ('f1220000-0000-0000-0000-0000000000c4', 'f1220000-0000-0000-0000-0000000000c1');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f1220000-0000-0000-0000-0000000000c1'
              AND type = 'activitypub_follow_request'
              AND data->>'follower_id' = 'f1220000-0000-0000-0000-0000000000c4'),
          1, 'a second request is notified');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a4');
DELETE FROM public.follows
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c4'
   AND following_id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f1220000-0000-0000-0000-0000000000c1'
              AND type = 'activitypub_follow_request'
              AND data->>'follower_id' = 'f1220000-0000-0000-0000-0000000000c4'),
          0, 'a withdrawn request takes its notification with it');

-- Who sees a request ---------------------------------------------------------------------
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a4');
SELECT is_empty(
    $q$SELECT 1 FROM public.follows
        WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
          AND following_id = 'f1220000-0000-0000-0000-0000000000c1'$q$,
    'a third party cannot see a pending request');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.follows
        WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
          AND following_id = 'f1220000-0000-0000-0000-0000000000c3'$q$,
    'an accepted follow is public');
SELECT tests.authenticate_as_anon();
SELECT is_empty(
    $q$SELECT 1 FROM public.follows
        WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
          AND following_id = 'f1220000-0000-0000-0000-0000000000c1'$q$,
    'anon cannot see a pending request');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a2');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.follows
        WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
          AND following_id = 'f1220000-0000-0000-0000-0000000000c1'$q$,
    'the requester sees its request');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.follows
        WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
          AND following_id = 'f1220000-0000-0000-0000-0000000000c1'$q$,
    'the requested account sees the request');
SELECT tests.clear_authentication();

-- Blocks ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a5');
SELECT throws_ok(
    $q$INSERT INTO public.follows (follower_id, following_id)
       VALUES ('f1220000-0000-0000-0000-0000000000c5', 'f1220000-0000-0000-0000-0000000000c1')$q$,
    '42501', 'a block stands between these accounts',
    'a blocked account cannot follow its blocker');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
SELECT throws_ok(
    $q$INSERT INTO public.follows (follower_id, following_id)
       VALUES ('f1220000-0000-0000-0000-0000000000c1', 'f1220000-0000-0000-0000-0000000000c5')$q$,
    '42501', 'a block stands between these accounts',
    'a blocker cannot follow the account it blocked');
SELECT tests.clear_authentication();

-- Followers-only posts -------------------------------------------------------------------
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a2');
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f1223000-0000-0000-0000-000000000001'$q$,
    'a pending follower cannot read followers-only posts');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a4');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f1223000-0000-0000-0000-000000000002'$q$,
    'a local account mentioned in a followers-only post reads it');
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f1223000-0000-0000-0000-000000000001'$q$,
    'the mention opens that post only');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a3');
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f1223000-0000-0000-0000-000000000002'$q$,
    'an account the post does not mention cannot read it');
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f1223000-0000-0000-0000-000000000003'$q$,
    'a remote mention sharing a local username opens nothing');
SELECT tests.authenticate_as_anon();
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE author_id = 'f1220000-0000-0000-0000-0000000000c1'$q$,
    'anon reads no followers-only post');
SELECT tests.clear_authentication();

-- Answering a request --------------------------------------------------------------------
INSERT INTO public.follows (follower_id, following_id, status, ap_id, is_local) VALUES
  ('f1220000-0000-0000-0000-0000000000d2', 'f1220000-0000-0000-0000-0000000000c1', 'pending',
   'https://remote122.test/activities/follow/1', false);

SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
UPDATE public.follows SET status = 'accepted'
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
   AND following_id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();

SELECT isnt_empty(
    $q$SELECT 1 FROM public.timeline_entries
        WHERE user_id = 'f1220000-0000-0000-0000-0000000000c2'
          AND post_id = 'f1223000-0000-0000-0000-000000000001'
          AND timeline_type = 'home'$q$,
    'accepting a follower backfills followers-only posts into its home timeline');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f1220000-0000-0000-0000-0000000000c1'
              AND type = 'activitypub_follow_request'
              AND data->>'follower_id' = 'f1220000-0000-0000-0000-0000000000c2'),
          0, 'an accepted request takes its notification with it');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a2');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f1223000-0000-0000-0000-000000000001'$q$,
    'an accepted follower reads followers-only posts');
SELECT tests.clear_authentication();

-- Unlocking ------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a4');
INSERT INTO public.follows (follower_id, following_id)
VALUES ('f1220000-0000-0000-0000-0000000000c4', 'f1220000-0000-0000-0000-0000000000c1');
SELECT tests.clear_authentication();

DELETE FROM tests.jobs122;
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
UPDATE public.profiles SET manually_approves_followers = false
 WHERE id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();

SELECT is_empty(
    $q$SELECT 1 FROM public.follows
        WHERE following_id = 'f1220000-0000-0000-0000-0000000000c1' AND status <> 'accepted'$q$,
    'turning follow approval off accepts every pending request');
SELECT is((SELECT count(*)::int FROM tests.jobs122
            WHERE name = 'federate-follow'
              AND data->>'type' = 'respond'
              AND data->>'status' = 'accepted'
              AND data->>'follower_id' = 'f1220000-0000-0000-0000-0000000000d2'
              AND data->>'ap_id' = 'https://remote122.test/activities/follow/1'),
          1, 'the Accept of the remote request is queued with its Follow id');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f1220000-0000-0000-0000-0000000000c1'
              AND type = 'activitypub_follow_request'),
          0, 'the accepted requests take their notifications with them');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f1220000-0000-0000-0000-0000000000c4'
              AND type = 'activitypub_follow_accepted'),
          1, 'a local requester is told its request was accepted');
SELECT is((SELECT count(*)::int FROM tests.jobs122
            WHERE name = 'federate-profile'
              AND data->>'profile_id' = 'f1220000-0000-0000-0000-0000000000c1'),
          1, 'turning follow approval off federates the actor');

-- Locking again keeps followers; the next unlock accepts what waits then.
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
UPDATE public.profiles SET manually_approves_followers = true
 WHERE id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.follows
            WHERE following_id = 'f1220000-0000-0000-0000-0000000000c1' AND status = 'accepted'),
          3, 'locking keeps existing followers');

SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a3');
INSERT INTO public.follows (follower_id, following_id)
VALUES ('f1220000-0000-0000-0000-0000000000c3', 'f1220000-0000-0000-0000-0000000000c1');
SELECT tests.clear_authentication();
SELECT is((SELECT status FROM public.follows
            WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c3'
              AND following_id = 'f1220000-0000-0000-0000-0000000000c1'),
          'pending', 'a request after relocking waits');

SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
UPDATE public.profiles SET manually_approves_followers = false
 WHERE id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is((SELECT status FROM public.follows
            WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c3'
              AND following_id = 'f1220000-0000-0000-0000-0000000000c1'),
          'accepted', 'the next unlock accepts it');

-- Rejecting --------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
UPDATE public.profiles SET manually_approves_followers = true
 WHERE id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
DELETE FROM public.follows
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c3'
   AND following_id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a3');
INSERT INTO public.follows (follower_id, following_id)
VALUES ('f1220000-0000-0000-0000-0000000000c3', 'f1220000-0000-0000-0000-0000000000c1');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
UPDATE public.follows SET status = 'rejected'
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c3'
   AND following_id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f1220000-0000-0000-0000-0000000000c1'
              AND type = 'activitypub_follow_request'
              AND data->>'follower_id' = 'f1220000-0000-0000-0000-0000000000c3'),
          0, 'a rejected request takes its notification with it');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a4');
SELECT is_empty(
    $q$SELECT 1 FROM public.follows
        WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c3'
          AND following_id = 'f1220000-0000-0000-0000-0000000000c1'$q$,
    'a third party cannot see a rejection');
SELECT tests.clear_authentication();

-- Removing followers -----------------------------------------------------------------------
DELETE FROM tests.jobs122;
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
DELETE FROM public.follows
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000d2'
   AND following_id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM tests.jobs122
            WHERE name = 'federate-follow'
              AND data->>'type' = 'respond'
              AND data->>'status' = 'rejected'
              AND data->>'follower_id' = 'f1220000-0000-0000-0000-0000000000d2'
              AND data->>'following_id' = 'f1220000-0000-0000-0000-0000000000c1'
              AND data->>'ap_id' = 'https://remote122.test/activities/follow/1'),
          1, 'removing a remote follower queues a Reject carrying its Follow id');
SELECT is_empty(
    $q$SELECT 1 FROM public.follows WHERE follower_id = 'f1220000-0000-0000-0000-0000000000d2'$q$,
    'the removed remote follow is gone');

DELETE FROM tests.jobs122;
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a1');
DELETE FROM public.follows
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
   AND following_id = 'f1220000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is_empty(
    $q$SELECT 1 FROM tests.jobs122 WHERE data->>'type' = 'respond'$q$,
    'removing a local follower sends no Reject');
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a2');
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f1223000-0000-0000-0000-000000000001'$q$,
    'a removed follower no longer reads followers-only posts');
SELECT tests.clear_authentication();
SELECT is_empty(
    $q$SELECT 1 FROM public.timeline_entries
        WHERE user_id = 'f1220000-0000-0000-0000-0000000000c2'
          AND post_id = 'f1223000-0000-0000-0000-000000000001'$q$,
    'and loses them from its home timeline');

-- A service-side delete (an inbound Undo) answers nothing.
INSERT INTO public.follows (follower_id, following_id, status, ap_id, is_local) VALUES
  ('f1220000-0000-0000-0000-0000000000d2', 'f1220000-0000-0000-0000-0000000000c1', 'accepted',
   'https://remote122.test/activities/follow/2', false);
DELETE FROM tests.jobs122;
DELETE FROM public.follows WHERE follower_id = 'f1220000-0000-0000-0000-0000000000d2';
SELECT is_empty($q$SELECT 1 FROM tests.jobs122$q$,
                'a service-side delete of a remote follow queues nothing');

-- Outgoing remote follows -----------------------------------------------------------------
-- processReject stores the rejection before deleting the row.
DELETE FROM tests.jobs122;
UPDATE public.follows SET status = 'rejected'
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
   AND following_id = 'f1220000-0000-0000-0000-0000000000d1';
DELETE FROM public.follows
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
   AND following_id = 'f1220000-0000-0000-0000-0000000000d1';
SELECT is_empty($q$SELECT 1 FROM tests.jobs122 WHERE data->>'type' = 'delete'$q$,
                'a follow the remote side rejected is deleted without an Undo');

SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a2');
INSERT INTO public.follows (follower_id, following_id)
VALUES ('f1220000-0000-0000-0000-0000000000c2', 'f1220000-0000-0000-0000-0000000000d1');
DELETE FROM public.follows
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
   AND following_id = 'f1220000-0000-0000-0000-0000000000d1';
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM tests.jobs122
            WHERE name = 'federate-follow'
              AND data->>'type' = 'delete'
              AND data->>'following_id' = 'f1220000-0000-0000-0000-0000000000d1'),
          1, 'withdrawing a remote request sends an Undo');

-- An Accept from the remote side completes the follow.
SELECT tests.authenticate_as('f1220000-0000-0000-0000-0000000000a2');
INSERT INTO public.follows (follower_id, following_id)
VALUES ('f1220000-0000-0000-0000-0000000000c2', 'f1220000-0000-0000-0000-0000000000d1');
SELECT tests.clear_authentication();
UPDATE public.follows SET status = 'accepted', accepted_at = now()
 WHERE follower_id = 'f1220000-0000-0000-0000-0000000000c2'
   AND following_id = 'f1220000-0000-0000-0000-0000000000d1';
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f1220000-0000-0000-0000-0000000000c2'
              AND type = 'activitypub_follow_accepted'
              AND data->>'followed_id' = 'f1220000-0000-0000-0000-0000000000d1'),
          1, 'the remote Accept tells the local follower');

-- Grants ---------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.accept_pending_follows_on_unlock()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.clear_follow_request_notification()', 'EXECUTE'),
          'clients cannot call the follow trigger functions');

SELECT * FROM finish();
ROLLBACK;
