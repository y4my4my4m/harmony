-- 20261010100001_system_channel_setting.sql: set_server_system_channel, text channels only,
-- system_messages_enabled, a fallback @everyone can view, and joins by UPDATE to accepted.
--
--   server_1 (55555555-...05)  owner alice; announcements104 (f104...a1), voice104 (f104...a2),
--                              general (f104...a3, @everyone VIEW_CHANNEL denied, order -1)
--   server_2 (f104...02)       owner bob; lobby104 (f104...b1)
--   managers104 (f104...d1)    MANAGE_SERVER on server_1, given to bob mid-test
--   p104 (f104...e2)           joins server_1 as pending, then is accepted
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(37);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO public.servers (id, name, owner)
VALUES ('f1040000-0000-0000-0000-000000000002', 'Server 104', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.channels (id, server_id, name, type, "order") VALUES
  ('f1040000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'announcements104', 0, 5),
  ('f1040000-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000005', 'voice104', 1, 6),
  ('f1040000-0000-0000-0000-0000000000a3', '55555555-0000-0000-0000-000000000005', 'general', 0, -1),
  ('f1040000-0000-0000-0000-0000000000b1', 'f1040000-0000-0000-0000-000000000002', 'lobby104', 0, 0);
-- VIEW_CHANNEL is bit 1.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f1040000-0000-0000-0000-0000000000a3', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
-- MANAGE_SERVER is bit 7.
INSERT INTO public.server_roles (id, server_id, name, position, permissions)
VALUES ('f1040000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'managers104', 3, 128);

INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('f1040000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'p104@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('f1040000-0000-0000-0000-0000000000e2', 'f1040000-0000-0000-0000-0000000000e1', 'p104', 'P104', true);

-- System messages of p_type about p_user in server_1, optionally in one channel.
CREATE FUNCTION pg_temp.sys(p_user uuid, p_type text, p_channel uuid DEFAULT NULL)
RETURNS integer LANGUAGE sql AS $fn$
  SELECT count(*)::integer
    FROM public.messages m
    JOIN public.channels c ON c.id = m.channel_id
   WHERE c.server_id = '55555555-0000-0000-0000-000000000005'
     AND m.user_id = p_user
     AND m.is_system
     AND m.metadata ->> 'type' = p_type
     AND (p_channel IS NULL OR m.channel_id = p_channel);
$fn$;

-- Shape. ------------------------------------------------------------------------------------------
SELECT col_not_null('public', 'server_settings', 'system_messages_enabled',
                    'system_messages_enabled is NOT NULL');
SELECT col_default_is('public', 'server_settings', 'system_messages_enabled', 'true',
                      'system_messages_enabled defaults to true');
SELECT ok(has_column_privilege('authenticated', 'public.server_settings', 'system_messages_enabled', 'SELECT'),
          'authenticated reads system_messages_enabled');
SELECT ok(has_function_privilege('authenticated', 'public.set_server_system_channel(uuid,uuid,boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_server_system_channel(uuid,uuid,boolean)', 'EXECUTE'),
          'set_server_system_channel is for authenticated, not anon');
SELECT ok(NOT has_function_privilege('anon', 'public.kick_server_member(uuid,uuid,text,integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.ban_server_member(uuid,uuid,text,integer)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.kick_server_member(uuid,uuid,text,integer)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.ban_server_member(uuid,uuid,text,integer)', 'EXECUTE'),
          'kick_server_member and ban_server_member are for authenticated, not anon');
SELECT ok(has_function_privilege('authenticated', 'public.get_default_channel(uuid)', 'EXECUTE')
          AND has_function_privilege('anon', 'public.get_default_channel(uuid)', 'EXECUTE'),
          'get_default_channel keeps its grants');

-- Writes. -----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_server_system_channel('55555555-0000-0000-0000-000000000005',
                                           'f1040000-0000-0000-0000-0000000000a1', true),
          '{"system_channel_id": "f1040000-0000-0000-0000-0000000000a1", "system_messages_enabled": true}'::jsonb,
          'the owner sets a text channel');
SELECT throws_ok($$SELECT public.set_server_system_channel('55555555-0000-0000-0000-000000000005',
                                                           'f1040000-0000-0000-0000-0000000000a2', true)$$,
                 '22023', NULL, 'a voice channel is refused');
SELECT throws_ok($$SELECT public.set_server_system_channel('55555555-0000-0000-0000-000000000005',
                                                           'f1040000-0000-0000-0000-0000000000b1', true)$$,
                 '23514', NULL, 'another server''s channel is refused');
SELECT throws_ok($$SELECT public.set_server_system_channel('55555555-0000-0000-0000-000000000005', NULL, NULL)$$,
                 '22004', NULL, 'p_enabled NULL is refused');
SELECT throws_ok($$UPDATE public.server_settings SET system_channel_id = 'f1040000-0000-0000-0000-0000000000a2'
                    WHERE server_id = '55555555-0000-0000-0000-000000000005'$$,
                 '22023', NULL, 'a direct write of a voice channel is refused');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.set_server_system_channel('55555555-0000-0000-0000-000000000005', NULL, false)$$,
                 '42501', NULL, 'a member without MANAGE_SERVER is refused');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$SELECT public.set_server_system_channel('55555555-0000-0000-0000-000000000005', NULL, false)$$,
                 '42501', NULL, 'a non-member is refused');

SELECT tests.clear_authentication();
SELECT is((SELECT ROW(system_channel_id, system_messages_enabled)::text FROM public.server_settings
            WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          ROW('f1040000-0000-0000-0000-0000000000a1'::uuid, true)::text,
          'the refused writes change nothing');

INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1040000-0000-0000-0000-0000000000d1',
        '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_system_channel('55555555-0000-0000-0000-000000000005', NULL, true),
          '{"system_channel_id": null, "system_messages_enabled": true}'::jsonb,
          'a member with MANAGE_SERVER selects the automatic channel');
SELECT tests.clear_authentication();

-- Fallback. ---------------------------------------------------------------------------------------
SELECT is((SELECT c.id FROM public.channels c
            WHERE c.server_id = '55555555-0000-0000-0000-000000000005' AND c.type = 0
            ORDER BY CASE WHEN c.name = 'general' THEN 0 ELSE 1 END, c."order", c.created_at
            LIMIT 1),
          'f1040000-0000-0000-0000-0000000000a3'::uuid,
          'by name and order alone the hidden general comes first');
SELECT is(public.get_default_channel('55555555-0000-0000-0000-000000000005'),
          (SELECT c.id FROM public.channels c
            WHERE c.server_id = '55555555-0000-0000-0000-000000000005' AND c.type = 0
              AND c.id <> 'f1040000-0000-0000-0000-0000000000a3'
            ORDER BY CASE WHEN c.name = 'general' THEN 0 ELSE 1 END, c."order", c.created_at
            LIMIT 1),
          'get_default_channel skips a channel @everyone cannot view');

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted');
SELECT is(pg_temp.sys('33333333-0000-0000-0000-000000000003', 'member_join',
                      public.get_default_channel('55555555-0000-0000-0000-000000000005')),
          1, 'with no system channel a join posts in the channel @everyone can view');
SELECT is(pg_temp.sys('33333333-0000-0000-0000-000000000003', 'member_join', 'f1040000-0000-0000-0000-0000000000a3'),
          0, 'and nothing in the hidden general');

-- Disabled. ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_server_system_channel('55555555-0000-0000-0000-000000000005',
                                           'f1040000-0000-0000-0000-0000000000a1', false),
          '{"system_channel_id": "f1040000-0000-0000-0000-0000000000a1", "system_messages_enabled": false}'::jsonb,
          'the owner turns system messages off');
SELECT tests.clear_authentication();

DELETE FROM public.user_servers
 WHERE user_id = '33333333-0000-0000-0000-000000000003' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.sys('33333333-0000-0000-0000-000000000003', 'member_leave'), 0,
          'disabled: a leave posts nothing');

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted');
SELECT is(pg_temp.sys('33333333-0000-0000-0000-000000000003', 'member_join'), 1,
          'disabled: a join posts nothing');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$SELECT public.kick_server_member('55555555-0000-0000-0000-000000000005',
                                                    '33333333-0000-0000-0000-000000000003')$$,
                'disabled: kick_server_member runs');
SELECT lives_ok($$SELECT public.ban_server_member('55555555-0000-0000-0000-000000000005',
                                                   '22222222-0000-0000-0000-000000000002', 'test')$$,
                'disabled: ban_server_member runs');
SELECT tests.clear_authentication();
-- kick and ban set the flag for the rest of the transaction.
SELECT set_config('harmony.skip_leave_message', '0', true);
SELECT is(pg_temp.sys('33333333-0000-0000-0000-000000000003', 'member_kick')
          + pg_temp.sys('22222222-0000-0000-0000-000000000002', 'member_ban'),
          0, 'disabled: a kick and a ban post nothing');

-- Pending to accepted. ----------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$SELECT public.set_server_system_channel('55555555-0000-0000-0000-000000000005', NULL, true)$$,
                'the owner turns system messages back on');
SELECT tests.clear_authentication();

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('f1040000-0000-0000-0000-0000000000e2', '55555555-0000-0000-0000-000000000005', 'pending');
SELECT is(pg_temp.sys('f1040000-0000-0000-0000-0000000000e2', 'member_join'), 0,
          'a pending membership posts nothing');

UPDATE public.user_servers SET status = 'accepted'
 WHERE user_id = 'f1040000-0000-0000-0000-0000000000e2' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.sys('f1040000-0000-0000-0000-0000000000e2', 'member_join',
                      public.get_default_channel('55555555-0000-0000-0000-000000000005')),
          1, 'pending to accepted posts one join message');

UPDATE public.user_servers SET nickname = 'p'
 WHERE user_id = 'f1040000-0000-0000-0000-0000000000e2' AND server_id = '55555555-0000-0000-0000-000000000005';
UPDATE public.user_servers SET status = 'accepted'
 WHERE user_id = 'f1040000-0000-0000-0000-0000000000e2' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.sys('f1040000-0000-0000-0000-0000000000e2', 'member_join'), 1,
          'later updates of an accepted membership post nothing');

DELETE FROM public.user_servers
 WHERE user_id = 'f1040000-0000-0000-0000-0000000000e2' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.sys('f1040000-0000-0000-0000-0000000000e2', 'member_leave'), 1,
          'an accepted member leaving posts one leave message');

DELETE FROM public.user_servers
 WHERE user_id = '44444444-0000-0000-0000-000000000004' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.sys('44444444-0000-0000-0000-000000000004', 'member_leave'), 0,
          'deleting a banned membership posts nothing');

-- No channel @everyone can view. ------------------------------------------------------------------
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT c.id, 'role', r.id, NULL, 0, 2
  FROM public.channels c
  JOIN public.server_roles r ON r.server_id = c.server_id AND r.is_default
 WHERE c.server_id = '55555555-0000-0000-0000-000000000005' AND c.type = 0
ON CONFLICT DO NOTHING;
SELECT is(public.get_default_channel('55555555-0000-0000-0000-000000000005'), NULL::uuid,
          'get_default_channel is NULL when @everyone can view no text channel');

UPDATE public.channel_permission_overrides o
   SET allow_permissions = 2, deny_permissions = 0
  FROM public.server_roles r
 WHERE o.channel_id = 'f1040000-0000-0000-0000-0000000000a1'
   AND o.role_id = r.id AND r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
UPDATE public.server_roles SET permissions = permissions & ~2::bigint
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
SELECT is(public.get_default_channel('55555555-0000-0000-0000-000000000005'),
          'f1040000-0000-0000-0000-0000000000a1'::uuid,
          'an @everyone allow opens a channel the role''s permissions do not');
UPDATE public.channel_permission_overrides o
   SET allow_permissions = 0, deny_permissions = 2
  FROM public.server_roles r
 WHERE o.channel_id = 'f1040000-0000-0000-0000-0000000000a1'
   AND o.role_id = r.id AND r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

SELECT lives_ok($$INSERT INTO public.user_servers (user_id, server_id, status)
                  VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted')$$,
                'a join with no viewable channel succeeds');
SELECT is(pg_temp.sys('33333333-0000-0000-0000-000000000003', 'member_join'), 1,
          'and posts nothing');
SELECT lives_ok($$DELETE FROM public.user_servers
                   WHERE user_id = '33333333-0000-0000-0000-000000000003'
                     AND server_id = '55555555-0000-0000-0000-000000000005'$$,
                'a leave with no viewable channel succeeds');
SELECT is(pg_temp.sys('33333333-0000-0000-0000-000000000003', 'member_leave'), 0,
          'and posts nothing');

SELECT * FROM finish();
ROLLBACK;
