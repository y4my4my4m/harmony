-- user_servers_select_co_members and posts_select_public after
-- 20260930000006_rls_set_based_membership_and_blocks.sql.
--
-- The cells pin each branch of both predicates. The final section reinstalls the baseline
-- predicates, which call current_user_is_member_of_server(), is_blocked_by() and
-- has_blocked() per row, and asserts that every actor sees the same rows under both.
--
-- Fixture roles: alice owns server_1 and is instance admin; bob is an accepted member;
-- mallory belongs to nothing; banned has status 'banned' on server_1.
--
-- Local roles:
--   pending    status 'pending' on server_1
--   outsider   accepted on server_2 only
--   xavier     author of one post per visibility; on server_2 with a NULL status
--   rblocked   blocked by xavier, follows xavier (accepted)
--   rblocker   has blocked xavier, follows xavier (accepted)
--   follower   follows xavier (accepted)
--   pendfollow follows xavier (pending)
--   expired    blocked by xavier with block_type 'posts_only' and a past expires_at
--   noprofile  an auth user with no profile row

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(31);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT ('f3700000-0000-0000-0000-0000000000' || k)::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'rls37-' || k || '@test.local'
  FROM unnest(ARRAY['a1','a2','a3','a4','a5','a6','a7','a8','a9']) k;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT ('f3710000-0000-0000-0000-0000000000' || k)::uuid,
       ('f3700000-0000-0000-0000-0000000000' || k)::uuid, n, n, true
  FROM (VALUES ('a1', 'pending'), ('a2', 'outsider'), ('a3', 'xavier'), ('a4', 'rblocked'),
               ('a5', 'rblocker'), ('a6', 'follower'), ('a7', 'pendfollow'),
               ('a8', 'expired')) v(k, n);

INSERT INTO public.servers (id, name, owner)
VALUES ('f3720000-0000-0000-0000-000000000002', 'Second Server',
        'f3710000-0000-0000-0000-0000000000a2');

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f3710000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'pending'),
  ('f3710000-0000-0000-0000-0000000000a2', 'f3720000-0000-0000-0000-000000000002', 'accepted'),
  ('f3710000-0000-0000-0000-0000000000a3', 'f3720000-0000-0000-0000-000000000002', NULL);

INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f3710000-0000-0000-0000-0000000000a4', 'f3710000-0000-0000-0000-0000000000a3', 'accepted'),
  ('f3710000-0000-0000-0000-0000000000a5', 'f3710000-0000-0000-0000-0000000000a3', 'accepted'),
  ('f3710000-0000-0000-0000-0000000000a6', 'f3710000-0000-0000-0000-0000000000a3', 'accepted'),
  ('f3710000-0000-0000-0000-0000000000a7', 'f3710000-0000-0000-0000-0000000000a3', 'pending'),
  ('f3710000-0000-0000-0000-0000000000a8', 'f3710000-0000-0000-0000-0000000000a3', 'accepted');

INSERT INTO public.user_blocks (blocker_id, blocked_user_id, block_type, expires_at) VALUES
  ('f3710000-0000-0000-0000-0000000000a3', 'f3710000-0000-0000-0000-0000000000a4', 'full', NULL),
  ('f3710000-0000-0000-0000-0000000000a5', 'f3710000-0000-0000-0000-0000000000a3', 'full', NULL),
  ('f3710000-0000-0000-0000-0000000000a3', 'f3710000-0000-0000-0000-0000000000a8', 'posts_only',
   now() - interval '1 day');

INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('f3730000-0000-0000-0000-000000000001', 'f3710000-0000-0000-0000-0000000000a3',
   '[{"type":"text","text":"x public"}]', 'public'),
  ('f3730000-0000-0000-0000-000000000002', 'f3710000-0000-0000-0000-0000000000a3',
   '[{"type":"text","text":"x unlisted"}]', 'unlisted'),
  ('f3730000-0000-0000-0000-000000000003', 'f3710000-0000-0000-0000-0000000000a3',
   '[{"type":"text","text":"x followers"}]', 'followers'),
  ('f3730000-0000-0000-0000-000000000004', 'f3710000-0000-0000-0000-0000000000a3',
   '[{"type":"text","text":"x direct"}]', 'direct'),
  ('f3730000-0000-0000-0000-000000000005', 'f3710000-0000-0000-0000-0000000000a4',
   '[{"type":"text","text":"rblocked public"}]', 'public'),
  ('f3730000-0000-0000-0000-000000000006', 'f3710000-0000-0000-0000-0000000000a5',
   '[{"type":"text","text":"rblocker public"}]', 'public'),
  ('f3730000-0000-0000-0000-000000000007', 'f3710000-0000-0000-0000-0000000000a3',
   '[{"type":"text","text":"x null visibility"}]', NULL);

-- USER_SERVERS ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_eq(
    $q$SELECT user_id FROM public.user_servers
        WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
    $q$VALUES ('11111111-0000-0000-0000-000000000001'::uuid),
              ('22222222-0000-0000-0000-000000000002'::uuid),
              ('44444444-0000-0000-0000-000000000004'::uuid),
              ('f3710000-0000-0000-0000-0000000000a1'::uuid)$q$,
    'an accepted member reads every membership row of their server, any status');
SELECT is_empty(
    $q$SELECT 1 FROM public.user_servers
        WHERE server_id = 'f3720000-0000-0000-0000-000000000002'$q$,
    'an accepted member reads no membership row of a server they are not in');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty($q$SELECT 1 FROM public.user_servers$q$,
    'a user in no server reads no membership row');

-- current_user_is_member_of_server() tests row existence, not status. Pending and banned
-- rows therefore still expose the member list, and the rewrite keeps that.
SELECT tests.authenticate_as('f3700000-0000-0000-0000-0000000000a1');
SELECT is((SELECT count(*)::int FROM public.user_servers
            WHERE server_id = '55555555-0000-0000-0000-000000000005'), 4,
          'a pending member reads the member list, as under the baseline predicate');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is((SELECT count(*)::int FROM public.user_servers
            WHERE server_id = '55555555-0000-0000-0000-000000000005'), 4,
          'a banned member reads the member list, as under the baseline predicate');

SELECT tests.authenticate_as('f3700000-0000-0000-0000-0000000000a3');
SELECT set_eq(
    $q$SELECT user_id FROM public.user_servers$q$,
    $q$VALUES ('f3710000-0000-0000-0000-0000000000a2'::uuid),
              ('f3710000-0000-0000-0000-0000000000a3'::uuid)$q$,
    'a membership with a NULL status still counts as membership');

SELECT set_eq($q$SELECT public.current_user_server_ids()$q$,
              $q$VALUES ('f3720000-0000-0000-0000-000000000002'::uuid)$q$,
              'current_user_server_ids returns the caller''s servers');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.user_servers
        WHERE server_id = 'f3720000-0000-0000-0000-000000000002'$q$,
    'an instance admin reads memberships of a server they are not in');

SELECT tests.authenticate_as('f3700000-0000-0000-0000-0000000000a9');
SELECT is_empty($q$SELECT 1 FROM public.user_servers$q$,
    'an authenticated caller with no profile reads no membership row');
SELECT is_empty($q$SELECT public.current_user_server_ids()$q$,
    'current_user_server_ids is empty without a profile');

SELECT tests.authenticate_as_anon();
SELECT is_empty($q$SELECT 1 FROM public.user_servers$q$,
    'anon reads no membership row');
SELECT throws_ok($q$SELECT public.current_user_server_ids()$q$,
    '42501'::char(5), NULL,
    'anon cannot execute current_user_server_ids');

-- POSTS ----------------------------------------------------------------------------------
-- xavier has blocked rblocked and expired, and is blocked by rblocker.
SELECT tests.authenticate_as('f3700000-0000-0000-0000-0000000000a3');
SELECT set_eq(
    $q$SELECT id FROM public.posts WHERE author_id = 'f3710000-0000-0000-0000-0000000000a3'$q$,
    $q$SELECT ('f3730000-0000-0000-0000-00000000000' || k)::uuid
         FROM unnest(ARRAY['1','2','3','4','7']) k$q$,
    'an author reads every own post, direct and NULL visibility included, blocks notwithstanding');
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f3730000-0000-0000-0000-000000000005'$q$,
    'a blocker does not read the public post of the user they blocked');
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f3730000-0000-0000-0000-000000000006'$q$,
    'a blocked user does not read the public post of the user who blocked them');
SELECT set_eq($q$SELECT public.current_user_block_peer_ids()$q$,
              $q$VALUES ('f3710000-0000-0000-0000-0000000000a4'::uuid),
                        ('f3710000-0000-0000-0000-0000000000a5'::uuid),
                        ('f3710000-0000-0000-0000-0000000000a8'::uuid)$q$,
              'current_user_block_peer_ids returns both directions, block_type and expiry ignored');

SELECT tests.authenticate_as('f3700000-0000-0000-0000-0000000000a4');
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE author_id = 'f3710000-0000-0000-0000-0000000000a3'$q$,
    'a reader blocked by the author reads none of the author''s posts despite an accepted follow');

SELECT tests.authenticate_as('f3700000-0000-0000-0000-0000000000a5');
SELECT is_empty(
    $q$SELECT 1 FROM public.posts WHERE author_id = 'f3710000-0000-0000-0000-0000000000a3'$q$,
    'a reader who blocked the author reads none of the author''s posts despite an accepted follow');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.posts WHERE id = 'f3730000-0000-0000-0000-000000000006'$q$,
    'a reader who blocked someone still reads their own post');

SELECT tests.authenticate_as('f3700000-0000-0000-0000-0000000000a6');
SELECT set_eq(
    $q$SELECT id FROM public.posts WHERE author_id = 'f3710000-0000-0000-0000-0000000000a3'$q$,
    $q$SELECT ('f3730000-0000-0000-0000-00000000000' || k)::uuid
         FROM unnest(ARRAY['1','2','3']) k$q$,
    'an accepted follower reads public, unlisted and followers-only posts, not direct');

SELECT tests.authenticate_as('f3700000-0000-0000-0000-0000000000a7');
SELECT set_eq(
    $q$SELECT id FROM public.posts WHERE author_id = 'f3710000-0000-0000-0000-0000000000a3'$q$,
    $q$SELECT ('f3730000-0000-0000-0000-00000000000' || k)::uuid
         FROM unnest(ARRAY['1','2']) k$q$,
    'a pending follower reads public and unlisted posts only');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT set_eq(
    $q$SELECT id FROM public.posts WHERE author_id = 'f3710000-0000-0000-0000-0000000000a3'$q$,
    $q$SELECT ('f3730000-0000-0000-0000-00000000000' || k)::uuid
         FROM unnest(ARRAY['1','2']) k$q$,
    'a non-follower reads public and unlisted posts only');
SELECT set_eq(
    $q$SELECT id FROM public.posts
        WHERE id IN ('f3730000-0000-0000-0000-000000000005',
                     'f3730000-0000-0000-0000-000000000006')$q$,
    $q$VALUES ('f3730000-0000-0000-0000-000000000005'::uuid),
              ('f3730000-0000-0000-0000-000000000006'::uuid)$q$,
    'a user outside every block reads both blocked parties'' public posts');
SELECT is_empty($q$SELECT public.current_user_block_peer_ids()$q$,
    'current_user_block_peer_ids is empty for a user with no blocks');

SELECT tests.authenticate_as('f3700000-0000-0000-0000-0000000000a9');
SELECT set_eq(
    $q$SELECT id FROM public.posts WHERE author_id = 'f3710000-0000-0000-0000-0000000000a3'$q$,
    $q$SELECT ('f3730000-0000-0000-0000-00000000000' || k)::uuid
         FROM unnest(ARRAY['1','2']) k$q$,
    'an authenticated caller with no profile reads public and unlisted posts only');

SELECT tests.authenticate_as_anon();
SELECT set_eq(
    $q$SELECT id FROM public.posts$q$,
    $q$SELECT ('f3730000-0000-0000-0000-00000000000' || k)::uuid
         FROM unnest(ARRAY['1','2','5','6']) k$q$,
    'anon reads public and unlisted posts only');
SELECT is_empty($q$SELECT public.current_user_block_peer_ids()$q$,
    'anon executes current_user_block_peer_ids and gets an empty set');

-- EQUIVALENCE WITH THE BASELINE PREDICATES -----------------------------------------------
SELECT tests.clear_authentication();

CREATE TEMP TABLE rls37_seen (rule text, actor text, tbl text, row_id uuid) ON COMMIT DROP;
GRANT INSERT, SELECT ON rls37_seen TO authenticated, anon;

CREATE FUNCTION pg_temp.rls37_capture(p_rule text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    a record;
BEGIN
    FOR a IN
        SELECT * FROM (VALUES
            ('anon',       NULL::uuid),
            ('alice',      'aaaaaaaa-0000-0000-0000-000000000001'::uuid),
            ('bob',        'bbbbbbbb-0000-0000-0000-000000000002'::uuid),
            ('mallory',    'cccccccc-0000-0000-0000-000000000003'::uuid),
            ('banned',     'dddddddd-0000-0000-0000-000000000004'::uuid),
            ('pending',    'f3700000-0000-0000-0000-0000000000a1'::uuid),
            ('outsider',   'f3700000-0000-0000-0000-0000000000a2'::uuid),
            ('xavier',     'f3700000-0000-0000-0000-0000000000a3'::uuid),
            ('rblocked',   'f3700000-0000-0000-0000-0000000000a4'::uuid),
            ('rblocker',   'f3700000-0000-0000-0000-0000000000a5'::uuid),
            ('follower',   'f3700000-0000-0000-0000-0000000000a6'::uuid),
            ('pendfollow', 'f3700000-0000-0000-0000-0000000000a7'::uuid),
            ('expired',    'f3700000-0000-0000-0000-0000000000a8'::uuid),
            ('noprofile',  'f3700000-0000-0000-0000-0000000000a9'::uuid)) v(actor, auth_id)
    LOOP
        IF a.auth_id IS NULL THEN
            PERFORM tests.authenticate_as_anon();
        ELSE
            PERFORM tests.authenticate_as(a.auth_id);
        END IF;
        INSERT INTO rls37_seen SELECT p_rule, a.actor, 'posts', id FROM public.posts;
        INSERT INTO rls37_seen SELECT p_rule, a.actor, 'user_servers', id FROM public.user_servers;
        PERFORM tests.clear_authentication();
    END LOOP;
END;
$$;

SELECT pg_temp.rls37_capture('new');

-- The predicates as 20260101000000_baseline.sql creates them.
ALTER POLICY "user_servers_select_co_members" ON public.user_servers
    USING (
        user_id = ( SELECT public.get_current_profile_id() )
        OR public.current_user_is_member_of_server(server_id)
        OR ( SELECT public.is_current_user_admin() )
    );

ALTER POLICY "posts_select_public" ON public.posts
    USING (
        author_id = ( SELECT public.get_current_profile_id() )
        OR (
            NOT public.is_blocked_by(author_id)
            AND NOT public.has_blocked(author_id)
            AND (
                visibility IN ('public', 'unlisted')
                OR (visibility = 'followers' AND EXISTS (
                    SELECT 1 FROM public.follows
                    WHERE follower_id = ( SELECT public.get_current_profile_id() )
                    AND following_id = posts.author_id
                    AND status = 'accepted'
                ))
                OR (visibility = 'direct' AND EXISTS (
                    SELECT 1 WHERE author_id = ( SELECT public.get_current_profile_id() )
                ))
            )
        )
    );

SELECT pg_temp.rls37_capture('old');

-- A capture that failed to switch role would read every row as postgres under both
-- predicates and compare equal. Per-actor counts that differ show the switch took effect.
SELECT cmp_ok(
    (SELECT count(DISTINCT n) FROM (SELECT count(*) n FROM rls37_seen
                                     WHERE rule = 'old' AND tbl = 'posts'
                                     GROUP BY actor) c)::int,
    '>=', 3,
    'the baseline capture reads a different posts count across actors');
SELECT cmp_ok(
    (SELECT count(DISTINCT n) FROM (SELECT count(*) n FROM rls37_seen
                                     WHERE rule = 'old' AND tbl = 'user_servers'
                                     GROUP BY actor) c)::int,
    '>=', 3,
    'the baseline capture reads a different membership count across actors');

SELECT is_empty(
    $q$(SELECT actor, row_id FROM rls37_seen WHERE rule = 'new' AND tbl = 'posts'
        EXCEPT SELECT actor, row_id FROM rls37_seen WHERE rule = 'old' AND tbl = 'posts')
       UNION ALL
       (SELECT actor, row_id FROM rls37_seen WHERE rule = 'old' AND tbl = 'posts'
        EXCEPT SELECT actor, row_id FROM rls37_seen WHERE rule = 'new' AND tbl = 'posts')$q$,
    'posts_select_public admits the same rows as the baseline predicate for every actor');
SELECT is_empty(
    $q$(SELECT actor, row_id FROM rls37_seen WHERE rule = 'new' AND tbl = 'user_servers'
        EXCEPT SELECT actor, row_id FROM rls37_seen WHERE rule = 'old' AND tbl = 'user_servers')
       UNION ALL
       (SELECT actor, row_id FROM rls37_seen WHERE rule = 'old' AND tbl = 'user_servers'
        EXCEPT SELECT actor, row_id FROM rls37_seen WHERE rule = 'new' AND tbl = 'user_servers')$q$,
    'user_servers_select_co_members admits the same rows as the baseline predicate for every actor');

SELECT * FROM finish();
ROLLBACK;
