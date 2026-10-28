-- Timeline fan-out after 20261031600001_timeline_fanout.sql: create_comprehensive_timeline_entries
-- writes 'home' entries only, and create_report's visibility rule holds without per-profile
-- 'public' entries.
--
--   author211    local author
--   fan211       local, accepted follower of author211 and of far211
--   pend211      local, pending follower of author211
--   ment211      local, mentioned in author211's followers-only and direct posts
--   stranger211  local, no relation
--   far211       remote author on far211.example
--   crowd211_*   40 local profiles with no relation; a per-profile fan-out would reach them
--
--   p1  far211    public     federated
--   p2  author211 public
--   p3  author211 followers  mentions ment211
--   p4  author211 direct     mentions ment211
--   p5  author211 public     written by the pre-20261031600001 body (negative control)

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(19);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2110000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'author211@test.local'),
  ('f2110000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fan211@test.local'),
  ('f2110000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pend211@test.local'),
  ('f2110000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ment211@test.local'),
  ('f2110000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger211@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f2110000-0000-0000-0000-0000000000c1', 'f2110000-0000-0000-0000-0000000000a1', 'author211', 'Author', true),
  ('f2110000-0000-0000-0000-0000000000c2', 'f2110000-0000-0000-0000-0000000000a2', 'fan211', 'Fan', true),
  ('f2110000-0000-0000-0000-0000000000c3', 'f2110000-0000-0000-0000-0000000000a3', 'pend211', 'Pending', true),
  ('f2110000-0000-0000-0000-0000000000c4', 'f2110000-0000-0000-0000-0000000000a4', 'ment211', 'Mentioned', true),
  ('f2110000-0000-0000-0000-0000000000c5', 'f2110000-0000-0000-0000-0000000000a5', 'stranger211', 'Stranger', true);
INSERT INTO public.profiles (id, username, display_name, domain, is_local, federated_id, inbox_url) VALUES
  ('f2110000-0000-0000-0000-0000000000c6', 'far211', 'Far', 'far211.example', false,
   'https://far211.example/users/far211', 'https://far211.example/users/far211/inbox');
INSERT INTO public.profiles (username, is_local)
SELECT 'crowd211_' || g, true FROM generate_series(1, 40) g;

INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f2110000-0000-0000-0000-0000000000c2', 'f2110000-0000-0000-0000-0000000000c1', 'accepted'),
  ('f2110000-0000-0000-0000-0000000000c3', 'f2110000-0000-0000-0000-0000000000c1', 'pending'),
  ('f2110000-0000-0000-0000-0000000000c2', 'f2110000-0000-0000-0000-0000000000c6', 'accepted');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id) VALUES
  ('f2113000-0000-0000-0000-000000000001', 'f2110000-0000-0000-0000-0000000000c6',
   '[{"type":"text","text":"from far away"}]', 'public', false, 'https://far211.example/notes/1');
INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('f2113000-0000-0000-0000-000000000002', 'f2110000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"to everyone"}]', 'public'),
  ('f2113000-0000-0000-0000-000000000003', 'f2110000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"to followers and "},{"type":"mention","userId":"f2110000-0000-0000-0000-0000000000c4","username":"ment211"}]', 'followers'),
  ('f2113000-0000-0000-0000-000000000004', 'f2110000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"only to "},{"type":"mention","userId":"f2110000-0000-0000-0000-0000000000c4","username":"ment211"}]', 'direct');

-- Writes ----------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM public.timeline_entries
            WHERE post_id IN ('f2113000-0000-0000-0000-000000000001', 'f2113000-0000-0000-0000-000000000002',
                              'f2113000-0000-0000-0000-000000000003', 'f2113000-0000-0000-0000-000000000004')
              AND timeline_type IS DISTINCT FROM 'home'), 0,
          'no post writes an entry of any type but home');
SELECT set_eq(
    $q$SELECT user_id FROM public.timeline_entries WHERE post_id = 'f2113000-0000-0000-0000-000000000001'$q$,
    $q$VALUES ('f2110000-0000-0000-0000-0000000000c2'::uuid)$q$,
    'a federated public post enters the home timeline of its local follower and no one else');
SELECT set_eq(
    $q$SELECT user_id FROM public.timeline_entries WHERE post_id = 'f2113000-0000-0000-0000-000000000002'$q$,
    $q$VALUES ('f2110000-0000-0000-0000-0000000000c1'::uuid), ('f2110000-0000-0000-0000-0000000000c2'),
              ('f2110000-0000-0000-0000-0000000000c3')$q$,
    'a local public post enters the timelines of its author and its accepted and pending followers');
SELECT is((SELECT count(*)::int FROM public.timeline_entries WHERE post_id = 'f2113000-0000-0000-0000-000000000002'),
          3, 'a public post costs one row per follower plus its author, whatever the number of local profiles');
SELECT set_eq(
    $q$SELECT user_id FROM public.timeline_entries WHERE post_id = 'f2113000-0000-0000-0000-000000000003'$q$,
    $q$VALUES ('f2110000-0000-0000-0000-0000000000c1'::uuid), ('f2110000-0000-0000-0000-0000000000c2')$q$,
    'a followers-only post enters the timelines of its author and accepted followers');
SELECT set_eq(
    $q$SELECT user_id FROM public.timeline_entries WHERE post_id = 'f2113000-0000-0000-0000-000000000004'$q$,
    $q$VALUES ('f2110000-0000-0000-0000-0000000000c1'::uuid)$q$,
    'a direct post enters its author''s timeline only');
SELECT is((SELECT count(*)::int FROM public.timeline_entries te
             JOIN public.profiles p ON p.id = te.user_id
            WHERE p.username LIKE 'crowd211\_%' OR p.username = 'stranger211'), 0,
          'local profiles with no follow get no entry');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE topic = 'user:f2110000-0000-0000-0000-0000000000c2'
                     AND payload->>'type' = 'home_feed:new_post'
                     AND payload->>'post_id' = 'f2113000-0000-0000-0000-000000000001'),
          'the home entry pushes home_feed:new_post to the follower''s user channel');
SELECT ok(NOT has_function_privilege('anon', 'public.create_comprehensive_timeline_entries()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.create_comprehensive_timeline_entries()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.create_comprehensive_timeline_entries()', 'EXECUTE'),
          'the trigger function is executable by service_role only');

-- Report visibility -----------------------------------------------------------
-- create_report admits the author, public and unlisted posts, accepted followers of a
-- followers-only post, a holder of a timeline entry, and a mentioned account.
SELECT tests.authenticate_as('f2110000-0000-0000-0000-0000000000a5');
SELECT isnt(public.create_report('post', p_reported_post_id => 'f2113000-0000-0000-0000-000000000001', p_reason => 'spam'),
            NULL, 'a federated public post is reportable by a local account with no timeline entry for it');
SELECT throws_ok($q$SELECT public.create_report('post', p_reported_post_id => 'f2113000-0000-0000-0000-000000000003')$q$,
                 'P0002', 'Post not found', 'a stranger cannot report a followers-only post');
SELECT throws_ok($q$SELECT public.create_report('post', p_reported_post_id => 'f2113000-0000-0000-0000-000000000004')$q$,
                 'P0002', 'Post not found', 'a stranger cannot report a direct post');

SELECT tests.authenticate_as('f2110000-0000-0000-0000-0000000000a2');
SELECT isnt(public.create_report('post', p_reported_post_id => 'f2113000-0000-0000-0000-000000000003', p_reason => 'spam'),
            NULL, 'an accepted follower reports a followers-only post');
SELECT throws_ok($q$SELECT public.create_report('post', p_reported_post_id => 'f2113000-0000-0000-0000-000000000004')$q$,
                 'P0002', 'Post not found', 'a follower cannot report a direct post that does not name them');

SELECT tests.authenticate_as('f2110000-0000-0000-0000-0000000000a3');
SELECT throws_ok($q$SELECT public.create_report('post', p_reported_post_id => 'f2113000-0000-0000-0000-000000000003')$q$,
                 'P0002', 'Post not found', 'a pending follower cannot report a followers-only post');

SELECT tests.authenticate_as('f2110000-0000-0000-0000-0000000000a4');
SELECT isnt(public.create_report('post', p_reported_post_id => 'f2113000-0000-0000-0000-000000000003', p_reason => 'spam'),
            NULL, 'a mentioned non-follower reports a followers-only post');
SELECT isnt(public.create_report('post', p_reported_post_id => 'f2113000-0000-0000-0000-000000000004', p_reason => 'spam'),
            NULL, 'the recipient of a direct post reports it');
SELECT tests.clear_authentication();

-- Unfollowing takes the home entries; the follow check goes with the follow.
DELETE FROM public.follows
 WHERE follower_id = 'f2110000-0000-0000-0000-0000000000c2'
   AND following_id = 'f2110000-0000-0000-0000-0000000000c1';
SELECT tests.authenticate_as('f2110000-0000-0000-0000-0000000000a2');
SELECT throws_ok($q$SELECT public.create_report('post', p_reported_post_id => 'f2113000-0000-0000-0000-000000000003')$q$,
                 'P0002', 'Post not found', 'a former follower cannot report a followers-only post');
SELECT tests.clear_authentication();

-- Negative control ------------------------------------------------------------
-- The body 20261031600001 replaces, as the baseline defines it. Rolled back with the file.
CREATE OR REPLACE FUNCTION public.create_comprehensive_timeline_entries()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
    IF COALESCE(NEW.is_deleted, false) THEN
        RETURN NEW;
    END IF;
    IF NEW.is_local THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    IF NEW.visibility = 'public' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT f.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM follows f
        JOIN profiles p ON f.follower_id = p.id
        WHERE f.following_id = NEW.author_id
          AND f.status IN ('accepted', 'pending')
          AND p.is_local = true
          AND f.follower_id != NEW.author_id
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    IF NEW.visibility = 'public' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT p.id, NEW.id, 'public', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM profiles p
        WHERE p.is_local = true
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$fn$;

INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('f2113000-0000-0000-0000-000000000005', 'f2110000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"old fan-out"}]', 'public');
SELECT is((SELECT count(*)::int FROM public.timeline_entries
            WHERE post_id = 'f2113000-0000-0000-0000-000000000005' AND timeline_type IS DISTINCT FROM 'home'),
          (SELECT count(*)::int FROM public.profiles WHERE is_local),
          'negative control: the replaced body writes one public entry per local profile, which the first assertion counts');

SELECT * FROM finish();
ROLLBACK;
