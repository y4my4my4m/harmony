-- Bots in a server's member list after 20261006000001_server_member_bots.sql: get_server_bots,
-- the server-structure broadcasts that keep the list current, and get_bot_profile.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not, banned holds a banned row.
-- Added here:
--   owner60    owns every bot below and server s60; not a member of server_1
--   admin60    instance admin, member of nothing
--   pending60  pending row on server_1
--   alpha60    public bot, installed in server_1 and s60, presence online with an activity
--   bravo60    private bot, installed in server_1, no presence row
--   charlie60  public bot, installation in server_1 inactive
--   delta60    inactive bot, installation in server_1 active
--   echo60     public bot, installed in s60 only, support server p60
--   foxtrot60  private bot, installation in server_1 inactive
--   p60        public server owned by owner60

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(48);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f6000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner60@test.local'),
  ('f6000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin60@test.local'),
  ('f6000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pending60@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('f6010000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000001', 'owner60', 'Owner 60', true, false),
  ('f6010000-0000-0000-0000-000000000002', 'f6000000-0000-0000-0000-000000000002', 'admin60', 'Admin 60', true, true),
  ('f6010000-0000-0000-0000-000000000003', 'f6000000-0000-0000-0000-000000000003', 'pending60', 'Pending 60', true, false);

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('f6010000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'pending');

INSERT INTO public.servers (id, name, owner, public) VALUES
  ('f6030000-0000-0000-0000-000000000001', 's60', 'f6010000-0000-0000-0000-000000000001', false),
  ('f6030000-0000-0000-0000-000000000002', 'p60', 'f6010000-0000-0000-0000-000000000001', true);

INSERT INTO public.bots (id, username, display_name, avatar_url, owner_id, is_public, is_active, bot_type) VALUES
  ('f6020000-0000-0000-0000-00000000000a', 'alpha60',   'Alpha',   'https://cdn.test/alpha.png', 'f6010000-0000-0000-0000-000000000001', true,  true,  'bot'),
  ('f6020000-0000-0000-0000-00000000000b', 'bravo60',   NULL,      NULL,                         'f6010000-0000-0000-0000-000000000001', false, true,  'bridge'),
  ('f6020000-0000-0000-0000-00000000000c', 'charlie60', 'Charlie', NULL,                         'f6010000-0000-0000-0000-000000000001', true,  true,  'bot'),
  ('f6020000-0000-0000-0000-00000000000d', 'delta60',   'Delta',   NULL,                         'f6010000-0000-0000-0000-000000000001', true,  false, 'bot'),
  ('f6020000-0000-0000-0000-00000000000e', 'echo60',    'Echo',    NULL,                         'f6010000-0000-0000-0000-000000000001', true,  true,  'bot'),
  ('f6020000-0000-0000-0000-00000000000f', 'foxtrot60', 'Foxtrot', NULL,                         'f6010000-0000-0000-0000-000000000001', false, true,  'bot');
UPDATE public.bots SET bio = 'Plays chess.', website_url = 'https://alpha.test', is_verified = true,
                       banner_url = 'https://cdn.test/alpha-banner.png',
                       support_server_id = 'f6030000-0000-0000-0000-000000000001'
 WHERE id = 'f6020000-0000-0000-0000-00000000000a';
UPDATE public.bots SET support_server_id = 'f6030000-0000-0000-0000-000000000002'
 WHERE id = 'f6020000-0000-0000-0000-00000000000e';

INSERT INTO public.bot_commands (bot_id, name, description) VALUES
  ('f6020000-0000-0000-0000-00000000000a', 'resign', 'Concede the game'),
  ('f6020000-0000-0000-0000-00000000000a', 'Move', 'Play a move'),
  ('f6020000-0000-0000-0000-00000000000a', 'board', 'Show the board');

INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, is_active) VALUES
  ('f6020000-0000-0000-0000-00000000000a', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', true),
  ('f6020000-0000-0000-0000-00000000000b', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', true),
  ('f6020000-0000-0000-0000-00000000000c', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', false),
  ('f6020000-0000-0000-0000-00000000000d', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', true),
  ('f6020000-0000-0000-0000-00000000000a', 'f6030000-0000-0000-0000-000000000001', 'f6010000-0000-0000-0000-000000000001', true),
  ('f6020000-0000-0000-0000-00000000000e', 'f6030000-0000-0000-0000-000000000001', 'f6010000-0000-0000-0000-000000000001', true),
  ('f6020000-0000-0000-0000-00000000000f', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', false);

INSERT INTO public.bot_presence (bot_id, status, custom_status, activity_type, activity_name, last_heartbeat_at)
VALUES ('f6020000-0000-0000-0000-00000000000a', 'online', 'beep boop', 'playing', 'chess', now());

-- Surface ---------------------------------------------------------------------------------
SELECT ok((SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_temp']
             FROM pg_proc p WHERE p.oid = 'public.get_server_bots(uuid)'::regprocedure),
          'get_server_bots is SECURITY DEFINER with a pinned search_path');
SELECT is((SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
            WHERE p.oid = 'public.get_server_bots(uuid)'::regprocedure),
          'postgres', 'get_server_bots is owned by postgres');
SELECT ok(NOT has_function_privilege('anon', 'public.get_server_bots(uuid)', 'EXECUTE')
          AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                           WHERE p.oid = 'public.get_server_bots(uuid)'::regprocedure AND a.grantee = 0)
          AND has_function_privilege('authenticated', 'public.get_server_bots(uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.get_server_bots(uuid)', 'EXECUTE'),
          'authenticated and service_role execute get_server_bots; PUBLIC and anon do not');
SELECT ok(NOT has_function_privilege('anon', 'public.broadcast_bot_installation_change()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.broadcast_bot_installation_change()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.broadcast_bot_presence_change()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.broadcast_bot_presence_change()', 'EXECUTE'),
          'clients hold no EXECUTE on the bot broadcast triggers');
SELECT has_column('public', 'bot_presence', 'custom_status', 'bot_presence carries custom_status');
SELECT ok((SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_temp']
                  AND pg_get_userbyid(p.proowner) = 'postgres'
             FROM pg_proc p WHERE p.oid = 'public.get_bot_profile(uuid)'::regprocedure),
          'get_bot_profile is SECURITY DEFINER with a pinned search_path, owned by postgres');
SELECT ok(NOT has_function_privilege('anon', 'public.get_bot_profile(uuid)', 'EXECUTE')
          AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                           WHERE p.oid = 'public.get_bot_profile(uuid)'::regprocedure AND a.grantee = 0)
          AND has_function_privilege('authenticated', 'public.get_bot_profile(uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.get_bot_profile(uuid)', 'EXECUTE'),
          'authenticated and service_role execute get_bot_profile; PUBLIC and anon do not');

-- Visibility ------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_eq(
    $q$SELECT id FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')$q$,
    ARRAY['f6020000-0000-0000-0000-00000000000a', 'f6020000-0000-0000-0000-00000000000b']::uuid[],
    'a member sees the active bots installed in the server');
SELECT is((SELECT count(*)::int FROM public.bots WHERE id = 'f6020000-0000-0000-0000-00000000000b'),
          0, 'the bots policy hides the private bot from the member');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')
        WHERE id = 'f6020000-0000-0000-0000-00000000000c'$q$,
    'an inactive installation is excluded');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')
        WHERE id = 'f6020000-0000-0000-0000-00000000000d'$q$,
    'an inactive bot is excluded');
SELECT results_eq(
    $q$SELECT username, display_name, avatar_url, bot_type, status, custom_status, activity_type, activity_name
         FROM public.get_server_bots('55555555-0000-0000-0000-000000000005') ORDER BY username$q$,
    $q$VALUES ('alpha60'::text, 'Alpha'::text, 'https://cdn.test/alpha.png'::text, 'bot'::text,
               'online'::text, 'beep boop'::text, 'playing'::text, 'chess'::text),
              ('bravo60', NULL, NULL, 'bridge', 'offline', NULL, NULL, NULL)$q$,
    'rows carry identity and presence; a bot without presence reads offline');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_server_bots('f6030000-0000-0000-0000-000000000001')$q$,
    'a member of one server sees no bots of another');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty($q$SELECT 1 FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')$q$,
                'a non-member sees no bots');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is_empty($q$SELECT 1 FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')$q$,
                'a banned member sees no bots');
SELECT tests.authenticate_as('f6000000-0000-0000-0000-000000000003');
SELECT is_empty($q$SELECT 1 FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')$q$,
                'a pending member sees no bots');
SELECT tests.authenticate_as('f6000000-0000-0000-0000-000000000002');
SELECT set_eq(
    $q$SELECT id FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')$q$,
    ARRAY['f6020000-0000-0000-0000-00000000000a', 'f6020000-0000-0000-0000-00000000000b']::uuid[],
    'an instance admin outside the server sees its bots');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT * FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'anon cannot call get_server_bots');
SELECT tests.clear_authentication();
SELECT is_empty($q$SELECT 1 FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')$q$,
                'a session with no profile sees no bots');

-- Profile ---------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.profile60(p_auth uuid, p_bot uuid) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
    v jsonb;
BEGIN
    IF p_auth IS NULL THEN
        PERFORM tests.clear_authentication();
    ELSE
        PERFORM tests.authenticate_as(p_auth);
    END IF;
    v := public.get_bot_profile(p_bot);
    PERFORM tests.clear_authentication();
    RETURN v;
END;
$fn$;

SELECT is(pg_temp.profile60('cccccccc-0000-0000-0000-000000000003', 'f6020000-0000-0000-0000-00000000000a') ->> 'username',
          'alpha60', 'a public bot is visible to a non-member');
SELECT is(pg_temp.profile60(NULL, 'f6020000-0000-0000-0000-00000000000a') ->> 'username',
          'alpha60', 'a public bot is visible to a session with no profile');
SELECT is(pg_temp.profile60('bbbbbbbb-0000-0000-0000-000000000002', 'f6020000-0000-0000-0000-00000000000b') ->> 'username',
          'bravo60', 'a private bot is visible to a member of a server it is installed in');
SELECT is(pg_temp.profile60('cccccccc-0000-0000-0000-000000000003', 'f6020000-0000-0000-0000-00000000000b'),
          NULL::jsonb, 'a private bot is hidden from a non-member');
SELECT is(pg_temp.profile60('dddddddd-0000-0000-0000-000000000004', 'f6020000-0000-0000-0000-00000000000b'),
          NULL::jsonb, 'a private bot is hidden from a banned member');
SELECT is(pg_temp.profile60('f6000000-0000-0000-0000-000000000003', 'f6020000-0000-0000-0000-00000000000b'),
          NULL::jsonb, 'a private bot is hidden from a pending member');
SELECT is(pg_temp.profile60(NULL, 'f6020000-0000-0000-0000-00000000000b'),
          NULL::jsonb, 'a private bot is hidden from a session with no profile');
SELECT is(pg_temp.profile60('f6000000-0000-0000-0000-000000000002', 'f6020000-0000-0000-0000-00000000000b') ->> 'username',
          'bravo60', 'a private bot is visible to an instance admin');
SELECT is(pg_temp.profile60('f6000000-0000-0000-0000-000000000001', 'f6020000-0000-0000-0000-00000000000f') ->> 'username',
          'foxtrot60', 'a private bot is visible to its owner');
SELECT is(pg_temp.profile60('bbbbbbbb-0000-0000-0000-000000000002', 'f6020000-0000-0000-0000-00000000000f'),
          NULL::jsonb, 'an inactive installation does not expose a private bot');
SELECT is(pg_temp.profile60('f6000000-0000-0000-0000-000000000002', 'f6020000-0000-0000-0000-00000000000d'),
          NULL::jsonb, 'an inactive bot is hidden from everyone');

SELECT is(pg_temp.profile60('cccccccc-0000-0000-0000-000000000003', 'f6020000-0000-0000-0000-00000000000a')
            - 'created_at' - 'id' - 'presence',
          jsonb_build_object(
              'username', 'alpha60', 'display_name', 'Alpha', 'avatar_url', 'https://cdn.test/alpha.png',
              'banner_url', 'https://cdn.test/alpha-banner.png', 'bio', 'Plays chess.', 'bot_type', 'bot',
              'is_verified', true, 'is_public', true, 'website_url', 'https://alpha.test',
              'support_server', NULL,
              'commands', jsonb_build_array(
                  jsonb_build_object('name', 'board', 'description', 'Show the board'),
                  jsonb_build_object('name', 'Move', 'description', 'Play a move'),
                  jsonb_build_object('name', 'resign', 'description', 'Concede the game'))),
          'the profile carries identity, bio, website and commands by name; a private support server is omitted');
SELECT is((pg_temp.profile60('cccccccc-0000-0000-0000-000000000003', 'f6020000-0000-0000-0000-00000000000a') -> 'presence')
            - 'last_heartbeat_at',
          '{"status": "online", "custom_status": "beep boop", "activity_type": "playing", "activity_name": "chess"}'::jsonb,
          'the profile carries presence');
SELECT is(pg_temp.profile60('cccccccc-0000-0000-0000-000000000003', 'f6020000-0000-0000-0000-00000000000e') -> 'support_server',
          '{"id": "f6030000-0000-0000-0000-000000000002", "name": "p60", "icon": null}'::jsonb,
          'a public support server is included');
SELECT ok((pg_temp.profile60('bbbbbbbb-0000-0000-0000-000000000002', 'f6020000-0000-0000-0000-00000000000b') -> 'presence') = 'null'::jsonb
          AND (pg_temp.profile60('bbbbbbbb-0000-0000-0000-000000000002', 'f6020000-0000-0000-0000-00000000000b') -> 'commands') = '[]'::jsonb,
          'a bot without presence or commands reads null and an empty list');

INSERT INTO public.bot_commands (bot_id, name, description)
SELECT 'f6020000-0000-0000-0000-00000000000e', 'cmd' || lpad(g::text, 3, '0'), 'command ' || g
  FROM generate_series(1, 120) g;
SELECT is(jsonb_array_length(pg_temp.profile60('cccccccc-0000-0000-0000-000000000003', 'f6020000-0000-0000-0000-00000000000e') -> 'commands'),
          100, 'at most 100 commands are returned');
SELECT is(pg_temp.profile60('cccccccc-0000-0000-0000-000000000003', 'f6020000-0000-0000-0000-00000000000e') -> 'commands' -> 99 ->> 'name',
          'cmd100', 'the first 100 by name');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.get_bot_profile('f6020000-0000-0000-0000-00000000000a')$q$,
                 '42501', NULL, 'anon cannot call get_bot_profile');
SELECT tests.clear_authentication();

-- Presence --------------------------------------------------------------------------------
UPDATE public.bot_presence SET status = 'idle', custom_status = NULL, activity_type = 'watching', activity_name = 'logs'
 WHERE bot_id = 'f6020000-0000-0000-0000-00000000000a';
INSERT INTO public.bot_presence (bot_id, status, last_heartbeat_at)
VALUES ('f6020000-0000-0000-0000-00000000000b', 'dnd', now());

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT results_eq(
    $q$SELECT username, status, custom_status, activity_type, activity_name
         FROM public.get_server_bots('55555555-0000-0000-0000-000000000005') ORDER BY username$q$,
    $q$VALUES ('alpha60'::text, 'idle'::text, NULL::text, 'watching'::text, 'logs'::text),
              ('bravo60', 'dnd', NULL, NULL, NULL)$q$,
    'presence changes are reflected');
SELECT tests.clear_authentication();

-- Broadcasts ------------------------------------------------------------------------------
CREATE TEMP TABLE rt60 AS SELECT id FROM realtime.messages;

CREATE FUNCTION pg_temp.sent60() RETURNS TABLE (topic text, type text, bot text)
LANGUAGE sql AS $fn$
    SELECT m.topic, m.payload->>'type', m.payload->>'bot_id'
      FROM realtime.messages m
     WHERE m.payload->>'type' LIKE 'bot:%' AND m.id NOT IN (SELECT id FROM rt60)
     ORDER BY 1, 2, 3;
$fn$;
CREATE FUNCTION pg_temp.mark60() RETURNS void LANGUAGE sql AS $fn$
    INSERT INTO rt60 SELECT m.id FROM realtime.messages m WHERE m.id NOT IN (SELECT id FROM rt60);
$fn$;

UPDATE public.bot_server_permissions SET is_active = true
 WHERE bot_id = 'f6020000-0000-0000-0000-00000000000c' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT results_eq('SELECT * FROM pg_temp.sent60()',
    $q$VALUES ('server-structure:55555555-0000-0000-0000-000000000005'::text, 'bot:update'::text,
               'f6020000-0000-0000-0000-00000000000c'::text)$q$,
    'reactivating an installation broadcasts to the server');
SELECT pg_temp.mark60();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT ok(EXISTS (SELECT 1 FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')
                   WHERE id = 'f6020000-0000-0000-0000-00000000000c'),
          'a reactivated installation is listed');
SELECT tests.clear_authentication();

UPDATE public.bot_server_permissions SET send_messages = false
 WHERE bot_id = 'f6020000-0000-0000-0000-00000000000c' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is_empty('SELECT * FROM pg_temp.sent60()', 'a permission change broadcasts nothing');

UPDATE public.bot_server_permissions SET is_active = false
 WHERE bot_id = 'f6020000-0000-0000-0000-00000000000c' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT results_eq('SELECT type FROM pg_temp.sent60()', $q$VALUES ('bot:update'::text)$q$,
                  'removing a bot broadcasts to the server');
SELECT pg_temp.mark60();

INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, is_active)
VALUES ('f6020000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', true);
SELECT results_eq('SELECT * FROM pg_temp.sent60()',
    $q$VALUES ('server-structure:55555555-0000-0000-0000-000000000005'::text, 'bot:insert'::text,
               'f6020000-0000-0000-0000-00000000000e'::text)$q$,
    'installing a bot broadcasts to the server');
SELECT pg_temp.mark60();

DELETE FROM public.bot_server_permissions
 WHERE bot_id = 'f6020000-0000-0000-0000-00000000000e' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT results_eq('SELECT type FROM pg_temp.sent60()', $q$VALUES ('bot:delete'::text)$q$,
                  'deleting an installation broadcasts to the server');
SELECT pg_temp.mark60();

UPDATE public.bot_presence SET status = 'online' WHERE bot_id = 'f6020000-0000-0000-0000-00000000000a';
SELECT results_eq('SELECT * FROM pg_temp.sent60()',
    $q$VALUES ('server-structure:55555555-0000-0000-0000-000000000005'::text, 'bot:presence'::text,
               'f6020000-0000-0000-0000-00000000000a'::text),
              ('server-structure:f6030000-0000-0000-0000-000000000001', 'bot:presence',
               'f6020000-0000-0000-0000-00000000000a')$q$,
    'a status change broadcasts once to each server the bot is installed in');
SELECT pg_temp.mark60();

UPDATE public.bot_presence SET last_heartbeat_at = now() + interval '30 seconds', latency_ms = 4
 WHERE bot_id = 'f6020000-0000-0000-0000-00000000000a';
UPDATE public.bot_presence SET status = 'online', activity_name = 'logs'
 WHERE bot_id = 'f6020000-0000-0000-0000-00000000000a';
SELECT is_empty('SELECT * FROM pg_temp.sent60()', 'heartbeats and unchanged writes broadcast nothing');

INSERT INTO public.bot_presence (bot_id, status) VALUES ('f6020000-0000-0000-0000-00000000000d', 'online');
UPDATE public.bot_presence SET status = 'offline' WHERE bot_id = 'f6020000-0000-0000-0000-00000000000b';
SELECT results_eq('SELECT * FROM pg_temp.sent60()',
    $q$VALUES ('server-structure:55555555-0000-0000-0000-000000000005'::text, 'bot:presence'::text,
               'f6020000-0000-0000-0000-00000000000b'::text)$q$,
    'presence of an inactive bot broadcasts nothing');
SELECT pg_temp.mark60();

UPDATE public.bot_server_permissions SET is_active = false
 WHERE bot_id = 'f6020000-0000-0000-0000-00000000000a' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_eq(
    $q$SELECT id FROM public.get_server_bots('55555555-0000-0000-0000-000000000005')$q$,
    ARRAY['f6020000-0000-0000-0000-00000000000b']::uuid[],
    'a removed bot leaves the list');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
