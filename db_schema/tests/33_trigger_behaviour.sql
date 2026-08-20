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
SELECT plan(35);

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
--
-- Only the rejection is asserted. throws_ok runs the statement in a
-- BEGIN...EXCEPTION subtransaction, so a counter re-read after the raise
-- measures Postgres subtransaction rollback, not this schema.
SELECT throws_ok(
    $q$INSERT INTO public.follows (follower_id, following_id, status)
       VALUES ('c1000000-0000-0000-0000-0000000000a1',
               'c1000000-0000-0000-0000-0000000000a1', 'accepted')$q$,
    '23514', NULL, 'a self-follow is rejected by the check constraint');

-- UNIQUE(follower_id, following_id). Without it the same follow inserted twice
-- fires the AFTER INSERT trigger twice and the counter doubles.
SELECT throws_ok(
    $q$INSERT INTO public.follows (follower_id, following_id, status)
       VALUES ('c1000000-0000-0000-0000-0000000000a1',
               'c1000000-0000-0000-0000-0000000000a2', 'accepted')$q$,
    '23505', NULL, 'a duplicate follow is rejected by the unique key');

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

CREATE OR REPLACE FUNCTION pg_temp.rc(p_id uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT format('%s/%s',
    (SELECT COALESCE(replies_count, 0) FROM public.posts WHERE id = p_id),
    (SELECT count(*) FROM public.posts
      WHERE in_reply_to = p_id
        AND is_deleted IS DISTINCT FROM true));
$fn$;

INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to)
VALUES ('c2000000-0000-0000-0000-0000000000d2', 'c2000000-0000-0000-0000-0000000000b2',
        '[{"type":"text","text":"a reply"}]', 'public', 'c2000000-0000-0000-0000-0000000000d1');
SELECT is(pg_temp.rc('c2000000-0000-0000-0000-0000000000d1'), '1/1',
          'a reply raises the parent replies_count');

UPDATE public.posts SET is_deleted = true WHERE id = 'c2000000-0000-0000-0000-0000000000d2';
SELECT is(pg_temp.rc('c2000000-0000-0000-0000-0000000000d1'), '0/0',
          'soft-deleting the reply gives the count back');

UPDATE public.posts SET is_deleted = false WHERE id = 'c2000000-0000-0000-0000-0000000000d2';
SELECT is(pg_temp.rc('c2000000-0000-0000-0000-0000000000d1'), '1/1',
          'undeleting the reply counts it again exactly once');

DELETE FROM public.posts WHERE id = 'c2000000-0000-0000-0000-0000000000d2';
SELECT is(pg_temp.rc('c2000000-0000-0000-0000-0000000000d1'), '0/0',
          'hard-deleting the reply gives the count back');

-- Re-parenting. A move from one parent to another is a single UPDATE that must debit one
-- row and credit another; the parent the reply left is the one that silently keeps it.
INSERT INTO public.posts (id, author_id, content, visibility, is_local)
VALUES ('c2000000-0000-0000-0000-0000000000d3', 'c2000000-0000-0000-0000-0000000000b1',
        '[{"type":"text","text":"the other parent"}]', 'public', true);
INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to)
VALUES ('c2000000-0000-0000-0000-0000000000d4', 'c2000000-0000-0000-0000-0000000000b2',
        '[{"type":"text","text":"a reply that moves"}]', 'public',
        'c2000000-0000-0000-0000-0000000000d1');

UPDATE public.posts SET in_reply_to = 'c2000000-0000-0000-0000-0000000000d3'
 WHERE id = 'c2000000-0000-0000-0000-0000000000d4';

SELECT is(pg_temp.rc('c2000000-0000-0000-0000-0000000000d1'), '0/0',
          'the parent a reply moved away from stops counting it');
SELECT is(pg_temp.rc('c2000000-0000-0000-0000-0000000000d3'), '1/1',
          'the parent it moved to counts it exactly once');

-- The same move with a REMOTE parent on the losing side. A remote parent's replies_count is
-- the origin instance's figure plus the deltas seen here, so it takes -1 rather than a
-- recount over the fraction of the thread that federated in. The stored/recount shape does
-- not hold on a remote parent for that reason; these two read the stored column alone.
INSERT INTO public.profiles (id, username, is_local, domain)
VALUES ('c2000000-0000-0000-0000-0000000000b3', 'trg_remote_parent', false, 'remote.example');
INSERT INTO public.posts (id, author_id, content, visibility, is_local, replies_count)
VALUES ('c2000000-0000-0000-0000-0000000000d5', 'c2000000-0000-0000-0000-0000000000b3',
        '[{"type":"text","text":"a remote thread"}]', 'public', false, 7);
INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to)
VALUES ('c2000000-0000-0000-0000-0000000000d6', 'c2000000-0000-0000-0000-0000000000b2',
        '[{"type":"text","text":"joining in"}]', 'public', 'c2000000-0000-0000-0000-0000000000d5');

SELECT is((SELECT replies_count FROM public.posts
            WHERE id = 'c2000000-0000-0000-0000-0000000000d5'), 8,
          'a reply to a remote parent adds one to the origin figure');

UPDATE public.posts SET in_reply_to = 'c2000000-0000-0000-0000-0000000000d3'
 WHERE id = 'c2000000-0000-0000-0000-0000000000d6';

SELECT is((SELECT replies_count FROM public.posts
            WHERE id = 'c2000000-0000-0000-0000-0000000000d5'), 7,
          'moving that reply away takes the one back off the origin figure');
SELECT is(pg_temp.rc('c2000000-0000-0000-0000-0000000000d3'), '2/2',
          'and the local parent it landed on recounts from the rows');

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

-- The set above is the whole home fan-out, so the stranger's absence from it
-- needs no assertion of its own. Their public entry is a separate arm of the
-- trigger and is not implied by it.
SELECT is((SELECT count(*)::int FROM public.timeline_entries
            WHERE post_id = 'c5000000-0000-0000-0000-0000000000e9'
              AND user_id = 'c5000000-0000-0000-0000-0000000000e3'
              AND timeline_type = 'public'), 1,
          'the same non-follower does get the public entry, so the fan-out did run for them');

-- reply notifications ---------------------------------------------------------
-- Two guards stand between a user and a notification about their own typing:
-- handle_post_reply_notifications returns early when the parent author is the
-- replier, and send_notification skips a recipient equal to p_from_user_id. On
-- a self-reply both hold, so the self-reply assertion pins the trigger whole
-- rather than the early return alone.
--
-- No trigger in the schema leaves the actor in to_user_ids, so the second guard
-- is reached only by calling send_notification directly.
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

-- The author replying to their own thread.
INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to)
VALUES ('c6000000-0000-0000-0000-00000000f013', 'c6000000-0000-0000-0000-00000000f001',
        '[{"type":"text","text":"my own follow-up"}]', 'public',
        'c6000000-0000-0000-0000-00000000f011');

SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'c6000000-0000-0000-0000-00000000f001'
              AND type = 'activitypub_reply'), 1,
          'replying to your own post adds no notification');

-- The array entry point, called with the actor among the recipients. The probe
-- key survives into notifications.data, which send_notification only extends.
SELECT public.send_notification(
    'activitypub_reply',
    ARRAY['c6000000-0000-0000-0000-00000000f001'::uuid,
          'c6000000-0000-0000-0000-00000000f002'::uuid],
    '{"probe":"self_skip"}'::jsonb,
    NULL, NULL, NULL,
    'c6000000-0000-0000-0000-00000000f002'::uuid,
    'normal');

SELECT set_eq(
    $q$SELECT user_id FROM public.notifications WHERE data->>'probe' = 'self_skip'$q$,
    $q$SELECT 'c6000000-0000-0000-0000-00000000f001'::uuid$q$,
    'send_notification drops the recipient equal to the actor and keeps the rest');

-- Counter triggers under a real role ------------------------------------------
-- Every other assertion in this file runs as postgres, which bypasses RLS. A counter
-- trigger writing a row the caller does not own therefore succeeds here and fails in
-- production, where the caller is `authenticated` and posts_update_own filters the UPDATE
-- to author_id = get_current_profile_id(). An UPDATE matching zero rows is not an error, so
-- the interaction commits and the count does not move.
--
-- update_post_reaction_counts and update_post_reply_count shipped without SECURITY DEFINER
-- and had exactly that defect: favourites and replies counted for the post's own author and
-- for the federation backend on service_role, and for nobody else. These are the only cells
-- in the suite that adopt a non-author identity, which is what lets them see it.

INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('c7000000-0000-0000-0000-00000000b001', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"counted by a stranger"}]', 'public');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');

INSERT INTO public.post_interactions (user_id, post_id, interaction_type)
VALUES ('22222222-0000-0000-0000-000000000002', 'c7000000-0000-0000-0000-00000000b001', 'favorite');

INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to)
VALUES ('c7000000-0000-0000-0000-00000000b002', '22222222-0000-0000-0000-000000000002',
        '[{"type":"text","text":"a stranger replies"}]', 'public',
        'c7000000-0000-0000-0000-00000000b001');

RESET ROLE;

SELECT is((SELECT favorites_count FROM public.posts
            WHERE id = 'c7000000-0000-0000-0000-00000000b001'), 1,
          'a favourite from someone other than the author moves favorites_count');

SELECT is((SELECT replies_count FROM public.posts
            WHERE id = 'c7000000-0000-0000-0000-00000000b001'), 1,
          'a reply from someone other than the author moves replies_count');

-- posts_count -----------------------------------------------------------------
-- The number on the sidebar and on the profile posts tab. It counts every non-deleted row
-- the profile authored, replies and boosts included: the population the outbox reports as
-- totalItems, which is what a remote instance reads back as this user's posts_count, and the
-- list the posts tab renders.
--
-- Written under a real role rather than postgres: the trigger writes the author's profile
-- row, profiles_update_own guards that table, and an UPDATE filtered to nothing is not an
-- error.
CREATE OR REPLACE FUNCTION pg_temp.pc(p_id uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT format('%s/%s',
    (SELECT COALESCE(posts_count, 0) FROM public.profiles WHERE id = p_id),
    (SELECT count(*) FROM public.posts
      WHERE author_id = p_id AND is_deleted IS DISTINCT FROM true));
$fn$;

-- bob already owns the reply inserted above; a plain post and a boost join it.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');

INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('c7000000-0000-0000-0000-00000000b011', '22222222-0000-0000-0000-000000000002',
        '[{"type":"text","text":"a post of my own"}]', 'public');
INSERT INTO public.posts (id, author_id, content, visibility, metadata)
VALUES ('c7000000-0000-0000-0000-00000000b012', '22222222-0000-0000-0000-000000000002',
        '[{"type":"text","text":""}]', 'public',
        '{"reblog_of":"c7000000-0000-0000-0000-00000000b001"}');

RESET ROLE;

SELECT is(pg_temp.pc('22222222-0000-0000-0000-000000000002'), '3/3',
          'a post, a boost and a reply each count for the author who wrote them');
SELECT is(pg_temp.pc('11111111-0000-0000-0000-000000000001'), '1/1',
          'a boost and a reply add nothing to the count of the author boosted and replied to');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.posts SET is_deleted = true WHERE id = 'c7000000-0000-0000-0000-00000000b012';
RESET ROLE;
SELECT is(pg_temp.pc('22222222-0000-0000-0000-000000000002'), '2/2',
          'soft-deleting the boost gives the count back');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
DELETE FROM public.posts WHERE id = 'c7000000-0000-0000-0000-00000000b011';
RESET ROLE;
SELECT is(pg_temp.pc('22222222-0000-0000-0000-000000000002'), '1/1',
          'hard-deleting the post gives the count back');

-- A remote profile's posts_count is the origin instance's own figure, written by
-- ActorService from the actor's outbox totalItems. This instance holds only the posts that
-- federated in, so the two sides of the shape are meant to disagree here.
INSERT INTO public.profiles (id, username, is_local, domain, posts_count)
VALUES ('c7000000-0000-0000-0000-00000000b021', 'trg_remote_author', false,
        'remote.example', 4242);
INSERT INTO public.posts (id, author_id, content, visibility, is_local)
VALUES ('c7000000-0000-0000-0000-00000000b022', 'c7000000-0000-0000-0000-00000000b021',
        '[{"type":"text","text":"one post that federated here"}]', 'public', false);

SELECT is(pg_temp.pc('c7000000-0000-0000-0000-00000000b021'), '4242/1',
          'a remote author keeps the origin figure instead of the local fraction');

SELECT * FROM finish();
ROLLBACK;
