-- Denormalised state maintained by triggers.
--
-- Every counter here duplicates a fact the row store already holds, so the
-- failure mode is drift, not absence. Each assertion therefore compares the
-- stored counter against a recount from the source of truth in the same
-- breath, spelled `stored/recount`: a delta assertion passes on a counter that
-- was already wrong before the write under test.
--
-- Transitions 30_reconciled_functions.sql already pins are not repeated.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(26);

-- follower / following counts ------------------------------------------------
-- 30_reconciled_functions.sql covers the status transition matrix. What it does
-- not cover: the follow row that disappears because the FOLLOWED profile was
-- deleted, and the two writes the schema refuses outright.
--
-- follows.follower_id/following_id are ON DELETE CASCADE, so deleting a profile
-- removes the follow row without any application code running. The count on the
-- surviving side is only correct if the row trigger fires on the cascade.
INSERT INTO public.profiles (id, username, is_local, followers_count, following_count)
VALUES ('c1000000-0000-0000-0000-0000000000a1', 'trg_follower', true, 0, 0),
       ('c1000000-0000-0000-0000-0000000000a2', 'trg_followee', true, 0, 0);

-- 'following_count/live-following followers_count/live-followers'
CREATE OR REPLACE FUNCTION pg_temp.fc(p_id uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT format('%s/%s %s/%s',
    (SELECT COALESCE(following_count, 0) FROM public.profiles WHERE id = p_id),
    (SELECT count(*) FROM public.follows WHERE follower_id = p_id AND status = 'accepted'),
    (SELECT COALESCE(followers_count, 0) FROM public.profiles WHERE id = p_id),
    (SELECT count(*) FROM public.follows WHERE following_id = p_id AND status = 'accepted'));
$fn$;

INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('c1000000-0000-0000-0000-0000000000a1', 'c1000000-0000-0000-0000-0000000000a2', 'accepted');

SELECT is(pg_temp.fc('c1000000-0000-0000-0000-0000000000a1'), '1/1 0/0',
          'an accepted follow counts once on the follower');
SELECT is(pg_temp.fc('c1000000-0000-0000-0000-0000000000a2'), '0/0 1/1',
          'an accepted follow counts once on the followee');

-- follows_no_self_follow. A self-follow would add one to both of a single
-- profile's counters, which no unfollow path can ever take back.
SELECT throws_ok(
    $q$INSERT INTO public.follows (follower_id, following_id, status)
       VALUES ('c1000000-0000-0000-0000-0000000000a1',
               'c1000000-0000-0000-0000-0000000000a1', 'accepted')$q$,
    '23514', NULL, 'a self-follow is rejected by the check constraint');
SELECT is(pg_temp.fc('c1000000-0000-0000-0000-0000000000a1'), '1/1 0/0',
          'the rejected self-follow left both counters alone');

-- UNIQUE(follower_id, following_id). Without it the same follow inserted twice
-- fires the AFTER INSERT trigger twice and the counter doubles.
SELECT throws_ok(
    $q$INSERT INTO public.follows (follower_id, following_id, status)
       VALUES ('c1000000-0000-0000-0000-0000000000a1',
               'c1000000-0000-0000-0000-0000000000a2', 'accepted')$q$,
    '23505', NULL, 'a duplicate follow is rejected by the unique key');
SELECT is(pg_temp.fc('c1000000-0000-0000-0000-0000000000a1'), '1/1 0/0',
          'the rejected duplicate did not inflate the count');

DELETE FROM public.profiles WHERE id = 'c1000000-0000-0000-0000-0000000000a2';
SELECT is(pg_temp.fc('c1000000-0000-0000-0000-0000000000a1'), '0/0 0/0',
          'deleting the followed profile decrements the follower through the cascade');

-- replies_count ---------------------------------------------------------------
-- A local parent recomputes from the child rows; the four writes below are the
-- whole lifecycle of a reply. Soft-delete and undelete are UPDATEs of
-- is_deleted, hard-delete is a DELETE, and the three reach different arms of
-- update_post_reply_count.
INSERT INTO public.profiles (id, username, is_local) VALUES
  ('c2000000-0000-0000-0000-0000000000b1', 'trg_parentauthor', true),
  ('c2000000-0000-0000-0000-0000000000b2', 'trg_replier',      true);

INSERT INTO public.posts (id, author_id, content, visibility, is_local)
VALUES ('c2000000-0000-0000-0000-0000000000d1', 'c2000000-0000-0000-0000-0000000000b1',
        '[{"type":"text","text":"parent"}]', 'public', true);

CREATE OR REPLACE FUNCTION pg_temp.rc() RETURNS text LANGUAGE sql AS $fn$
  SELECT format('%s/%s',
    (SELECT COALESCE(replies_count, 0) FROM public.posts
      WHERE id = 'c2000000-0000-0000-0000-0000000000d1'),
    (SELECT count(*) FROM public.posts
      WHERE in_reply_to = 'c2000000-0000-0000-0000-0000000000d1'
        AND is_deleted IS DISTINCT FROM true));
$fn$;

INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to)
VALUES ('c2000000-0000-0000-0000-0000000000d2', 'c2000000-0000-0000-0000-0000000000b2',
        '[{"type":"text","text":"a reply"}]', 'public', 'c2000000-0000-0000-0000-0000000000d1');
SELECT is(pg_temp.rc(), '1/1', 'a reply raises the parent replies_count');

UPDATE public.posts SET is_deleted = true WHERE id = 'c2000000-0000-0000-0000-0000000000d2';
SELECT is(pg_temp.rc(), '0/0', 'soft-deleting the reply gives the count back');

UPDATE public.posts SET is_deleted = false WHERE id = 'c2000000-0000-0000-0000-0000000000d2';
SELECT is(pg_temp.rc(), '1/1', 'undeleting the reply counts it again exactly once');

DELETE FROM public.posts WHERE id = 'c2000000-0000-0000-0000-0000000000d2';
SELECT is(pg_temp.rc(), '0/0', 'hard-deleting the reply gives the count back');

-- reblogs_count ---------------------------------------------------------------
-- 30_reconciled_functions.sql covers local, federated and soft-deleted reblogs.
-- Left over: the hard delete, whose trigger reads OLD.metadata rather than NEW,
-- and posts that are not reblogs of this original at all -- the count is
-- recomputed by a scan over posts.metadata, so a mismatched or absent
-- reblog_of must not land in it.
INSERT INTO public.profiles (id, username, is_local) VALUES
  ('c3000000-0000-0000-0000-0000000000c1', 'trg_rb_orig',  true),
  ('c3000000-0000-0000-0000-0000000000c2', 'trg_rb_boost', true),
  ('c3000000-0000-0000-0000-0000000000c3', 'trg_rb_other', true);

INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('c3000000-0000-0000-0000-0000000000f1', 'c3000000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"original one"}]', 'public'),
  ('c3000000-0000-0000-0000-0000000000f2', 'c3000000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"original two"}]', 'public');

CREATE OR REPLACE FUNCTION pg_temp.rbc(p_id uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT format('%s/%s',
    (SELECT COALESCE(reblogs_count, 0) FROM public.posts WHERE id = p_id),
    (SELECT count(*) FROM public.posts
      WHERE metadata->>'reblog_of' = p_id::text
        AND is_deleted IS DISTINCT FROM true));
$fn$;

INSERT INTO public.posts (id, author_id, content, visibility, metadata)
VALUES ('c3000000-0000-0000-0000-0000000000f3', 'c3000000-0000-0000-0000-0000000000c2',
        '[{"type":"text","text":""}]', 'public',
        '{"reblog_of":"c3000000-0000-0000-0000-0000000000f1"}');
SELECT is(pg_temp.rbc('c3000000-0000-0000-0000-0000000000f1'), '1/1',
          'a reblog raises the original reblogs_count');

-- A plain post and a reblog of the other original, inserted together.
INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('c3000000-0000-0000-0000-0000000000f5', 'c3000000-0000-0000-0000-0000000000c3',
   '[{"type":"text","text":"unrelated"}]', 'public');
INSERT INTO public.posts (id, author_id, content, visibility, metadata)
VALUES ('c3000000-0000-0000-0000-0000000000f4', 'c3000000-0000-0000-0000-0000000000c3',
        '[{"type":"text","text":""}]', 'public',
        '{"reblog_of":"c3000000-0000-0000-0000-0000000000f2"}');

SELECT is(pg_temp.rbc('c3000000-0000-0000-0000-0000000000f1'), '1/1',
          'a plain post and a reblog of another post leave this count alone');
SELECT is(pg_temp.rbc('c3000000-0000-0000-0000-0000000000f2'), '1/1',
          'that other reblog was counted against its own original');

DELETE FROM public.posts WHERE id = 'c3000000-0000-0000-0000-0000000000f3';
SELECT is(pg_temp.rbc('c3000000-0000-0000-0000-0000000000f1'), '0/0',
          'hard-deleting a reblog gives the count back');

-- unread_counts ---------------------------------------------------------------
-- Nothing has been marked read yet on the fixture channel and conversation, so
-- unread_messages equals every message the user did not write. The fixture
-- messages count toward that: they were inserted before this transaction and
-- fired the same triggers.
CREATE OR REPLACE FUNCTION pg_temp.uc_channel(p_user uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT format('%s/%s',
    (SELECT COALESCE(sum(unread_messages), 0) FROM public.unread_counts
      WHERE user_id = p_user AND channel_id = '66666666-0000-0000-0000-000000000006'),
    (SELECT count(*) FROM public.messages
      WHERE channel_id = '66666666-0000-0000-0000-000000000006'
        AND user_id IS DISTINCT FROM p_user
        AND COALESCE(is_deleted, false) = false
        AND COALESCE(is_system, false) = false));
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.uc_dm(p_user uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT format('%s/%s',
    (SELECT COALESCE(sum(unread_messages), 0) FROM public.unread_counts
      WHERE user_id = p_user AND conversation_id = '77777777-0000-0000-0000-000000000007'),
    (SELECT count(*) FROM public.messages
      WHERE conversation_id = '77777777-0000-0000-0000-000000000007'
        AND user_id IS DISTINCT FROM p_user
        AND COALESCE(is_deleted, false) = false
        AND COALESCE(is_system, false) = false));
$fn$;

INSERT INTO public.messages (channel_id, user_id, content)
VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"another channel message"}]');
SELECT is(pg_temp.uc_channel('22222222-0000-0000-0000-000000000002'), '2/2',
          'a channel message raises the unread count of the other member');
SELECT is(pg_temp.uc_channel('11111111-0000-0000-0000-000000000001'), '0/0',
          'the author of every message in the channel has nothing unread there');

INSERT INTO public.messages (conversation_id, user_id, content)
VALUES ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"another dm"}]');
SELECT is(pg_temp.uc_dm('22222222-0000-0000-0000-000000000002'), '2/2',
          'a DM raises the unread count of the other participant');

-- mark_server_as_read is the only path in the schema that clears a counter, and
-- it resolves the caller from the JWT rather than an argument.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.mark_server_as_read('55555555-0000-0000-0000-000000000005');
SELECT tests.clear_authentication();

SELECT is(pg_temp.uc_channel('22222222-0000-0000-0000-000000000002'), '0/2',
          'reading the server clears the counter while the messages remain');
SELECT is(pg_temp.uc_dm('22222222-0000-0000-0000-000000000002'), '2/2',
          'reading a server does not clear a DM, which carries no server_id');

-- timeline fan-out ------------------------------------------------------------
-- create_comprehensive_timeline_entries writes one home entry per follower plus
-- the author, and one public entry per local profile. Home is the feed that
-- leaks: an over-broad fan-out puts a stranger's post in your feed and reads as
-- an algorithm rather than a bug.
INSERT INTO public.profiles (id, username, is_local) VALUES
  ('c5000000-0000-0000-0000-0000000000e1', 'trg_tl_author',   true),
  ('c5000000-0000-0000-0000-0000000000e2', 'trg_tl_follower', true),
  ('c5000000-0000-0000-0000-0000000000e3', 'trg_tl_stranger', true);

INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('c5000000-0000-0000-0000-0000000000e2', 'c5000000-0000-0000-0000-0000000000e1', 'accepted');

INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('c5000000-0000-0000-0000-0000000000e9', 'c5000000-0000-0000-0000-0000000000e1',
        '[{"type":"text","text":"fan out"}]', 'public');

SELECT set_eq(
    $q$SELECT user_id FROM public.timeline_entries
        WHERE post_id = 'c5000000-0000-0000-0000-0000000000e9' AND timeline_type = 'home'$q$,
    $q$SELECT 'c5000000-0000-0000-0000-0000000000e1'::uuid
      UNION
      SELECT f.follower_id FROM public.follows f
        JOIN public.profiles p ON p.id = f.follower_id
       WHERE f.following_id = 'c5000000-0000-0000-0000-0000000000e1'
         AND f.status IN ('accepted', 'pending')
         AND p.is_local = true$q$,
    'the home fan-out reaches the author and their local followers, and no one else');

SELECT is((SELECT count(*)::int FROM public.timeline_entries
            WHERE post_id = 'c5000000-0000-0000-0000-0000000000e9'
              AND user_id = 'c5000000-0000-0000-0000-0000000000e3'
              AND timeline_type = 'home'), 0,
          'a non-follower gets no home entry for the post');

-- Without this the assertion above would also pass if the trigger never ran.
SELECT is((SELECT count(*)::int FROM public.timeline_entries
            WHERE post_id = 'c5000000-0000-0000-0000-0000000000e9'
              AND user_id = 'c5000000-0000-0000-0000-0000000000e3'
              AND timeline_type = 'public'), 1,
          'the same non-follower does get the public entry, so the fan-out did run for them');

-- reply notifications ---------------------------------------------------------
-- send_notification skips a recipient equal to p_from_user_id, and
-- handle_post_reply_notifications returns early when the parent author is the
-- replier. Both guards stand between a user and a notification about their own
-- typing; either one alone is enough, so the pair is asserted through the two
-- shapes that reach them separately.
INSERT INTO public.profiles (id, username, is_local) VALUES
  ('c6000000-0000-0000-0000-00000000f001', 'trg_notified', true),
  ('c6000000-0000-0000-0000-00000000f002', 'trg_notifier', true);

INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('c6000000-0000-0000-0000-00000000f011', 'c6000000-0000-0000-0000-00000000f001',
        '[{"type":"text","text":"notify me"}]', 'public');
INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to)
VALUES ('c6000000-0000-0000-0000-00000000f012', 'c6000000-0000-0000-0000-00000000f002',
        '[{"type":"text","text":"replying"}]', 'public',
        'c6000000-0000-0000-0000-00000000f011');

SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'c6000000-0000-0000-0000-00000000f001'
              AND type = 'activitypub_reply'
              AND data->>'post_id' = 'c6000000-0000-0000-0000-00000000f012'), 1,
          'a reply notifies the parent author exactly once');

SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'c6000000-0000-0000-0000-00000000f002'), 0,
          'the replier is notified of nothing');

-- The author replying to their own thread takes the early return instead.
INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to)
VALUES ('c6000000-0000-0000-0000-00000000f013', 'c6000000-0000-0000-0000-00000000f001',
        '[{"type":"text","text":"my own follow-up"}]', 'public',
        'c6000000-0000-0000-0000-00000000f011');

SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'c6000000-0000-0000-0000-00000000f001'
              AND type = 'activitypub_reply'), 1,
          'replying to your own post adds no notification');

SELECT * FROM finish();
ROLLBACK;
