-- Role mentions after 20261003400001_enforce_mention_permissions.sql.
--
-- Fixture server_1: alice owns it, bob is a plain member. MENTION_EVERYONE is bit 20 (1048576);
-- the default @everyone role lacks it.
--   staff   not mentionable, held by alice
--   crew    mentionable, held by alice
--   herald  grants MENTION_EVERYONE, given to bob midway
--   #news   denies herald MENTION_EVERYONE
-- mentionbot has no bot_server_permissions row until the last section.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(13);

INSERT INTO public.server_roles (id, server_id, name, position, permissions, mentionable) VALUES
  ('f4310000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'staff', 3, 0, false),
  ('f4310000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'crew', 2, 0, true),
  ('f4310000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'herald', 1, 1048576, true);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f4310000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('11111111-0000-0000-0000-000000000001', 'f4310000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f4320000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'news', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
VALUES ('f4320000-0000-0000-0000-000000000001', 'role', 'f4310000-0000-0000-0000-000000000003', NULL, 0, 1048576);

INSERT INTO public.bots (id, username, display_name, owner_id)
VALUES ('f4330000-0000-0000-0000-000000000001', 'mentionbot', 'Mention Bot',
        '11111111-0000-0000-0000-000000000001');

SELECT set_config('tests.everyone_role',
                  (SELECT id::text FROM public.server_roles
                    WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), true);

CREATE FUNCTION pg_temp.post(p_id uuid, p_channel uuid, p_user uuid, p_bot uuid, p_role text)
RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.messages (id, channel_id, user_id, bot_id, content)
  VALUES (p_id, p_channel, p_user, p_bot,
          jsonb_build_array(jsonb_build_object('type', 'role_mention', 'roleId', p_role),
                            jsonb_build_object('type', 'text', 'text', ' ping')));
$fn$;

CREATE FUNCTION pg_temp.notified(p_user uuid, p_message uuid) RETURNS boolean LANGUAGE sql AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.notifications
                  WHERE user_id = p_user AND type = 'mention' AND data->>'message_id' = p_message::text);
$fn$;

-- Plain member ------------------------------------------------------------------------
SELECT pg_temp.post('f4340000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
                    '22222222-0000-0000-0000-000000000002', NULL, current_setting('tests.everyone_role'));
SELECT ok(NOT pg_temp.notified('11111111-0000-0000-0000-000000000001', 'f4340000-0000-0000-0000-000000000001'),
          'a member without MENTION_EVERYONE pings no one with @everyone');
SELECT ok(EXISTS (SELECT 1 FROM public.messages WHERE id = 'f4340000-0000-0000-0000-000000000001'),
          'the message is still posted');

SELECT pg_temp.post('f4340000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006',
                    '22222222-0000-0000-0000-000000000002', NULL, 'f4310000-0000-0000-0000-000000000001');
SELECT ok(NOT pg_temp.notified('11111111-0000-0000-0000-000000000001', 'f4340000-0000-0000-0000-000000000002'),
          'a member without MENTION_EVERYONE cannot ping a role that is not mentionable');

SELECT pg_temp.post('f4340000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006',
                    '22222222-0000-0000-0000-000000000002', NULL, 'f4310000-0000-0000-0000-000000000002');
SELECT ok(pg_temp.notified('11111111-0000-0000-0000-000000000001', 'f4340000-0000-0000-0000-000000000003'),
          'any member pings a mentionable role');

-- Owner -------------------------------------------------------------------------------
SELECT pg_temp.post('f4340000-0000-0000-0000-000000000004', '66666666-0000-0000-0000-000000000006',
                    '11111111-0000-0000-0000-000000000001', NULL, current_setting('tests.everyone_role'));
SELECT results_eq(
    $q$SELECT data->>'is_everyone' FROM public.notifications
        WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'mention'
          AND data->>'message_id' = 'f4340000-0000-0000-0000-000000000004'$q$,
    $q$VALUES ('true'::text)$q$,
    'the owner pings @everyone');

-- Member holding MENTION_EVERYONE through a role ----------------------------------------
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', 'f4310000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005');

SELECT pg_temp.post('f4340000-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006',
                    '22222222-0000-0000-0000-000000000002', NULL, current_setting('tests.everyone_role'));
SELECT ok(pg_temp.notified('11111111-0000-0000-0000-000000000001', 'f4340000-0000-0000-0000-000000000005'),
          'a role granting MENTION_EVERYONE lets a member ping @everyone');
SELECT ok(NOT pg_temp.notified('22222222-0000-0000-0000-000000000002', 'f4340000-0000-0000-0000-000000000005'),
          'the sender is not notified of their own @everyone');

SELECT pg_temp.post('f4340000-0000-0000-0000-000000000006', '66666666-0000-0000-0000-000000000006',
                    '22222222-0000-0000-0000-000000000002', NULL, 'f4310000-0000-0000-0000-000000000001');
SELECT ok(pg_temp.notified('11111111-0000-0000-0000-000000000001', 'f4340000-0000-0000-0000-000000000006'),
          'MENTION_EVERYONE also pings a role that is not mentionable');

SELECT pg_temp.post('f4340000-0000-0000-0000-000000000007', 'f4320000-0000-0000-0000-000000000001',
                    '22222222-0000-0000-0000-000000000002', NULL, current_setting('tests.everyone_role'));
SELECT ok(NOT pg_temp.notified('11111111-0000-0000-0000-000000000001', 'f4340000-0000-0000-0000-000000000007'),
          'a channel override denying MENTION_EVERYONE silences @everyone in that channel');

-- Bot -----------------------------------------------------------------------------------
SELECT pg_temp.post('f4340000-0000-0000-0000-000000000008', '66666666-0000-0000-0000-000000000006',
                    NULL, 'f4330000-0000-0000-0000-000000000001', current_setting('tests.everyone_role'));
SELECT ok(NOT pg_temp.notified('22222222-0000-0000-0000-000000000002', 'f4340000-0000-0000-0000-000000000008'),
          'a bot without mention_everyone pings no one with @everyone');

INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, mention_everyone)
VALUES ('f4330000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005',
        '11111111-0000-0000-0000-000000000001', true);
SELECT pg_temp.post('f4340000-0000-0000-0000-000000000009', '66666666-0000-0000-0000-000000000006',
                    NULL, 'f4330000-0000-0000-0000-000000000001', current_setting('tests.everyone_role'));
SELECT ok(pg_temp.notified('22222222-0000-0000-0000-000000000002', 'f4340000-0000-0000-0000-000000000009')
          AND pg_temp.notified('11111111-0000-0000-0000-000000000001', 'f4340000-0000-0000-0000-000000000009'),
          'a bot granted mention_everyone pings @everyone');

UPDATE public.bot_server_permissions SET is_active = false
 WHERE bot_id = 'f4330000-0000-0000-0000-000000000001';
SELECT pg_temp.post('f4340000-0000-0000-0000-00000000000a', '66666666-0000-0000-0000-000000000006',
                    NULL, 'f4330000-0000-0000-0000-000000000001', current_setting('tests.everyone_role'));
SELECT ok(NOT pg_temp.notified('22222222-0000-0000-0000-000000000002', 'f4340000-0000-0000-0000-00000000000a'),
          'an inactive bot installation grants nothing');

SELECT ok(NOT has_function_privilege('authenticated', 'public.handle_role_mention_notifications()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.handle_role_mention_notifications()', 'EXECUTE'),
          'clients hold no EXECUTE on the trigger function');

SELECT * FROM finish();
ROLLBACK;
