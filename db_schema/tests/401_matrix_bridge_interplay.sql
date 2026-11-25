-- 20261126100001_matrix_bridges.sql and 20261126100002_matrix_bridge_counts.sql: a managed Matrix
-- bridge beside custom Matrix bots, Discord pairings, member and remote opt-outs, the avatar purge,
-- and the instance's counts and limits.
--
--   alice    owner of server_1 (fixture), s3; mallory owner of s2
--   bob      accepted member of server_1
--   server_1 general (fixture), c2 text, c4 text only alice and the role "insiders" view
--   s3       (alice) with c6, its only Matrix bridge managed; s2 (mallory)
--   mx       alice's custom Matrix bot, scoped install [c2]
--   pl       alice's ordinary bot
-- Service-role functions are called as postgres, their owner; 400_matrix_bridges.sql asserts grants.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(76);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f4010000-0000-0000-0000-0000000000a2', 'Mallory Server', '33333333-0000-0000-0000-000000000003'),
  ('f4010000-0000-0000-0000-0000000000a3', 'Third Server', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f4010000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'second', 0),
  ('f4010000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005', 'private', 0),
  ('f4010000-0000-0000-0000-0000000000c6', 'f4010000-0000-0000-0000-0000000000a3', 'third-general', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f4010000-0000-0000-0000-0000000000c4', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.server_roles (id, server_id, name, permissions, position) VALUES
  ('f4010000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'insiders', 0, 5);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions) VALUES
  ('f4010000-0000-0000-0000-0000000000c4', 'role', 'f4010000-0000-0000-0000-0000000000d1', NULL, 2, 0);

INSERT INTO public.profiles (id, username, display_name, is_local) VALUES
  ('f4010000-0000-0000-0000-0000000000e1', 'insider401', 'Insider', true),
  ('f4010000-0000-0000-0000-0000000000e2', 'outsider401', 'Outsider', true);
INSERT INTO public.profiles (id, username, display_name, is_local, domain) VALUES
  ('f4010000-0000-0000-0000-0000000000e3', 'remote401', 'Remote', false, 'remote.example');
INSERT INTO public.user_servers (user_id, server_id, status, nickname) VALUES
  ('f4010000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'accepted', 'In'),
  ('f4010000-0000-0000-0000-0000000000e2', '55555555-0000-0000-0000-000000000005', 'accepted', NULL),
  ('f4010000-0000-0000-0000-0000000000e3', '55555555-0000-0000-0000-000000000005', 'accepted', NULL);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f4010000-0000-0000-0000-0000000000e1', 'f4010000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type, is_active) VALUES
  ('f4010000-0000-0000-0000-0000000000b1', 'mx401', 'Matrix 401', '11111111-0000-0000-0000-000000000001', 'bot', true),
  ('f4010000-0000-0000-0000-0000000000b2', 'plain401', 'Plain 401', '11111111-0000-0000-0000-000000000001', 'bot', true);
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, allowed_channel_ids) VALUES
  ('f4010000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['f4010000-0000-0000-0000-0000000000c2']::uuid[]);

-- 'bridge_count,bot_count' of a channel.
CREATE FUNCTION pg_temp.counts(p_channel uuid) RETURNS text LANGUAGE sql AS $$
    SELECT (e ->> 'bridge_count') || ',' || (e ->> 'bot_count')
      FROM (SELECT public.effective_channel_encryption(p_channel) e) x
$$;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.counts('66666666-0000-0000-0000-000000000006'), '0,1', 'the server has one bot and no bridge at first');
SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'self') AS s1 \gset
SELECT :'s1'::jsonb ->> 'id' AS b1, :'s1'::jsonb ->> 'bot_id' AS b1_bot \gset
SELECT public.matrix_bridge_pair(:'b1', '66666666-0000-0000-0000-000000000006', '#general:example.org', 'both', 'ghost') IS NOT NULL AS p \gset

-- Custom bot functions. ---------------------------------------------------------------------
SELECT throws_ok(format($q$SELECT public.configure_matrix_bridge(%L, '55555555-0000-0000-0000-000000000005', ARRAY[]::uuid[])$q$, :'b1_bot'),
  '22023', 'The bot belongs to a managed Matrix bridge', 'the owner cannot configure the managed bot as a custom one');
SELECT throws_ok(format($q$SELECT public.unconfigure_matrix_bridge(%L, '55555555-0000-0000-0000-000000000005')$q$, :'b1_bot'),
  '22023', 'The bot belongs to a managed Matrix bridge', 'nor unconfigure it');
SELECT throws_ok(format($q$SELECT public.set_matrix_bridge_sender_mode(%L, '66666666-0000-0000-0000-000000000006', 'relay')$q$, :'b1_bot'),
  '22023', 'The bot belongs to a managed Matrix bridge', 'nor change its sender mode outside the bridge');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.configure_matrix_bridge(%L, '55555555-0000-0000-0000-000000000005', ARRAY[]::uuid[])$q$, :'b1_bot'),
  '42501', NULL, 'a caller without the right learns nothing of it: configure');
SELECT throws_ok(format($q$SELECT public.unconfigure_matrix_bridge(%L, '55555555-0000-0000-0000-000000000005')$q$, :'b1_bot'),
  '42501', NULL, 'unconfigure');
SELECT throws_ok(format($q$SELECT public.set_matrix_bridge_sender_mode(%L, '66666666-0000-0000-0000-000000000006', 'relay')$q$, :'b1_bot'),
  '42501', NULL, 'sender mode');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.configure_matrix_bridge('f4010000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
            ARRAY['f4010000-0000-0000-0000-0000000000c2']::uuid[]), true, 'a custom bot is configured beside the managed bridge');
SELECT results_eq(
  $q$SELECT x ->> 'bot_id', x ->> 'channel_id', (x ->> 'active')::boolean
       FROM jsonb_array_elements(public.get_server_matrix_bridges('55555555-0000-0000-0000-000000000005')) x$q$,
  $q$VALUES ('f4010000-0000-0000-0000-0000000000b1', 'f4010000-0000-0000-0000-0000000000c2', true)$q$,
  'the custom bots'' list leaves the managed bot''s pairs out');
SELECT is(public.set_matrix_bridge_sender_mode('f4010000-0000-0000-0000-0000000000b1', 'f4010000-0000-0000-0000-0000000000c2', 'ghost') ->> 'sender_mode',
  'ghost', 'a custom bot''s sender mode changes as before');
SELECT is(jsonb_array_length(public.matrix_bridge_state('55555555-0000-0000-0000-000000000005') -> 'pairs'), 1,
  'the managed bridge''s state leaves the custom bot''s bindings out');
SELECT lives_ok($q$INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by)
                   VALUES ('f4010000-0000-0000-0000-0000000000b2', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001')$q$,
  'an ordinary bot joins');

-- Counts of effective_channel_encryption. ---------------------------------------------------
SELECT is(pg_temp.counts('66666666-0000-0000-0000-000000000006'),
  '1,2', 'a channel the managed bridge relays counts one bridge; the custom bot and the ordinary bot count as bots');
SELECT is(pg_temp.counts('f4010000-0000-0000-0000-0000000000c2'),
  '1,1', 'a channel the custom bot relays counts it as a bridge, not as a bot; the managed bot counts nowhere else');
SELECT is(pg_temp.counts('f4010000-0000-0000-0000-0000000000c4'),
  '0,2', 'a channel nothing relays counts no bridge');
SELECT tests.clear_authentication();
UPDATE public.bot_server_permissions SET send_messages = false WHERE bot_id = 'f4010000-0000-0000-0000-0000000000b1';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(split_part(pg_temp.counts('f4010000-0000-0000-0000-0000000000c2'), ',', 1), '0',
  'a binding whose install no longer qualifies counts no bridge');
SELECT tests.clear_authentication();
UPDATE public.bot_server_permissions SET send_messages = true WHERE bot_id = 'f4010000-0000-0000-0000-0000000000b1';

-- bind_room. --------------------------------------------------------------------------------
UPDATE public.matrix_bridges SET updated_at = '2000-01-01' WHERE id = :'b1';
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(p_bot_id => %L, p_channel_id => '66666666-0000-0000-0000-000000000006',
                             p_room_id => '!general:example.org', p_initial_sender_mode => 'relay')$q$, :'b1_bot'),
  '22023', 'The pair names another Matrix room', 'a pair named by alias binds no room without its alias');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(%L, '66666666-0000-0000-0000-000000000006', '!general:example.org', 'relay', '#old:example.org')$q$, :'b1_bot'),
  '22023', 'The pair names another Matrix room', 'nor the room of an alias it no longer names');
SELECT is((SELECT room_id FROM public.bridge_channels WHERE bot_id = :'b1_bot'), NULL, 'a refused bind binds nothing');
SELECT is(public.matrix_bridge_bind_room(:'b1_bot', '66666666-0000-0000-0000-000000000006', '!general:example.org', 'relay', '#general:example.org'),
  '{"room_id":"!general:example.org","sender_mode":"ghost"}'::jsonb, 'the pair''s alias binds its room; the manager''s sender mode stays');
SELECT is((SELECT updated_at FROM public.matrix_bridges WHERE id = :'b1'), now(), 'a bound room is a configuration change');
SELECT is(public.matrix_bridge_bind_room(:'b1_bot', '66666666-0000-0000-0000-000000000006', '!general:example.org', 'relay') ->> 'room_id',
  '!general:example.org', 'binding the bound room again answers it');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(%L, '66666666-0000-0000-0000-000000000006', '!new:example.org', 'relay', '#general:example.org')$q$, :'b1_bot'),
  '22023', 'Remove the binding before assigning another Matrix room', 'a bound pair takes no other room from the bridge');
-- As harmony-matrix-bridge 0.1.0 through the gateway: four named arguments.
SELECT throws_ok($q$SELECT public.matrix_bridge_bind_room(p_bot_id => 'f4010000-0000-0000-0000-0000000000b1',
                             p_channel_id => 'f4010000-0000-0000-0000-0000000000c2', p_room_id => '!general:example.org', p_initial_sender_mode => 'relay')$q$,
  '23505', 'The Matrix room is bound to another channel', 'a custom bot cannot take the managed bridge''s room');
SELECT is(public.matrix_bridge_bind_room(p_bot_id => 'f4010000-0000-0000-0000-0000000000b1',
            p_channel_id => 'f4010000-0000-0000-0000-0000000000c2', p_room_id => '!custom:example.org', p_initial_sender_mode => 'relay'),
  '{"room_id":"!custom:example.org","sender_mode":"ghost"}'::jsonb, 'and binds its own room without an alias, as in 1.9.8');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4010000-0000-0000-0000-0000000000c4', '!custom:example.org')$q$, :'b1'),
  '23505', NULL, 'nor does the managed bridge take a custom bot''s room');

-- Members. ----------------------------------------------------------------------------------
SELECT public.matrix_bridge_pair(:'b1', 'f4010000-0000-0000-0000-0000000000c4', '!private:example.org') IS NOT NULL AS p2 \gset
SELECT tests.clear_authentication();
INSERT INTO public.bridge_member_optouts (server_id, user_id, platform) VALUES
  ('55555555-0000-0000-0000-000000000005', 'f4010000-0000-0000-0000-0000000000e2', 'matrix');
CREATE FUNCTION pg_temp.listed(p_bot uuid, p_channel uuid) RETURNS text LANGUAGE sql AS $$
    SELECT string_agg(m::text, E'\n' ORDER BY m.id) FROM public.matrix_bridge_channel_members(p_bot, p_channel) m
$$;
CREATE FUNCTION pg_temp.one_by_one(p_bot uuid, p_channel uuid) RETURNS text LANGUAGE sql AS $$
    SELECT string_agg(m::text, E'\n' ORDER BY m.id)
      FROM public.profiles p CROSS JOIN LATERAL public.matrix_bridge_channel_member(p_bot, p_channel, p.id) m
$$;
SELECT is(pg_temp.one_by_one(:'b1_bot', '66666666-0000-0000-0000-000000000006'), pg_temp.listed(:'b1_bot', '66666666-0000-0000-0000-000000000006'),
  'one member at a time answers the list of an open channel');
SELECT is(pg_temp.one_by_one(:'b1_bot', 'f4010000-0000-0000-0000-0000000000c4'), pg_temp.listed(:'b1_bot', 'f4010000-0000-0000-0000-0000000000c4'),
  'and of a channel only some view');
SELECT results_eq(
  format($q$SELECT u, (SELECT m.display_name FROM public.matrix_bridge_channel_member(%L, c::uuid, u::uuid) m)
              FROM (VALUES ('f4010000-0000-0000-0000-0000000000e1', '66666666-0000-0000-0000-000000000006'),
                           ('f4010000-0000-0000-0000-0000000000e1', 'f4010000-0000-0000-0000-0000000000c4'),
                           ('22222222-0000-0000-0000-000000000002', 'f4010000-0000-0000-0000-0000000000c4'),
                           ('22222222-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006'),
                           ('f4010000-0000-0000-0000-0000000000e2', '66666666-0000-0000-0000-000000000006'),
                           ('f4010000-0000-0000-0000-0000000000e3', '66666666-0000-0000-0000-000000000006'),
                           ('33333333-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006'),
                           ('44444444-0000-0000-0000-000000000004', '66666666-0000-0000-0000-000000000006')) v(u, c)$q$, :'b1_bot'),
  $q$VALUES ('f4010000-0000-0000-0000-0000000000e1', 'In'), ('f4010000-0000-0000-0000-0000000000e1', 'In'),
            ('22222222-0000-0000-0000-000000000002', NULL), ('22222222-0000-0000-0000-000000000002', 'Bob'),
            ('f4010000-0000-0000-0000-0000000000e2', NULL), ('f4010000-0000-0000-0000-0000000000e3', NULL),
            ('33333333-0000-0000-0000-000000000003', NULL), ('44444444-0000-0000-0000-000000000004', NULL)$q$,
  'a member who cannot view, opted out, is remote, banned or no member is not answered');
SELECT throws_ok(format($q$SELECT * FROM public.matrix_bridge_channel_member(%L, 'f4010000-0000-0000-0000-0000000000c2', '22222222-0000-0000-0000-000000000002')$q$, :'b1_bot'),
  '42501', NULL, 'nor any member of a channel the bot does not relay');

-- Member and remote opt-outs. ---------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_member_privacy('f4010000-0000-0000-0000-0000000000a3') #> '{matrix,bridged}', 'false'::jsonb, 'a server without a bridge');
SELECT public.matrix_bridge_create('f4010000-0000-0000-0000-0000000000a3', 'self') AS s3 \gset
SELECT :'s3'::jsonb ->> 'id' AS b3, :'s3'::jsonb ->> 'bot_id' AS b3_bot \gset
SELECT is(public.bridge_member_privacy('f4010000-0000-0000-0000-0000000000a3') #> '{matrix,bridged}', 'true'::jsonb,
  'a managed bridge without pairs bridges its server: members may opt out before the first pair');
SELECT public.matrix_bridge_pair(:'b3', 'f4010000-0000-0000-0000-0000000000c6', '!third:example.org') IS NOT NULL AS p3 \gset
SELECT is(public.bridge_member_privacy('f4010000-0000-0000-0000-0000000000a3') -> 'matrix', '{"bridged":true,"opted_out":false}'::jsonb,
  'so does one with pairs, the server''s only Matrix bridge');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.bridge_member_privacy('f4010000-0000-0000-0000-0000000000a3') #> '{matrix,bridged}', 'false'::jsonb, 'which a stranger is not told');
SELECT tests.clear_authentication();

UPDATE public.matrix_bridges SET updated_at = '2000-01-01';
SELECT is(public.bridge_privacy_set_optout('f4010000-0000-0000-0000-0000000000a3', 'matrix', '@sam:example.org', true) ->> 'opted_out', 'true',
  'a Matrix person opts out');
SELECT results_eq('SELECT server_id, updated_at = now() FROM public.matrix_bridges ORDER BY server_id',
  $q$VALUES ('55555555-0000-0000-0000-000000000005'::uuid, false), ('f4010000-0000-0000-0000-0000000000a3'::uuid, true)$q$,
  'an opt-out is a configuration change of its server''s bridge');
SELECT is(public.matrix_bridge_config(:'b3_bot') ->> 'privacy_version',
  public.bridge_privacy_optout_ids('f4010000-0000-0000-0000-0000000000a3', 'matrix') ->> 'version', 'the configuration carries the list''s version');
SELECT isnt(public.matrix_bridge_config(:'b3_bot') ->> 'privacy_version', '0:0', 'which changed');
PREPARE relay AS INSERT INTO public.messages (channel_id, bot_id, content, metadata)
  VALUES ('f4010000-0000-0000-0000-0000000000c6', (SELECT bot_id FROM public.matrix_bridges WHERE server_id = 'f4010000-0000-0000-0000-0000000000a3'),
          '[{"type":"text","text":"hi"}]', '{"matrix_user":{"id":"@sam:example.org","username":"sam"},"bridge_source":"matrix"}');
SELECT throws_ok('EXECUTE relay', '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'their messages are refused');
UPDATE public.matrix_bridges SET updated_at = '2000-01-01';
SELECT is(public.bridge_privacy_set_optout('f4010000-0000-0000-0000-0000000000a3', 'matrix', '@sam:example.org', false) ->> 'opted_out', 'false',
  'and opts back in');
SELECT is((SELECT updated_at FROM public.matrix_bridges WHERE id = :'b3'), now(), 'another configuration change');
SELECT lives_ok('EXECUTE relay', 'their messages are relayed again');
SELECT lives_ok($q$SELECT public.bridge_privacy_erase('f4010000-0000-0000-0000-0000000000a3', 'matrix', '@sam:example.org')$q$, 'an erase');
SELECT is((SELECT count(*)::int FROM public.messages WHERE channel_id = 'f4010000-0000-0000-0000-0000000000c6'), 0, 'removes them');

-- Members' opt-outs in bridge_member_optouts, whoever writes them. ---------------------------
CREATE FUNCTION pg_temp.told() RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE
    v_told uuid[];
BEGIN
    SELECT array_agg(b.server_id ORDER BY b.server_id) INTO v_told FROM public.matrix_bridges b WHERE b.updated_at = now();
    UPDATE public.matrix_bridges SET updated_at = '2000-01-01';
    UPDATE public.discord_bridges SET updated_at = '2000-01-01';
    RETURN v_told;
END;
$$;
INSERT INTO public.discord_bridges (id, server_id, mode, discord_guild_id, created_by) VALUES
  ('f4010000-0000-0000-0000-0000000000f1', '55555555-0000-0000-0000-000000000005', 'self', '900000000000000401', '11111111-0000-0000-0000-000000000001');
SELECT pg_temp.told() IS NULL AS reset \gset
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'matrix', true) #> '{matrix,opted_out}', 'true', 'a member opts out of Matrix');
SELECT tests.clear_authentication();
SELECT is(pg_temp.told(), ARRAY['55555555-0000-0000-0000-000000000005']::uuid[], 'a configuration change of their server''s bridge alone');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'matrix', true) #> '{matrix,opted_out}', 'true', 'again');
SELECT tests.clear_authentication();
SELECT is(pg_temp.told(), NULL, 'changes nothing');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'matrix', false) IS NOT NULL AS o1 \gset
SELECT tests.clear_authentication();
SELECT is(pg_temp.told(), ARRAY['55555555-0000-0000-0000-000000000005']::uuid[], 'back in: another change');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'matrix', false) IS NOT NULL AS o2 \gset
SELECT public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'discord', true) IS NOT NULL AS o3 \gset
SELECT tests.clear_authentication();
SELECT ok(pg_temp.told() IS NULL, 'a repeat and an opt-out of Discord are none');
INSERT INTO public.bridge_member_optouts (server_id, user_id, platform) VALUES
  ('f4010000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002', 'matrix'),
  ('f4010000-0000-0000-0000-0000000000a3', '22222222-0000-0000-0000-000000000002', 'discord');
SELECT is(pg_temp.told(), NULL, 'nor one in a server without a Matrix bridge');
INSERT INTO public.bridge_member_optouts (server_id, user_id, platform) VALUES
  ('f4010000-0000-0000-0000-0000000000a3', 'f4010000-0000-0000-0000-0000000000e1', 'matrix'),
  ('55555555-0000-0000-0000-000000000005', 'f4010000-0000-0000-0000-0000000000e1', 'matrix'),
  ('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', 'matrix')
ON CONFLICT DO NOTHING;
SELECT is(pg_temp.told(), ARRAY['55555555-0000-0000-0000-000000000005', 'f4010000-0000-0000-0000-0000000000a3']::uuid[],
  'several at once, written elsewhere, tell each server');
UPDATE public.bridge_member_optouts SET platform = 'discord'
 WHERE server_id = 'f4010000-0000-0000-0000-0000000000a3' AND user_id = 'f4010000-0000-0000-0000-0000000000e1';
SELECT is(pg_temp.told(), ARRAY['f4010000-0000-0000-0000-0000000000a3']::uuid[], 'a row that leaves the platform does');
UPDATE public.bridge_member_optouts SET platform = 'matrix'
 WHERE server_id = 'f4010000-0000-0000-0000-0000000000a3' AND user_id = 'f4010000-0000-0000-0000-0000000000e1';
SELECT is(pg_temp.told(), ARRAY['f4010000-0000-0000-0000-0000000000a3']::uuid[], 'and one that comes to it');
DELETE FROM public.profiles WHERE id = 'f4010000-0000-0000-0000-0000000000e1';
SELECT is(pg_temp.told(), ARRAY['55555555-0000-0000-0000-000000000005', 'f4010000-0000-0000-0000-0000000000a3']::uuid[],
  'and an account removed with its opt-outs');
SELECT is((SELECT updated_at FROM public.discord_bridges WHERE id = 'f4010000-0000-0000-0000-0000000000f1'), '2000-01-01'::timestamptz,
  'the Discord bridge''s record is not touched by any');
DELETE FROM public.discord_bridges WHERE id = 'f4010000-0000-0000-0000-0000000000f1';

-- A v1 Discord pairing of the server. -------------------------------------------------------
INSERT INTO public.discord_bridge_pairings (server_id, pairing_code, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', 'HRM-AB40-CD40', '11111111-0000-0000-0000-000000000001');
SELECT is(public.bridge_channel_platform(:'b1_bot', 'f4010000-0000-0000-0000-0000000000c2'), NULL,
  'a v1 pairing its owner made does not turn the Matrix bot into a Discord bridge');
SELECT is(public.bridge_channel_platform(:'b1_bot', '66666666-0000-0000-0000-000000000006'), 'matrix', 'nor its paired channels');

-- Avatar purge. -----------------------------------------------------------------------------
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('avatars', 'bridges/' || :'b1_bot' || '/55555555-0000-0000-0000-000000000005/a.png', '{"size": 10}'),
  ('avatars', 'bridges/' || :'b3_bot' || '/f4010000-0000-0000-0000-0000000000a3/a.png', '{"size": 10}');
CREATE FUNCTION pg_temp.unbound() RETURNS text[] LANGUAGE sql AS $$
    UPDATE public.bridge_avatar_usage SET unbound_at = unbound_at - interval '61 minutes';
    SELECT array_agg(u.server_id::text ORDER BY u.server_id) FROM public.bridge_avatar_unbound(50) u
$$;
SELECT is(pg_temp.unbound(), NULL, 'avatars of a paired bridge are kept');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_unpair(:'b1', '66666666-0000-0000-0000-000000000006') IS NOT NULL AS u1 \gset
SELECT tests.clear_authentication();
SELECT pg_temp.unbound() IS NULL AS noted \gset
SELECT is(pg_temp.unbound(), NULL, 'and while one pair is left');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_delete(:'b1') IS NOT NULL AS x1 \gset
SELECT public.matrix_bridge_unpair(:'b3', 'f4010000-0000-0000-0000-0000000000c6') IS NOT NULL AS u3 \gset
SELECT tests.clear_authentication();
SELECT is(pg_temp.unbound(), NULL, 'within the hour after');
SELECT is(pg_temp.unbound(), ARRAY['55555555-0000-0000-0000-000000000005', 'f4010000-0000-0000-0000-0000000000a3'],
  'then the avatars of a deleted bridge and of one without pairs are removed');

-- Limits. -----------------------------------------------------------------------------------
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'max_bots_per_user';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.matrix_bridge_create('f4010000-0000-0000-0000-0000000000a2', 'self') ->> 'bot_id' AS b2_bot \gset
SELECT public.create_bot('mallory401') #>> '{bot,id}' AS plain \gset
SELECT ok(:'plain' IS NOT NULL, 'the managed bot does not count toward the account''s bots');
SELECT throws_ok($q$SELECT public.create_bot('mallory401b')$q$, 'P0001', 'BOT_LIMIT_REACHED:1', 'the account''s own bots do');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = config_value || '{"bot_requests_per_minute": 1, "bridge_requests_per_minute": 2}'::jsonb
 WHERE config_key = 'antispam';
SELECT is(public.check_and_increment_bot_rate_limit(:'b2_bot', '/t/1', 1, 60), 0, 'a managed bot''s first request');
SELECT is(public.check_and_increment_bot_rate_limit(:'b2_bot', '/t/2', 1, 60), 0, 'and its second, under the bridge limit');
SELECT cmp_ok(public.check_and_increment_bot_rate_limit(:'b2_bot', '/t/3', 1, 60), '>', 0, 'the third passes the bridge limit');
SELECT is(public.check_and_increment_bot_rate_limit(:'plain', '/t/1', 1, 60), 0, 'an ordinary bot''s first request');
SELECT cmp_ok(public.check_and_increment_bot_rate_limit(:'plain', '/t/2', 1, 60), '>', 0, 'its second passes the bot limit');
-- A route of its own limit, such as bridge-check's 4 times, does not raise the ceiling.
DELETE FROM public.bot_rate_limits WHERE bot_id IN (:'b2_bot', :'plain');
SELECT ok(has_function_privilege('service_role', 'public.bot_rate_limit_check(uuid, text, integer, integer, integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.bot_rate_limit_check(uuid, text, integer, integer, integer)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.bot_rate_limit_check(uuid, text, integer, integer, integer)', 'EXECUTE'), 'its check is the gateway''s');
SELECT is(public.bot_rate_limit_check(:'plain', '/c', 4, 60, 1), 0, 'an ordinary bot''s first request of it');
SELECT cmp_ok(public.bot_rate_limit_check(:'plain', '/c', 4, 60, 1), '>', 0, 'its second passes the bot limit the operator set');
SELECT is(public.bot_rate_limit_check(:'b2_bot', '/c', 4, 60, 1) + public.bot_rate_limit_check(:'b2_bot', '/c', 4, 60, 1), 0, 'a managed bot has the bridge limit');
UPDATE public.instance_config SET config_value = config_value || '{"bot_requests_per_minute": 9}'::jsonb WHERE config_key = 'antispam';
SELECT is(public.bot_rate_limit_check(:'plain', '/c', 4, 60, 1) + public.bot_rate_limit_check(:'plain', '/c', 4, 60, 1), 0, 'under a higher ceiling, four requests of it pass');
SELECT cmp_ok(public.bot_rate_limit_check(:'plain', '/c', 4, 60, 1), '>', 0, 'and no fifth');
SELECT lives_ok($q$DELETE FROM public.servers WHERE id = 'f4010000-0000-0000-0000-0000000000a2'$q$, 'a server is deleted with its bridge and opt-outs');

SELECT * FROM finish();
ROLLBACK;
