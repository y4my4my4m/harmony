-- 20261126100001_matrix_bridges.sql: matrix_bridge_send_check answers what the separate functions do,
-- field by field, for every bot, channel and person below.
--
--   server_1 (alice)  general: bound; c2: named, not bound; c3: bound, end-to-end encrypted;
--                     c4: bound, hidden from @everyone and shown to the role "insiders"; c5: not paired
--   s2 (mallory)      c6: the channel of another managed bridge
--   managed, other    bots of the two managed bridges
--   mx                custom bot, bound in c2; un: custom bot with an install of every channel, bound in c5
--                     and configured for general, not bound there
--   off               custom bot, inactive, configured for general; dc: a Discord bridge's bot, paired with
--                     general; plain: an ordinary bot
--   alice owner, bob member, insider in the role, out opted out of matrix, dopt opted out of discord,
--   remote, banned, gone (deleted account), mallory no member, a person who does not exist, and none
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(22);
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO public.servers (id, name, owner) VALUES
  ('f4040000-0000-0000-0000-0000000000a2', 'Mallory Server', '33333333-0000-0000-0000-000000000003');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f4040000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'named', 0),
  ('f4040000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'encrypted', 0),
  ('f4040000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005', 'hidden', 0),
  ('f4040000-0000-0000-0000-0000000000c5', '55555555-0000-0000-0000-000000000005', 'unpaired', 0),
  ('f4040000-0000-0000-0000-0000000000c6', 'f4040000-0000-0000-0000-0000000000a2', 'elsewhere', 0);
INSERT INTO public.server_encryption_settings (server_id, encryption_mode) VALUES ('55555555-0000-0000-0000-000000000005', 'optional')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional';
INSERT INTO public.server_roles (id, server_id, name, permissions, position) VALUES
  ('f4040000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'insiders', 0, 5);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f4040000-0000-0000-0000-0000000000c4'::uuid, 'role', r.id, NULL::uuid, 0, 2
  FROM public.server_roles r WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default
UNION ALL
SELECT 'f4040000-0000-0000-0000-0000000000c4', 'role', 'f4040000-0000-0000-0000-0000000000d1', NULL, 2, 0;

INSERT INTO public.profiles (id, username, display_name, is_local, avatar_url) VALUES
  ('f4040000-0000-0000-0000-0000000000e1', 'insider404', 'Insider', true, 'insider/avatar.png'),
  ('f4040000-0000-0000-0000-0000000000e2', 'out404', 'Opted out', true, NULL),
  ('f4040000-0000-0000-0000-0000000000e3', 'dopt404', NULL, true, NULL),
  ('f4040000-0000-0000-0000-0000000000e5', 'gone404', 'Gone', true, NULL);
INSERT INTO public.profiles (id, username, display_name, is_local, domain) VALUES
  ('f4040000-0000-0000-0000-0000000000e4', 'remote404', 'Remote', false, 'remote.example');
UPDATE public.profiles SET deleted_at = now() WHERE id = 'f4040000-0000-0000-0000-0000000000e5';
INSERT INTO public.user_servers (user_id, server_id, status, nickname)
SELECT ('f4040000-0000-0000-0000-0000000000e' || n)::uuid, '55555555-0000-0000-0000-000000000005', 'accepted', CASE n WHEN 1 THEN 'Nick' END
  FROM generate_series(1, 5) n;
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f4040000-0000-0000-0000-0000000000e1', 'f4040000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.bridge_member_optouts (server_id, user_id, platform) VALUES
  ('55555555-0000-0000-0000-000000000005', 'f4040000-0000-0000-0000-0000000000e2', 'matrix'),
  ('55555555-0000-0000-0000-000000000005', 'f4040000-0000-0000-0000-0000000000e3', 'discord'),
  ('f4040000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002', 'matrix');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'self') AS s1 \gset
SELECT :'s1'::jsonb ->> 'id' AS b1, :'s1'::jsonb ->> 'bot_id' AS managed \gset
SELECT public.matrix_bridge_pair(:'b1', c, r) IS NOT NULL AS paired
  FROM (VALUES ('66666666-0000-0000-0000-000000000006'::uuid, '!general:example.org'), ('f4040000-0000-0000-0000-0000000000c2', '!named:example.org'),
               ('f4040000-0000-0000-0000-0000000000c3', '!encrypted:example.org'), ('f4040000-0000-0000-0000-0000000000c4', '!hidden:example.org')) v(c, r);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.matrix_bridge_create('f4040000-0000-0000-0000-0000000000a2', 'self') AS s2 \gset
SELECT :'s2'::jsonb ->> 'id' AS b2, :'s2'::jsonb ->> 'bot_id' AS other \gset
SELECT public.matrix_bridge_pair(:'b2', 'f4040000-0000-0000-0000-0000000000c6', '!elsewhere:example.org') IS NOT NULL AS paired2 \gset
SELECT tests.clear_authentication();
INSERT INTO public.channel_encryption_settings (channel_id, messages_encrypted) VALUES ('f4040000-0000-0000-0000-0000000000c3', true)
ON CONFLICT (channel_id) DO UPDATE SET messages_encrypted = true;

INSERT INTO public.bots (id, username, owner_id, bot_type, is_active, bridge_platform) VALUES
  ('f4040000-0000-0000-0000-0000000000b1', 'mx404', '11111111-0000-0000-0000-000000000001', 'bot', true, 'matrix'),
  ('f4040000-0000-0000-0000-0000000000b2', 'un404', '11111111-0000-0000-0000-000000000001', 'bot', true, 'matrix'),
  ('f4040000-0000-0000-0000-0000000000b3', 'off404', '11111111-0000-0000-0000-000000000001', 'bot', false, 'matrix'),
  ('f4040000-0000-0000-0000-0000000000b4', 'dc404', '11111111-0000-0000-0000-000000000001', 'bridge', true, NULL),
  ('f4040000-0000-0000-0000-0000000000b5', 'plain404', '11111111-0000-0000-0000-000000000001', 'bot', true, NULL);
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, allowed_channel_ids)
SELECT ('f4040000-0000-0000-0000-0000000000b' || n)::uuid, '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
       CASE n WHEN 1 THEN ARRAY['f4040000-0000-0000-0000-0000000000c2']::uuid[] WHEN 3 THEN ARRAY['66666666-0000-0000-0000-000000000006']::uuid[] END
  FROM generate_series(1, 5) n;
INSERT INTO public.bridge_channels (bot_id, channel_id, platform, room_id, sender_mode) VALUES
  ('f4040000-0000-0000-0000-0000000000b1', 'f4040000-0000-0000-0000-0000000000c2', 'matrix', '!custom:example.org', 'relay'),
  ('f4040000-0000-0000-0000-0000000000b2', 'f4040000-0000-0000-0000-0000000000c5', 'matrix', '!wide:example.org', 'ghost'),
  ('f4040000-0000-0000-0000-0000000000b2', '66666666-0000-0000-0000-000000000006', 'matrix', NULL, 'relay'),
  ('f4040000-0000-0000-0000-0000000000b3', '66666666-0000-0000-0000-000000000006', 'matrix', NULL, 'ghost');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by) VALUES
  ('f4040000-0000-0000-0000-0000000000f1', '55555555-0000-0000-0000-000000000005', 'self', 'f4040000-0000-0000-0000-0000000000b4', '900000000000000404', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id) VALUES
  ('f4040000-0000-0000-0000-0000000000f1', '66666666-0000-0000-0000-000000000006', '4040000000000000001');
SET LOCAL role service_role;
SELECT public.matrix_bridge_bind_room(:'managed', c, r, 'relay') IS NOT NULL AS bound
  FROM (VALUES ('66666666-0000-0000-0000-000000000006'::uuid, '!general:example.org'), ('f4040000-0000-0000-0000-0000000000c3', '!encrypted:example.org'),
               ('f4040000-0000-0000-0000-0000000000c4', '!hidden:example.org')) v(c, r);
SELECT public.matrix_bridge_bind_room(:'other', 'f4040000-0000-0000-0000-0000000000c6', '!elsewhere:example.org', 'relay') IS NOT NULL AS bound2 \gset
RESET role;

-- The separate functions' answer.
CREATE FUNCTION pg_temp.separately(p_bot uuid, p_channel uuid, p_user uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_room jsonb;
BEGIN
    IF public.bridge_channel_platform(p_bot, p_channel) IS DISTINCT FROM 'matrix' THEN
        RETURN '{"platform":null,"room_id":null,"sender_mode":null,"messages_encrypted":null,"relay_allowed":null,"member":null}';
    END IF;
    v_room := public.matrix_bridge_room(p_bot, p_channel);
    RETURN jsonb_build_object(
        'platform', public.bridge_channel_platform(p_bot, p_channel),
        'room_id', v_room -> 'room_id',
        'sender_mode', v_room -> 'sender_mode',
        'messages_encrypted', public.channel_messages_encrypted(p_channel),
        'relay_allowed', CASE WHEN p_user IS NOT NULL THEN public.bridge_member_relay_allowed(p_bot, p_channel, p_user) END,
        'member', CASE WHEN p_user IS NOT NULL THEN (SELECT to_jsonb(m) FROM public.matrix_bridge_channel_member(p_bot, p_channel, p_user) m) END);
END;
$$;
CREATE TEMP TABLE cases ON COMMIT DROP AS
  SELECT b.id AS bot, c.id AS channel, u.id AS person
    FROM (SELECT id FROM public.bots WHERE username LIKE '%404' OR id IN (:'managed', :'other') UNION ALL VALUES ('f4040000-0000-0000-0000-0000000000ff'::uuid)) b,
         (SELECT id FROM public.channels WHERE server_id IN ('55555555-0000-0000-0000-000000000005', 'f4040000-0000-0000-0000-0000000000a2')
           UNION ALL VALUES ('f4040000-0000-0000-0000-0000000000ff'::uuid)) c,
         (SELECT id FROM public.profiles WHERE username LIKE '%404' OR username IN ('alice', 'bob', 'mallory', 'banned')
           UNION ALL VALUES ('f4040000-0000-0000-0000-0000000000ff'::uuid), (NULL)) u;
CREATE FUNCTION pg_temp.checked(p_bot uuid, p_channel text, p_user text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
    SELECT public.matrix_bridge_send_check(p_bot, p_channel::uuid, p_user::uuid)
$$;

SELECT ok(has_function_privilege('service_role', 'public.matrix_bridge_send_check(uuid, uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.matrix_bridge_send_check(uuid, uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.matrix_bridge_send_check(uuid, uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('service_role', 'public.matrix_bridge_member_row(uuid, uuid)', 'EXECUTE'),
  'the check is the gateway''s, its member lookup internal');
SELECT is((SELECT provolatile FROM pg_proc WHERE oid = 'public.matrix_bridge_send_check(uuid, uuid, uuid)'::regprocedure), 's'::"char", 'and stable');
SELECT is_empty($q$SELECT bot, channel, person FROM cases
   WHERE public.matrix_bridge_send_check(bot, channel, person) - 'scoped' IS DISTINCT FROM pg_temp.separately(bot, channel, person)$q$,
  'it answers what the separate functions do, for every bot, channel and person');
SELECT cmp_ok((SELECT count(*)::int FROM cases), '>=', 500, 'of many cases');
SELECT cmp_ok((SELECT count(DISTINCT pg_temp.separately(bot, channel, person))::int FROM cases), '>=', 20, 'and many answers');

-- Each case by name. ------------------------------------------------------------------------
SELECT is(pg_temp.checked(:'managed', '66666666-0000-0000-0000-000000000006'),
  '{"platform":"matrix","room_id":"!general:example.org","sender_mode":"ghost","messages_encrypted":false,"relay_allowed":null,"member":null}'::jsonb,
  'bound: without a person, the room and the mode');
SELECT is(pg_temp.checked(:'managed', '66666666-0000-0000-0000-000000000006', 'f4040000-0000-0000-0000-0000000000e1'),
  '{"platform":"matrix","room_id":"!general:example.org","sender_mode":"ghost","messages_encrypted":false,"relay_allowed":true,
    "member":{"id":"f4040000-0000-0000-0000-0000000000e1","username":"insider404","display_name":"Nick","avatar_url":"insider/avatar.png","nickname":"Nick",
              "domain":"","is_local":true}}'::jsonb || jsonb_build_object('member', (SELECT to_jsonb(m) FROM public.matrix_bridge_channel_member(:'managed',
      '66666666-0000-0000-0000-000000000006', 'f4040000-0000-0000-0000-0000000000e1') m)), 'with one, their consent and profile');
SELECT is(pg_temp.checked(:'managed', 'f4040000-0000-0000-0000-0000000000c2') -> 'room_id', 'null'::jsonb, 'not bound: no room');
SELECT is(pg_temp.checked(:'managed', 'f4040000-0000-0000-0000-0000000000c2') ->> 'platform', 'matrix', 'though paired');
SELECT is(pg_temp.checked(:'managed', 'f4040000-0000-0000-0000-0000000000c3') -> 'messages_encrypted', 'true'::jsonb, 'encrypted');
SELECT results_eq(
  format($q$SELECT x -> 'relay_allowed', x -> 'member' FROM (SELECT pg_temp.checked(%L, '66666666-0000-0000-0000-000000000006', 'f4040000-0000-0000-0000-0000000000e2') x) y$q$, :'managed'),
  $q$VALUES ('false'::jsonb, 'null'::jsonb)$q$, 'opted out');
SELECT results_eq(
  format($q$SELECT p, x -> 'relay_allowed', jsonb_typeof(x -> 'member') FROM (SELECT p, pg_temp.checked(%L, c, p) x
            FROM (VALUES ('f4040000-0000-0000-0000-0000000000e3', '66666666-0000-0000-0000-000000000006'), ('33333333-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006'),
                         ('44444444-0000-0000-0000-000000000004', '66666666-0000-0000-0000-000000000006'), ('f4040000-0000-0000-0000-0000000000e4', '66666666-0000-0000-0000-000000000006'),
                         ('f4040000-0000-0000-0000-0000000000e5', '66666666-0000-0000-0000-000000000006')) v(p, c)) y$q$, :'managed'),
  $q$VALUES ('f4040000-0000-0000-0000-0000000000e3', 'true'::jsonb, 'object'), ('33333333-0000-0000-0000-000000000003', 'true', 'null'),
            ('44444444-0000-0000-0000-000000000004', 'true', 'null'), ('f4040000-0000-0000-0000-0000000000e4', 'true', 'null'),
            ('f4040000-0000-0000-0000-0000000000e5', 'true', 'null')$q$,
  'an opt-out of Discord is no matter; a non-member, a banned, a remote and a deleted account are no member');
SELECT results_eq(
  format($q$SELECT p, jsonb_typeof(pg_temp.checked(%L, 'f4040000-0000-0000-0000-0000000000c4', p) -> 'member')
            FROM (VALUES ('11111111-0000-0000-0000-000000000001'), ('22222222-0000-0000-0000-000000000002'), ('f4040000-0000-0000-0000-0000000000e1')) v(p)$q$, :'managed'),
  $q$VALUES ('11111111-0000-0000-0000-000000000001', 'object'), ('22222222-0000-0000-0000-000000000002', 'null'), ('f4040000-0000-0000-0000-0000000000e1', 'object')$q$,
  'a hidden channel: the people who view it alone');
SELECT is(pg_temp.checked(:'managed', 'f4040000-0000-0000-0000-0000000000c6', '33333333-0000-0000-0000-000000000003'),
  '{"platform":null,"room_id":null,"sender_mode":null,"messages_encrypted":null,"relay_allowed":null,"member":null}'::jsonb, 'another bot''s channel: nothing');
SELECT is(pg_temp.checked(:'other', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002'),
  pg_temp.checked(:'managed', 'f4040000-0000-0000-0000-0000000000c6', '33333333-0000-0000-0000-000000000003'), 'the other way too');
SELECT is_empty($q$SELECT b FROM unnest(ARRAY['b3', 'b4', 'b5']) b
   WHERE pg_temp.checked(('f4040000-0000-0000-0000-0000000000' || b)::uuid, '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002') ->> 'platform' IS NOT NULL$q$,
  'nothing for an inactive bot, a Discord bridge''s bot and an ordinary bot');
SELECT is(pg_temp.checked('f4040000-0000-0000-0000-0000000000b1', 'f4040000-0000-0000-0000-0000000000c2') ->> 'room_id', '!custom:example.org', 'a custom bot''s own room');
SELECT is(pg_temp.checked('f4040000-0000-0000-0000-0000000000b2', '66666666-0000-0000-0000-000000000006') - 'scoped',
  '{"platform":"matrix","room_id":null,"sender_mode":"relay","messages_encrypted":false,"relay_allowed":null,"member":null}'::jsonb, 'none before it binds one');
SELECT is(pg_temp.checked('f4040000-0000-0000-0000-0000000000b2', 'f4040000-0000-0000-0000-0000000000c5') -> 'scoped', 'false'::jsonb,
  'an install of every channel is named, for the gateway to check');
SELECT is_empty($q$SELECT bot FROM cases WHERE bot <> 'f4040000-0000-0000-0000-0000000000b2' AND public.matrix_bridge_send_check(bot, channel, person) ? 'scoped'$q$, 'no other is');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES ('33333333-0000-0000-0000-000000000003', 'f4040000-0000-0000-0000-0000000000a2', 'pending')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = 'pending';
SELECT is(pg_temp.checked(:'other', 'f4040000-0000-0000-0000-0000000000c6', '33333333-0000-0000-0000-000000000003') -> 'member', 'null'::jsonb,
  'an owner without an accepted membership is no member');
UPDATE public.bots SET is_active = false WHERE id = :'managed';
SELECT is(pg_temp.checked(:'managed', '66666666-0000-0000-0000-000000000006') -> 'platform', 'null'::jsonb, 'a retired bot''s binding is none');

SELECT * FROM finish();
ROLLBACK;
