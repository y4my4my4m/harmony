-- Joins, server visibility, boosts and replies, display-name emoji, channel placement and
-- system-row removal after 20261005650001_joins_visibility_boosts.sql.
--
-- Fixture server_1 (private): alice owns it, bob is a member, mallory is not, banned holds
-- a banned status row. Added here:
--   open      public server owned by alice; second category and channel for placement cases
--   bob's posts   public, followers-only (alice follows bob), direct
--   blob      instance custom emoji with an image URL

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(83);

INSERT INTO public.servers (id, name, owner, public) VALUES
  ('f5b10000-0000-0000-0000-000000000001', 'Open', '11111111-0000-0000-0000-000000000001', true);
INSERT INTO public.user_servers (server_id, user_id, status) VALUES
  ('f5b10000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'accepted');
-- Through ban_server_member: on production server_bans belongs to supabase_admin and
-- postgres holds SELECT only.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.ban_server_member('f5b10000-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000004', 'test');
SELECT tests.clear_authentication();

INSERT INTO public.channel_categories (id, server_id, name) VALUES
  ('f5b20000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'Private stuff'),
  ('f5b20000-0000-0000-0000-000000000002', 'f5b10000-0000-0000-0000-000000000001', 'Open stuff');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f5b30000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'second', 0);

INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'accepted');
INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('f5b40000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"bob public"}]', 'public'),
  ('f5b40000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"bob followers"}]', 'followers'),
  ('f5b40000-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"bob direct"}]', 'direct');

INSERT INTO public.emojis (id, name, url, scope) VALUES
  ('f5b50000-0000-0000-0000-000000000001', 'blob', 'https://localhost/emoji/blob.png', 'instance');

INSERT INTO public.invites (code, server_id, created_by, max_uses, uses, used, expires_at) VALUES
  ('F5BEXPIRED', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', NULL, 0, false, now() - interval '1 day'),
  ('F5BREVOKED', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', NULL, 0, true, NULL),
  ('F5BSPENT',   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 1, 1, true, NULL);

INSERT INTO public.messages (id, channel_id, user_id, content, is_system, metadata) VALUES
  ('f5b60000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"has joined the server"}]', true,
   '{"type":"member_join"}'),
  ('f5b60000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"has joined the server"}]', true,
   '{"type":"member_join"}');
INSERT INTO public.messages (id, conversation_id, user_id, content, is_system, metadata) VALUES
  ('f5b60000-0000-0000-0000-000000000003', '77777777-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"started a call"}]', true,
   '{"type":"call_started","call_type":"voice"}');

-- Rows the current role reads; a table without a SELECT grant (production revokes some
-- from anon) reads as none.
CREATE FUNCTION pg_temp.readable_rows(p_query text) RETURNS bigint LANGUAGE plpgsql AS $fn$
DECLARE
    n bigint;
BEGIN
    EXECUTE 'SELECT count(*) FROM (' || p_query || ') q' INTO n;
    RETURN n;
EXCEPTION WHEN insufficient_privilege THEN
    RETURN 0;
END;
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.readable_rows(text) TO anon, authenticated;

-- Visibility ----------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty($q$SELECT id FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
                'a non-member does not read a private server');
SELECT isnt_empty($q$SELECT id FROM public.servers WHERE id = 'f5b10000-0000-0000-0000-000000000001'$q$,
                  'a non-member reads a public server');
SELECT is_empty($q$SELECT id FROM public.channel_categories WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
                'a non-member reads no category of a private server');
SELECT is_empty($q$SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
                'a non-member reads no role of a private server');
SELECT is_empty($q$SELECT user_id FROM public.user_roles WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
                'a non-member reads no role assignment, so no member list');
SELECT is((SELECT member_count FROM public.get_server_member_counts(ARRAY['55555555-0000-0000-0000-000000000005'::uuid])),
          0::bigint, 'a non-member counts no members of a private server');
SELECT ok((SELECT member_count FROM public.get_server_member_counts(ARRAY['f5b10000-0000-0000-0000-000000000001'::uuid])) > 0,
          'a non-member counts the members of a public server');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT isnt_empty($q$SELECT id FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
                  'a member reads their private server');
SELECT isnt_empty($q$SELECT id FROM public.channel_categories WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
                  'a member reads its categories');
SELECT isnt_empty($q$SELECT user_id FROM public.user_roles WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
                  'a member reads its role assignments');

SELECT tests.authenticate_as_anon();
SELECT is_empty($q$SELECT id FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
                'anon does not read a private server');
SELECT isnt_empty($q$SELECT id FROM public.servers WHERE id = 'f5b10000-0000-0000-0000-000000000001'$q$,
                  'anon reads a public server');
SELECT is(pg_temp.readable_rows($q$SELECT id FROM public.server_roles$q$), 0::bigint, 'anon reads no roles');

-- Direct membership inserts -------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$INSERT INTO public.user_servers (server_id, user_id) VALUES
       ('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003')$q$,
    '42501', NULL, 'a non-member cannot join a private server by inserting a membership');
SELECT throws_ok(
    $q$INSERT INTO public.user_servers (server_id, user_id) VALUES
       ('f5b10000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003')$q$,
    '42501', NULL, 'a public server is not joined by direct insert either');

-- join_public_server --------------------------------------------------------------------
SELECT throws_ok(
    $q$SELECT public.join_public_server('55555555-0000-0000-0000-000000000005')$q$,
    '42501', NULL, 'join_public_server refuses a private server');
SELECT is(public.join_public_server('f5b10000-0000-0000-0000-000000000001') ->> 'joined', 'true',
          'join_public_server joins a public server');
SELECT is(public.join_public_server('f5b10000-0000-0000-0000-000000000001') ->> 'joined', 'false',
          'a second join reports the existing membership');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok(
    $q$SELECT public.join_public_server('f5b10000-0000-0000-0000-000000000001')$q$,
    '42501', NULL, 'a banned user cannot join a public server');

-- Invites ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$INSERT INTO public.invites (code, server_id, created_by)
       VALUES ('F5BMALLORY', '55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003')$q$,
    '42501', NULL, 'a non-member cannot mint an invite');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok(
    $q$INSERT INTO public.invites (code, server_id, created_by)
       VALUES ('F5BBANNED', '55555555-0000-0000-0000-000000000005', '44444444-0000-0000-0000-000000000004')$q$,
    '42501', NULL, 'a banned-status row does not mint invites');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO public.invites (code, server_id, created_by, max_uses, uses, used)
       VALUES ('F5BTWICE', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 2, 99, true)$q$,
    'the owner mints an invite');
SELECT throws_ok(
    $q$UPDATE public.invites SET uses = 0, max_uses = 1000 WHERE code = 'F5BTWICE'$q$,
    '42501', NULL, 'the creator cannot reset or raise an invite''s limit');

SELECT tests.clear_authentication();
SELECT results_eq($q$SELECT uses, used FROM public.invites WHERE code = 'F5BTWICE'$q$,
                  $q$VALUES (0, false)$q$, 'a new invite starts unused whatever the client sent');

SELECT tests.authenticate_as_anon();
SELECT results_eq(
    $q$SELECT p ->> 'status', p ->> 'name', (p ->> 'member_count')::int, (p ->> 'is_member')::boolean
         FROM public.get_invite_preview('F5BTWICE') p$q$,
    $q$VALUES ('valid'::text, 'Test Server'::text, 2, false)$q$,
    'anon previews the server card of a valid invite');
SELECT is((public.get_invite_preview('F5BEXPIRED')) ->> 'status', 'expired', 'an expired invite previews as expired');
SELECT is((public.get_invite_preview('F5BREVOKED')) ->> 'status', 'revoked', 'a revoked invite previews as revoked');
SELECT is((public.get_invite_preview('F5BSPENT')) ->> 'status', 'exhausted', 'a spent invite previews as exhausted');
SELECT is(public.get_invite_preview('F5BEXPIRED') ->> 'name', NULL, 'an invalid invite reveals no server');
SELECT is((public.get_invite_preview('NOPE')) ->> 'status', 'not_found', 'an unknown code previews as not found');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.redeem_invite('NOPE')$q$, 'P0002', NULL, 'an unknown code is refused');
SELECT throws_ok($q$SELECT public.redeem_invite('F5BEXPIRED')$q$, 'P0001', NULL, 'an expired invite is refused');
SELECT throws_ok($q$SELECT public.redeem_invite('F5BREVOKED')$q$, 'P0001', NULL, 'a revoked invite is refused');
SELECT throws_ok($q$SELECT public.redeem_invite('F5BSPENT')$q$, 'P0001', NULL, 'an exhausted invite is refused');
SELECT is(public.redeem_invite('F5BTWICE') ->> 'server_id', '55555555-0000-0000-0000-000000000005',
          'a valid invite joins the private server');
SELECT is(public.redeem_invite('F5BTWICE') ->> 'joined', 'false',
          'redeeming again as a member reports the membership');
SELECT isnt_empty($q$SELECT id FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
                  'the new member reads the server');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($q$SELECT public.redeem_invite('F5BTWICE')$q$, '42501', NULL,
                 'a banned user cannot redeem an invite');

SELECT tests.clear_authentication();
SELECT results_eq($q$SELECT uses, used FROM public.invites WHERE code = 'F5BTWICE'$q$,
                  $q$VALUES (1, false)$q$, 'one redemption counts one use; a repeat counts none');
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f5b70000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tess@test.local'),
  ('f5b70000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'uma@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain) VALUES
  ('f5b70000-0000-0000-0000-0000000000c1', 'f5b70000-0000-0000-0000-0000000000a1', 'tess', 'Tess', true, 'localhost'),
  ('f5b70000-0000-0000-0000-0000000000c2', 'f5b70000-0000-0000-0000-0000000000a2', 'uma', 'Uma', true, 'localhost');
SELECT tests.authenticate_as('f5b70000-0000-0000-0000-0000000000a1');
SELECT lives_ok($q$SELECT public.redeem_invite('F5BTWICE')$q$, 'the second use of a two-use invite joins');
SELECT tests.authenticate_as('f5b70000-0000-0000-0000-0000000000a2');
SELECT throws_ok($q$SELECT public.redeem_invite('F5BTWICE')$q$, 'P0001', NULL, 'a third use is refused');
SELECT tests.clear_authentication();
SELECT results_eq($q$SELECT uses, used FROM public.invites WHERE code = 'F5BTWICE'$q$,
                  $q$VALUES (2, true)$q$, 'the invite is marked used at its limit');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$UPDATE public.invites SET used = true WHERE code = 'F5BEXPIRED'$q$,
                'the creator revokes an invite');
SELECT throws_ok($q$UPDATE public.invites SET used = false WHERE code = 'F5BREVOKED'$q$, '42501', NULL,
                 'the creator cannot restore a revoked invite');

SELECT ok(NOT has_function_privilege('authenticated', 'public.consume_invite(uuid,text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.lookup_invite_by_code(text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.consume_invite(uuid,text)', 'EXECUTE'),
          'invite internals are service_role only');

-- Federation joins keep working --------------------------------------------------------
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
INSERT INTO public.user_servers (server_id, user_id, status) VALUES
  ('55555555-0000-0000-0000-000000000005', 'f5b70000-0000-0000-0000-0000000000c2', 'pending');
RESET ROLE;
SELECT is((SELECT status FROM public.user_servers
            WHERE server_id = '55555555-0000-0000-0000-000000000005'
              AND user_id = 'f5b70000-0000-0000-0000-0000000000c2'),
          'pending', 'the service role inserts a pending federated membership');

-- Server creation -------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$INSERT INTO public.servers (id, name, owner) VALUES
       ('f5b10000-0000-0000-0000-000000000002', 'Bob HQ', '22222222-0000-0000-0000-000000000002')$q$,
    'a user creates a server');
SELECT results_eq(
    $q$SELECT status FROM public.user_servers
        WHERE server_id = 'f5b10000-0000-0000-0000-000000000002' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
    $q$VALUES ('accepted'::text)$q$, 'the owner''s membership is created with the server');
SELECT throws_ok(
    $q$INSERT INTO public.user_servers (server_id, user_id) VALUES
       ('f5b10000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002')$q$,
    '23505', NULL, 'an older client''s owner insert reads as already present');
SELECT throws_ok(
    $q$INSERT INTO public.user_servers (server_id, user_id) VALUES
       ('f5b10000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003')$q$,
    '42501', NULL, 'an owner cannot insert someone else''s membership');

-- Boosts, quotes, replies -------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok(
    $q$INSERT INTO public.posts (id, author_id, content, visibility, metadata, reblog, reblog_author, ap_type)
       VALUES ('f5b80000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003',
               '[{"type":"text","text":"bob said I am great"}]', 'public',
               '{"reblog_of":"f5b40000-0000-0000-0000-000000000001","original_author":"x"}',
               '{"id":"f5b40000-0000-0000-0000-000000000001","content":[{"type":"text","text":"bob said I am great"}]}',
               '{"username":"bob"}', 'Announce')$q$,
    'a boost of a public post is accepted');
SELECT results_eq(
    $q$SELECT content->0->>'text', reblog->'content'->0->>'text', reblog_author->>'username',
              metadata->>'original_author', ap_type
         FROM public.posts WHERE id = 'f5b80000-0000-0000-0000-000000000001'$q$,
    $q$VALUES ('bob public'::text, 'bob public'::text, 'bob'::text,
               '22222222-0000-0000-0000-000000000002'::text, 'Announce'::text)$q$,
    'the boost carries the original''s words, not the client''s');
SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content, visibility, metadata)
       VALUES ('33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"x"}]', 'public',
               '{"reblog_of":"f5b40000-0000-0000-0000-000000000001"}')$q$,
    '23505', NULL, 'a second boost of one post is refused');
SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content, visibility, metadata)
       VALUES ('33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"x"}]', 'public',
               '{"reblog_of":"f5b40000-0000-0000-0000-000000000002"}')$q$,
    'P0002', NULL, 'a followers-only post the caller cannot read is not boosted');
SELECT lives_ok(
    $q$INSERT INTO public.posts (id, author_id, content, visibility, metadata)
       VALUES ('f5b80000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003',
               '[{"type":"text","text":"my take"}]', 'public',
               '{"reblog_of":"f5b40000-0000-0000-0000-000000000001","is_quote":true}')$q$,
    'a quote of a public post is accepted');
SELECT results_eq(
    $q$SELECT content->0->>'text', reblog->'content'->0->>'text', (metadata->>'is_quote')::boolean
         FROM public.posts WHERE id = 'f5b80000-0000-0000-0000-000000000002'$q$,
    $q$VALUES ('my take'::text, 'bob public'::text, true)$q$,
    'a quote keeps the quoter''s words and the original''s snapshot');
SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content, visibility, reblog)
       VALUES ('33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"x"}]', 'public',
               '{"id":"f5b40000-0000-0000-0000-000000000003","content":[{"type":"text","text":"forged"}]}')$q$,
    '42501', NULL, 'a reblog snapshot without reblog_of is refused');
SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content, visibility, in_reply_to)
       VALUES ('33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"x"}]', 'public',
               'f5b40000-0000-0000-0000-000000000003')$q$,
    'P0002', NULL, 'a reply to a direct post the caller cannot read is refused');
SELECT lives_ok(
    $q$INSERT INTO public.posts (id, author_id, content, visibility, in_reply_to, conversation_root_id)
       VALUES ('f5b80000-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000003',
               '[{"type":"text","text":"reply"}]', 'public', 'f5b40000-0000-0000-0000-000000000001',
               'f5b40000-0000-0000-0000-000000000003')$q$,
    'a reply to a readable post is accepted');
SELECT is((SELECT conversation_root_id FROM public.posts WHERE id = 'f5b80000-0000-0000-0000-000000000003'),
          'f5b40000-0000-0000-0000-000000000001'::uuid, 'the reply''s conversation derives from its parent');
SELECT lives_ok(
    $q$UPDATE public.posts SET content = '[{"type":"text","text":"bob said something else"}]'
        WHERE id = 'f5b80000-0000-0000-0000-000000000001'$q$,
    'an edit of a boost runs');
SELECT is((SELECT content->0->>'text' FROM public.posts WHERE id = 'f5b80000-0000-0000-0000-000000000001'),
          'bob public', 'a boost keeps the original''s words');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content, visibility, metadata)
       VALUES ('11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"x"}]', 'public',
               '{"reblog_of":"f5b40000-0000-0000-0000-000000000002"}')$q$,
    '42501', NULL, 'a followers-only post is not boosted even by a follower');

-- Display-name emoji ------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok(
    $q$UPDATE public.profiles
          SET display_name = 'Mal :blob: :nope: :blob:',
              federation_metadata = '{"display_name_emojis":[{"name":"blob","url":"https://evil.test/x.png"},{"name":"nope","url":"https://evil.test/y.png"}]}'
        WHERE id = '33333333-0000-0000-0000-000000000003'$q$,
    'a display-name change runs');
SELECT is((SELECT federation_metadata->'display_name_emojis' FROM public.profiles
            WHERE id = '33333333-0000-0000-0000-000000000003'),
          '[{"id":"f5b50000-0000-0000-0000-000000000001","name":"blob","url":"https://localhost/emoji/blob.png"}]'::jsonb,
          'display-name emoji resolve on the server; client URLs are dropped');
SELECT lives_ok(
    $q$UPDATE public.profiles SET bio = 'hello', federation_metadata = '{"display_name_emojis":[]}'
        WHERE id = '33333333-0000-0000-0000-000000000003'$q$,
    'a bio change runs');
SELECT is((SELECT jsonb_array_length(federation_metadata->'display_name_emojis') FROM public.profiles
            WHERE id = '33333333-0000-0000-0000-000000000003'),
          1, 'federation_metadata stays when the display name does not change');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'allow_custom_emojis_in_display_names';
INSERT INTO public.instance_config (config_key, config_value)
SELECT 'allow_custom_emojis_in_display_names', 'false'
 WHERE NOT EXISTS (SELECT 1 FROM public.instance_config WHERE config_key = 'allow_custom_emojis_in_display_names');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
UPDATE public.profiles SET display_name = 'Mal :blob:' WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT is((SELECT federation_metadata->'display_name_emojis' FROM public.profiles
            WHERE id = '33333333-0000-0000-0000-000000000003'),
          '[]'::jsonb, 'display-name emoji are empty when the instance disallows them');

-- Message replies ---------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, reply_to)
       VALUES ('f5b30000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"x"}]', '88888888-0000-0000-0000-000000000008')$q$,
    '23514', NULL, 'a reply to a message of another channel is refused');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, reply_to)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"x"}]', '99999999-0000-0000-0000-000000000009')$q$,
    '23514', NULL, 'a channel reply to a DM message is refused');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, reply_to)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"x"}]', '88888888-0000-0000-0000-000000000008')$q$,
    'a reply in the same channel is accepted');
SELECT tests.clear_authentication();
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, reply_to)
       VALUES ('f5b30000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"x"}]', '88888888-0000-0000-0000-000000000008')$q$,
    '23514', NULL, 'the reply scope applies to every writer');

-- Channels and categories ---------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$UPDATE public.channels SET server_id = 'f5b10000-0000-0000-0000-000000000001'
        WHERE id = 'f5b30000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'an owner of both servers cannot move a channel between them');
SELECT throws_ok(
    $q$UPDATE public.channels SET category = 'f5b20000-0000-0000-0000-000000000002'
        WHERE id = 'f5b30000-0000-0000-0000-000000000001'$q$,
    '23514', NULL, 'a channel cannot take a category of another server');
SELECT lives_ok(
    $q$UPDATE public.channels SET category = 'f5b20000-0000-0000-0000-000000000001'
        WHERE id = 'f5b30000-0000-0000-0000-000000000001'$q$,
    'a channel takes a category of its own server');
SELECT throws_ok(
    $q$UPDATE public.channel_categories SET server_id = 'f5b10000-0000-0000-0000-000000000001'
        WHERE id = 'f5b20000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'a category stays in its server');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.channel_categories SET name = 'renamed by bob' WHERE id = 'f5b20000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((SELECT name FROM public.channel_categories WHERE id = 'f5b20000-0000-0000-0000-000000000001'),
          'Private stuff', 'a member without MANAGE_CHANNELS cannot rename a category');

-- System rows -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$UPDATE public.messages SET is_deleted = true WHERE id = 'f5b60000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'the subject of a notice cannot soft-delete it');
SELECT throws_ok(
    $q$DELETE FROM public.messages WHERE id = 'f5b60000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'the subject of a notice cannot delete it');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$UPDATE public.messages SET is_deleted = true WHERE id = 'f5b60000-0000-0000-0000-000000000001'$q$,
    'a holder of MANAGE_MESSAGES soft-deletes a notice');
SELECT lives_ok(
    $q$DELETE FROM public.messages WHERE id = 'f5b60000-0000-0000-0000-000000000002'$q$,
    'a holder of MANAGE_MESSAGES deletes a notice');
SELECT throws_ok(
    $q$UPDATE public.messages SET is_deleted = true WHERE id = 'f5b60000-0000-0000-0000-000000000003'$q$,
    '42501', NULL, 'a direct conversation''s notice is not removed by a participant');
SELECT lives_ok(
    $q$UPDATE public.messages SET is_deleted = true WHERE id = '99999999-0000-0000-0000-000000000009'$q$,
    'an author still deletes their own message');

SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
