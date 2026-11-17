-- 20261117900001_matrix_bridge.sql: Matrix bindings, the platform of a bot in a channel, member
-- opt-outs.
--
-- Service-role functions are called as postgres, their owner; grants are asserted apart.
-- Fixture server_1 (alice owns, bob is a member, mallory is neither) with #general. Added:
--   channels  c2 text, c3 voice, c5 text outside every allowlist; server s2 (alice) with c4
--   b1 mx303       alice's bot, scoped install [general, c2, c3]
--   b2 mxbob303    bob's bot, scoped install [general]
--   b3 mxwide303   alice's bot, unscoped install
--   b4 mxoff303    alice's inactive bot, scoped install [general]
--   d1 dc303       alice's bridge bot of server_1's discord_bridges row, paired with #general
--   d2 dcv1303     alice's bridge bot installed on s2, whose v1 pairing alice created
--   d3 dcbare303   alice's bridge bot with no pairing, scoped install [general]
--   d4 dcv1bob303  bob's bridge bot installed on s2 by bob
--   o1 plain303    alice's ordinary bot, scoped install [general]

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(73);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f3030000-0000-0000-0000-0000000000e2', 'Server 303', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f3030000-0000-0000-0000-0000000000e2', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f3030000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'second', 0),
  ('f3030000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'voice', 2),
  ('f3030000-0000-0000-0000-0000000000c5', '55555555-0000-0000-0000-000000000005', 'outside', 0),
  ('f3030000-0000-0000-0000-0000000000c4', 'f3030000-0000-0000-0000-0000000000e2', 'elsewhere', 0);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type, is_active) VALUES
  ('f3030000-0000-0000-0000-0000000000b1', 'mx303', 'Matrix 303', '11111111-0000-0000-0000-000000000001', 'bot', true),
  ('f3030000-0000-0000-0000-0000000000b2', 'mxbob303', 'Bob Matrix', '22222222-0000-0000-0000-000000000002', 'bot', true),
  ('f3030000-0000-0000-0000-0000000000b3', 'mxwide303', 'Wide', '11111111-0000-0000-0000-000000000001', 'bot', true),
  ('f3030000-0000-0000-0000-0000000000b4', 'mxoff303', 'Off', '11111111-0000-0000-0000-000000000001', 'bot', false),
  ('f3030000-0000-0000-0000-0000000000d1', 'dc303', 'Discord 303', '11111111-0000-0000-0000-000000000001', 'bridge', true),
  ('f3030000-0000-0000-0000-0000000000d2', 'dcv1303', 'Discord v1', '11111111-0000-0000-0000-000000000001', 'bridge', true),
  ('f3030000-0000-0000-0000-0000000000d3', 'dcbare303', 'Bare bridge', '11111111-0000-0000-0000-000000000001', 'bridge', true),
  ('f3030000-0000-0000-0000-0000000000d4', 'dcv1bob303', 'Bob v1', '22222222-0000-0000-0000-000000000002', 'bridge', true),
  ('f3030000-0000-0000-0000-0000000000a1', 'plain303', 'Plain', '11111111-0000-0000-0000-000000000001', 'bot', true);

INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, allowed_channel_ids) VALUES
  ('f3030000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['66666666-0000-0000-0000-000000000006', 'f3030000-0000-0000-0000-0000000000c2', 'f3030000-0000-0000-0000-0000000000c3']::uuid[]),
  ('f3030000-0000-0000-0000-0000000000b2', '55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002',
   ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]),
  ('f3030000-0000-0000-0000-0000000000b3', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', NULL),
  ('f3030000-0000-0000-0000-0000000000b4', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]),
  ('f3030000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]),
  ('f3030000-0000-0000-0000-0000000000d2', 'f3030000-0000-0000-0000-0000000000e2', '11111111-0000-0000-0000-000000000001', NULL),
  ('f3030000-0000-0000-0000-0000000000d2', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]),
  ('f3030000-0000-0000-0000-0000000000d3', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]),
  ('f3030000-0000-0000-0000-0000000000d4', 'f3030000-0000-0000-0000-0000000000e2', '22222222-0000-0000-0000-000000000002', NULL),
  ('f3030000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]);

INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by) VALUES
  ('f3030000-0000-0000-0000-0000000000f1', '55555555-0000-0000-0000-000000000005', 'self',
   'f3030000-0000-0000-0000-0000000000d1', '900000000000000303', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id) VALUES
  ('f3030000-0000-0000-0000-0000000000f1', '66666666-0000-0000-0000-000000000006', '3030000000000000001');
INSERT INTO public.discord_bridge_pairings (server_id, pairing_code, created_by) VALUES
  ('f3030000-0000-0000-0000-0000000000e2', 'HRM-AB30-CD30', '11111111-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.platform(p_bot text, p_channel text) RETURNS text LANGUAGE sql AS
$fn$ SELECT public.bridge_channel_platform(('f3030000-0000-0000-0000-0000000000' || p_bot)::uuid, p_channel::uuid) $fn$;

-- Access ---------------------------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.configure_matrix_bridge(uuid, uuid, uuid[])', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.unconfigure_matrix_bridge(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_server_matrix_bridges(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.set_matrix_bridge_sender_mode(uuid, uuid, text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.bridge_member_privacy(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.set_bridge_member_optout(uuid, text, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.configure_matrix_bridge(uuid, uuid, uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_bridge_member_optout(uuid, text, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'public.configure_matrix_bridge(uuid, uuid, uuid[])', 'EXECUTE'),
          'the manager and member functions are for signed-in callers');
SELECT ok(has_function_privilege('service_role', 'public.bridge_channel_platform(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.matrix_bridge_bind_room(uuid, uuid, text, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.matrix_bridge_room(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.matrix_bridge_channel_members(uuid, uuid, integer, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_member_optout_ids(uuid, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_member_relay_allowed(uuid, uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_channel_platform(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.matrix_bridge_channel_members(uuid, uuid, integer, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_member_relay_allowed(uuid, uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.bridge_member_optout_ids(uuid, text)', 'EXECUTE'),
          'the gateway functions are for the service role alone');
SELECT ok(NOT has_function_privilege('authenticated', 'public.matrix_bridge_binding_json(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'public.matrix_bridge_binding_json(uuid, uuid)', 'EXECUTE'),
          'the binding row builder is internal');
SELECT ok(NOT has_table_privilege('authenticated', 'public.bridge_channels', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.bridge_channels', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.bridge_member_optouts', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.bridge_member_optouts', 'DELETE')
          AND NOT has_table_privilege('authenticated', 'public.bridge_member_optouts', 'UPDATE')
          AND NOT has_table_privilege('anon', 'public.bridge_member_optouts', 'SELECT')
          AND has_table_privilege('authenticated', 'public.bridge_member_optouts', 'SELECT'),
          'clients read their own opt-outs and nothing of the bindings');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bridge_channels'::regclass)
          AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bridge_member_optouts'::regclass),
          'both tables have RLS on');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$UPDATE public.bots SET bridge_platform = 'matrix' WHERE id = 'f3030000-0000-0000-0000-0000000000b1'$q$,
                 '42501', 'bridge_platform is set through configure_matrix_bridge',
                 'the owner cannot set bridge_platform directly');
SELECT lives_ok($q$UPDATE public.bots SET bio = 'bio' WHERE id = 'f3030000-0000-0000-0000-0000000000b1'$q$,
                'the owner still edits the rest of the bot');

-- Configure -------------------------------------------------------------------------------------------
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b2',
                     '55555555-0000-0000-0000-000000000005', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])$q$,
                 '42501', 'Only the bot''s owner configures its Matrix bridge',
                 'a manager cannot turn another owner''s bot into a Matrix bridge');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b2',
                     '55555555-0000-0000-0000-000000000005', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])$q$,
                 '42501', 'MANAGE_SERVER required', 'an owner who does not manage the server is refused');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
              ARRAY['66666666-0000-0000-0000-000000000006', 'f3030000-0000-0000-0000-0000000000c2',
                    'f3030000-0000-0000-0000-0000000000c2']::uuid[]),
          true, 'the owner who manages the server configures the bot');
SELECT tests.clear_authentication();
SELECT is((SELECT (bridge_platform, bot_type)::text FROM public.bots WHERE id = 'f3030000-0000-0000-0000-0000000000b1'),
          '(matrix,bot)', 'bridge_platform is set and bot_type is left alone');
SELECT is((SELECT array_agg(channel_id ORDER BY channel_id)::text FROM public.bridge_channels
            WHERE bot_id = 'f3030000-0000-0000-0000-0000000000b1'),
          '{66666666-0000-0000-0000-000000000006,f3030000-0000-0000-0000-0000000000c2}',
          'one binding per channel, duplicates folded');
SELECT is((SELECT array_agg(DISTINCT (platform, sender_mode, sender_mode_set_by_manager, room_id IS NULL)::text)
             FROM public.bridge_channels WHERE bot_id = 'f3030000-0000-0000-0000-0000000000b1'),
          ARRAY['(matrix,relay,f,t)'], 'a new binding relays, with no room yet');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b1',
                     '55555555-0000-0000-0000-000000000005', ARRAY['f3030000-0000-0000-0000-0000000000c3']::uuid[])$q$,
                 '22023', NULL, 'a voice channel is refused');
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b1',
                     '55555555-0000-0000-0000-000000000005', ARRAY['f3030000-0000-0000-0000-0000000000c4']::uuid[])$q$,
                 '22023', NULL, 'a channel of another server is refused');
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b1',
                     '55555555-0000-0000-0000-000000000005', ARRAY['f3030000-0000-0000-0000-0000000000c5']::uuid[])$q$,
                 '22023', NULL, 'a channel outside the install allowlist is refused');
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b1',
                     '55555555-0000-0000-0000-000000000005', ARRAY[NULL]::uuid[])$q$,
                 '22023', NULL, 'a null channel is refused');
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000d1',
                     '55555555-0000-0000-0000-000000000005', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])$q$,
                 '22023', 'A Discord bridge bot cannot bridge Matrix', 'the bot of a Discord bridge is refused');
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000d2',
                     '55555555-0000-0000-0000-000000000005', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])$q$,
                 '22023', 'A Discord bridge bot cannot bridge Matrix', 'a bridge bot a v1 pairing trusts is refused');
SELECT is(public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000d3', '55555555-0000-0000-0000-000000000005',
              ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]),
          true, 'a bridge-type bot no Discord bridge uses may bridge Matrix');
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b3',
                     '55555555-0000-0000-0000-000000000005', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])$q$,
                 '42501', 'Active scoped read and send install required', 'an unscoped install is refused');
SELECT throws_ok($q$SELECT public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b4',
                     '55555555-0000-0000-0000-000000000005', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])$q$,
                 '22023', 'Active bot required', 'an inactive bot is refused');
SELECT tests.clear_authentication();

-- Platform --------------------------------------------------------------------------------------------
SELECT is(pg_temp.platform('b1', '66666666-0000-0000-0000-000000000006'), 'matrix', 'a bound channel is Matrix');
SELECT is(pg_temp.platform('b1', 'f3030000-0000-0000-0000-0000000000c5'), NULL, 'an unbound channel is nothing');
SELECT is(pg_temp.platform('d1', '66666666-0000-0000-0000-000000000006'), 'discord', 'a paired Discord v2 channel is Discord');
SELECT is(pg_temp.platform('d1', 'f3030000-0000-0000-0000-0000000000c2'), NULL, 'an unpaired channel of the v2 bridge is nothing');
SELECT is(pg_temp.platform('d2', 'f3030000-0000-0000-0000-0000000000c4'), 'discord',
          'a v1 pairing whose creator owns the bridge bot is Discord');
SELECT is(pg_temp.platform('d2', '66666666-0000-0000-0000-000000000006'), NULL,
          'a v1 bridge bot in a server without a pairing is nothing');
SELECT is(pg_temp.platform('d4', 'f3030000-0000-0000-0000-0000000000c4'), NULL,
          'a bridge bot neither owned nor installed by the pairing''s creator or the server owner is nothing');
UPDATE public.bot_server_permissions SET installed_by = '11111111-0000-0000-0000-000000000001'
 WHERE bot_id = 'f3030000-0000-0000-0000-0000000000d4';
SELECT is(pg_temp.platform('d4', 'f3030000-0000-0000-0000-0000000000c4'), 'discord',
          'installed by the server owner, it is trusted');
SELECT is(pg_temp.platform('a1', '66666666-0000-0000-0000-000000000006'), NULL, 'an ordinary bot is nothing');
UPDATE public.bot_server_permissions SET is_active = false
 WHERE bot_id = 'f3030000-0000-0000-0000-0000000000b1' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.platform('b1', '66666666-0000-0000-0000-000000000006'), NULL, 'an inactive install is nothing');
UPDATE public.bot_server_permissions SET is_active = true, send_messages = false
 WHERE bot_id = 'f3030000-0000-0000-0000-0000000000b1' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.platform('b1', '66666666-0000-0000-0000-000000000006'), NULL, 'an install that cannot send is nothing');
UPDATE public.bot_server_permissions SET send_messages = true
 WHERE bot_id = 'f3030000-0000-0000-0000-0000000000b1' AND server_id = '55555555-0000-0000-0000-000000000005';

-- Rooms and modes -------------------------------------------------------------------------------------
SELECT is(public.matrix_bridge_bind_room('f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
              '!room303:example.org', 'ghost'),
          '{"room_id": "!room303:example.org", "sender_mode": "ghost"}'::jsonb, 'the first room binds with its mode');
SELECT is(public.matrix_bridge_bind_room('f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
              '!room303:example.org', 'relay'),
          '{"room_id": "!room303:example.org", "sender_mode": "ghost"}'::jsonb, 'binding the same room again changes nothing');
SELECT throws_ok($q$SELECT public.matrix_bridge_bind_room('f3030000-0000-0000-0000-0000000000b1',
                     '66666666-0000-0000-0000-000000000006', '!other303', 'relay')$q$,
                 '22023', 'Remove the binding before assigning another Matrix room', 'another room needs the binding removed');
SELECT throws_ok($q$SELECT public.matrix_bridge_bind_room('f3030000-0000-0000-0000-0000000000b1',
                     'f3030000-0000-0000-0000-0000000000c2', '!room303:example.org', 'relay')$q$,
                 '23505', NULL, 'a room bound to another channel is refused');
SELECT throws_ok($q$SELECT public.matrix_bridge_bind_room('f3030000-0000-0000-0000-0000000000b1',
                     'f3030000-0000-0000-0000-0000000000c2', '#alias:example.org', 'relay')$q$,
                 '22023', NULL, 'a room alias is no room id');
SELECT throws_ok($q$SELECT public.matrix_bridge_bind_room('f3030000-0000-0000-0000-0000000000d1',
                     '66666666-0000-0000-0000-000000000006', '!d303', 'relay')$q$,
                 '42501', NULL, 'a bot without a Matrix binding binds no room');
SELECT is(public.matrix_bridge_room('f3030000-0000-0000-0000-0000000000b1', 'f3030000-0000-0000-0000-0000000000c2'),
          '{"room_id": null, "sender_mode": "relay"}'::jsonb, 'an unbound room reads as null');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.set_matrix_bridge_sender_mode('f3030000-0000-0000-0000-0000000000b1',
               'f3030000-0000-0000-0000-0000000000c2', 'ghost') - 'bot_display_name'),
          '{"bot_id": "f3030000-0000-0000-0000-0000000000b1", "bot_username": "mx303",
            "channel_id": "f3030000-0000-0000-0000-0000000000c2", "channel_name": "second", "room_id": null,
            "sender_mode": "ghost", "sender_mode_set_by_manager": true, "active": true}'::jsonb,
          'a manager sets a mode before the room binds');
SELECT throws_ok($q$SELECT public.set_matrix_bridge_sender_mode('f3030000-0000-0000-0000-0000000000b1',
                     'f3030000-0000-0000-0000-0000000000c2', 'mirror')$q$,
                 '22023', NULL, 'an unknown mode is refused');
SELECT throws_ok($q$SELECT public.set_matrix_bridge_sender_mode('f3030000-0000-0000-0000-0000000000b1',
                     'f3030000-0000-0000-0000-0000000000c5', 'ghost')$q$,
                 'P0002', NULL, 'a channel without a binding has no mode');
SELECT tests.clear_authentication();
SELECT is(public.matrix_bridge_bind_room('f3030000-0000-0000-0000-0000000000b1', 'f3030000-0000-0000-0000-0000000000c2',
              '!second303', 'relay') ->> 'sender_mode',
          'ghost', 'the manager''s mode outlives the initial one');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(jsonb_array_length(public.get_server_matrix_bridges('55555555-0000-0000-0000-000000000005')), 3,
          'the manager lists every binding of the server');
SELECT is(public.configure_matrix_bridge('f3030000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
              ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]),
          true, 'reconfiguring drops a channel');
SELECT is((SELECT jsonb_agg(e ->> 'channel_name' || ':' || (e ->> 'room_id') || ':' || (e ->> 'sender_mode') ORDER BY e ->> 'channel_name')
             FROM jsonb_array_elements(public.get_server_matrix_bridges('55555555-0000-0000-0000-000000000005')) e
            WHERE e ->> 'bot_id' = 'f3030000-0000-0000-0000-0000000000b1'),
          '["general:!room303:example.org:ghost"]'::jsonb, 'a kept channel keeps its room and mode');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.get_server_matrix_bridges('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', 'MANAGE_SERVER required', 'a member does not list bindings');
SELECT throws_ok($q$SELECT public.set_matrix_bridge_sender_mode('f3030000-0000-0000-0000-0000000000b1',
                     '66666666-0000-0000-0000-000000000006', 'relay')$q$,
                 '42501', 'MANAGE_SERVER required', 'a member sets no mode');
SELECT throws_ok($q$SELECT public.unconfigure_matrix_bridge('f3030000-0000-0000-0000-0000000000b1',
                     '55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'a member who neither owns the bot nor manages the server removes nothing');
SELECT tests.clear_authentication();

-- Members ---------------------------------------------------------------------------------------------
SELECT is((SELECT array_agg(m.username ORDER BY m.id) FROM public.matrix_bridge_channel_members(
              'f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006') m),
          ARRAY['alice', 'bob'], 'accepted local members of an open channel, in id order; banned and outsiders left out');
SELECT is((SELECT array_agg(m.username) FROM public.matrix_bridge_channel_members(
              'f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 1) m),
          ARRAY['alice'], 'limit bounds a page');
SELECT is((SELECT array_agg(m.username) FROM public.matrix_bridge_channel_members(
              'f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 1,
              '11111111-0000-0000-0000-000000000001') m),
          ARRAY['bob'], 'after continues past an id');
SELECT throws_ok($q$SELECT * FROM public.matrix_bridge_channel_members('f3030000-0000-0000-0000-0000000000d1',
                     '66666666-0000-0000-0000-000000000006')$q$,
                 '42501', NULL, 'a bot without a Matrix binding reads no members');

-- general restricted: @everyone loses VIEW_CHANNEL (bit 1, value 2), bob regains it.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT '66666666-0000-0000-0000-000000000006', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
SELECT is((SELECT array_agg(m.username ORDER BY m.id) FROM public.matrix_bridge_channel_members(
              'f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006') m),
          ARRAY['alice'], 'a restricted channel lists its viewers: the owner');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
VALUES ('66666666-0000-0000-0000-000000000006', 'user', NULL, '22222222-0000-0000-0000-000000000002', 2, 0);
SELECT is((SELECT array_agg(m.username ORDER BY m.id) FROM public.matrix_bridge_channel_members(
              'f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006') m),
          ARRAY['alice', 'bob'], 'a member override that allows the channel adds its member');

-- Member opt-out --------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.bridge_member_privacy('55555555-0000-0000-0000-000000000005'),
          '{"discord": {"bridged": true, "opted_out": false}, "matrix": {"bridged": true, "opted_out": false}}'::jsonb,
          'a member sees both bridges and no opt-out');
SELECT is(public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'matrix', true),
          '{"discord": {"bridged": true, "opted_out": false}, "matrix": {"bridged": true, "opted_out": true}}'::jsonb,
          'opting out of Matrix leaves Discord');
SELECT lives_ok($q$SELECT public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'matrix', true)$q$,
                'opting out twice is a no-op');
SELECT throws_ok($q$SELECT public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'slack', true)$q$,
                 '22023', NULL, 'an unknown platform is refused');
SELECT is((SELECT count(*)::integer FROM public.bridge_member_optouts), 1, 'a member reads their own row');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::integer FROM public.bridge_member_optouts), 0, 'another member reads none of it');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'discord', true)$q$,
                 '42501', 'Accepted membership required', 'an outsider cannot opt out');
SELECT is(public.bridge_member_privacy('55555555-0000-0000-0000-000000000005'),
          '{"discord": {"bridged": false, "opted_out": false}, "matrix": {"bridged": false, "opted_out": false}}'::jsonb,
          'an outsider learns nothing of the server''s bridges');
SELECT tests.clear_authentication();

SELECT is(public.bridge_member_optout_ids('55555555-0000-0000-0000-000000000005', 'matrix'),
          '{"user_ids": ["22222222-0000-0000-0000-000000000002"]}'::jsonb, 'the gateway reads the opted-out ids');
SELECT is((SELECT array_agg(m.username ORDER BY m.id) FROM public.matrix_bridge_channel_members(
              'f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006') m),
          ARRAY['alice'], 'an opted-out member gets no Matrix ghost');
SELECT is(ARRAY[public.bridge_member_relay_allowed('f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002'),
                public.bridge_member_relay_allowed('f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001'),
                public.bridge_member_relay_allowed('f3030000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002'),
                public.bridge_member_relay_allowed('f3030000-0000-0000-0000-0000000000a1', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002')],
          ARRAY[false, true, true, true],
          'relay is refused to the Matrix bridge alone, for the member who opted out of Matrix');

-- The row outlives the membership.
DELETE FROM public.user_servers
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(public.bridge_member_relay_allowed('f3030000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
              '22222222-0000-0000-0000-000000000002'),
          false, 'leaving the server keeps the opt-out');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_bridge_member_optout('55555555-0000-0000-0000-000000000005', 'matrix', false) -> 'matrix',
          '{"bridged": false, "opted_out": false}'::jsonb, 'a former member opts back in');
SELECT tests.clear_authentication();
SELECT ok((SELECT bool_and(confdeltype = 'c') FROM pg_constraint
            WHERE conrelid = 'public.bridge_member_optouts'::regclass AND contype = 'f'),
          'the rows go with their server or profile');

-- Unconfigure -----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.unconfigure_matrix_bridge('f3030000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005'),
          true, 'the owner removes the server''s bindings');
SELECT tests.clear_authentication();
SELECT is((SELECT (bridge_platform IS NULL, bot_type,
                   (SELECT count(*) FROM public.bridge_channels bc WHERE bc.bot_id = b.id))::text
             FROM public.bots b WHERE b.id = 'f3030000-0000-0000-0000-0000000000b1'),
          '(t,bot,0)', 'a bot with no binding left is an ordinary bot again');

-- Triggers --------------------------------------------------------------------------------------------
SELECT is((SELECT count(*)::integer FROM pg_trigger t
            WHERE t.tgrelid IN ('public.messages'::regclass, 'public.reactions'::regclass,
                                'public.user_servers'::regclass, 'public.profiles'::regclass, 'public.bots'::regclass)
              AND t.tgname IN ('a_messages_matrix_author_guard', 'a_reactions_matrix_author_guard',
                               'a_messages_bridge_optout_guard', 'a_reactions_bridge_optout_guard',
                               'a_bots_bridge_platform_guard')
              AND t.tgqual IS NOT NULL),
          5, 'every trigger of the Matrix bridge has a WHEN clause');

SELECT * FROM finish();
ROLLBACK;
