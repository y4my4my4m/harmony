-- 20261031900001_reserved_usernames.sql: a new local username is none of the reserved names
-- (everyone, here, staff words, the instance's own name) nor a label of the instance's domain
-- before its last. A local row from before the rule keeps its name through other edits. Remote
-- rows are untouched; a NULL is_local is local.
--
-- Role mention parts of channel messages: @everyone (the default role) and @here stay parts only
-- from an author holding MENTION_EVERYONE; otherwise they are text. Fixture server_1: alice owns
-- it, bob is a plain member; its default role is named everyone.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(42);

DELETE FROM public.instance_config WHERE config_key = 'domain';
INSERT INTO public.instance_config (config_key, config_value) VALUES ('domain', '"chat.example.test:8443"');

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('21400000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n214@test.local');

-- Onboarding: the new account inserts its own profile.
SELECT tests.authenticate_as('21400000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
                    VALUES ('21400000-0000-0000-0000-0000000000a1', '21400000-0000-0000-0000-0000000000a1', 'everyone', 'N', true, 'chat.example.test:8443')$q$,
  '23514', 'The username everyone is reserved', 'onboarding refuses everyone');
SELECT throws_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
                    VALUES ('21400000-0000-0000-0000-0000000000a1', '21400000-0000-0000-0000-0000000000a1', 'example', 'N', true, 'chat.example.test:8443')$q$,
  '23514', 'The username example is reserved', 'and a label of the instance domain');
SELECT lives_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
                   VALUES ('21400000-0000-0000-0000-0000000000a1', '21400000-0000-0000-0000-0000000000a1', 'everyone2', 'N', true, 'chat.example.test:8443')$q$,
  'and takes a name that only starts with one');
SELECT tests.clear_authentication();

-- Any writer, local rows.
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('here', true)$q$,
  '23514', NULL, 'here is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('system', true)$q$,
  '23514', NULL, 'system is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('harmony', true)$q$,
  '23514', NULL, 'harmony is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('administrator', true)$q$,
  '23514', NULL, 'administrator is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('moderators', true)$q$,
  '23514', NULL, 'moderators is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('root', true)$q$,
  '23514', NULL, 'root is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('chat', true)$q$,
  '23514', NULL, 'the first domain label is refused');
SELECT lives_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('test', true)$q$,
  'the top-level domain is taken');
SELECT lives_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('admin_bob', true)$q$,
  'a name containing a reserved word is taken');

-- Remote rows.
SELECT lives_ok($q$INSERT INTO public.profiles (username, domain, is_local) VALUES ('everyone', 'remote.test', false)$q$,
  'a remote everyone is taken');
SELECT lives_ok($q$UPDATE public.profiles SET display_name = 'Everyone' WHERE username = 'everyone' AND domain = 'remote.test'$q$,
  'and takes edits');
SELECT throws_ok($q$UPDATE public.profiles SET is_local = true WHERE username = 'everyone' AND domain = 'remote.test'$q$,
  '23514', NULL, 'and is checked if the row turns local');

-- A local row from before the rule.
ALTER TABLE public.profiles DISABLE TRIGGER guard_local_username;
INSERT INTO public.profiles (id, username, display_name, is_local)
VALUES ('21410000-0000-0000-0000-000000000001', 'admin', 'Old admin', true);
ALTER TABLE public.profiles ENABLE TRIGGER guard_local_username;
SELECT lives_ok($q$UPDATE public.profiles SET display_name = 'Older', bio = 'b' WHERE id = '21410000-0000-0000-0000-000000000001'$q$,
  'an older reserved username takes other edits');
SELECT is((SELECT username FROM public.profiles WHERE id = '21410000-0000-0000-0000-000000000001'), 'admin',
  'and keeps its name');
SELECT throws_ok($q$UPDATE public.profiles SET username = 'staff' WHERE id = '21410000-0000-0000-0000-000000000001'$q$,
  '23514', NULL, 'a new reserved username for it is refused');
SELECT lives_ok($q$UPDATE public.profiles SET username = 'old_admin' WHERE id = '21410000-0000-0000-0000-000000000001'$q$,
  'one that is not reserved is taken');

-- Domain without a dot: the whole host is reserved.
UPDATE public.instance_config SET config_value = '"localhost"' WHERE config_key = 'domain';
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('localhost', true)$q$,
  '23514', NULL, 'a single-label domain is reserved');
UPDATE public.instance_config SET config_value = '"chat.example.test:8443"' WHERE config_key = 'domain';

-- is_local NULL reads as local.
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('21400000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n214b@test.local');
SELECT tests.authenticate_as('21400000-0000-0000-0000-0000000000b1');
SELECT throws_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
                    VALUES ('21400000-0000-0000-0000-0000000000b1', '21400000-0000-0000-0000-0000000000b1', 'Admin', 'N', NULL, 'chat.example.test:8443')$q$,
  '23514', NULL, 'onboarding with is_local null refuses a mixed-case name');
SELECT throws_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
                    VALUES ('21400000-0000-0000-0000-0000000000b1', '21400000-0000-0000-0000-0000000000b1', 'staff', 'N', NULL, 'chat.example.test:8443')$q$,
  '23514', 'The username staff is reserved', 'and a reserved name');
SELECT lives_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
                   VALUES ('21400000-0000-0000-0000-0000000000b1', '21400000-0000-0000-0000-0000000000b1', 'n214_null', 'N', NULL, 'chat.example.test:8443')$q$,
  'and takes any other name');
SELECT tests.clear_authentication();
SELECT is((SELECT is_local FROM public.profiles WHERE id = '21400000-0000-0000-0000-0000000000b1'), true,
  'a client insert is local');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('mods', NULL)$q$,
  '23514', NULL, 'any writer: a reserved name with is_local null is refused');

-- Role mention parts ------------------------------------------------------------------------------
SELECT set_config('tests.everyone',
                  (SELECT id::text FROM public.server_roles
                    WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), true);
INSERT INTO public.server_roles (id, server_id, name, position, permissions, mentionable) VALUES
  ('21430000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'quiet', 2, 0, false),
  ('21430000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'herald', 1, 1048576, true);
INSERT INTO public.bots (id, username, display_name, owner_id) VALUES
  ('21440000-0000-0000-0000-000000000001', 'n214bot', 'N214 Bot', '11111111-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.everyone() RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('type', 'role_mention', 'roleId', current_setting('tests.everyone'),
                            'roleName', 'everyone', 'roleColor', NULL);
$fn$;
CREATE FUNCTION pg_temp.here() RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT '{"type":"role_mention","roleId":"here","roleName":"here","roleColor":null}'::jsonb;
$fn$;
CREATE FUNCTION pg_temp.t(p_text text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('type', 'text', 'text', p_text);
$fn$;
CREATE FUNCTION pg_temp.content(p_id uuid) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT content FROM public.messages WHERE id = p_id;
$fn$;

-- bob holds no MENTION_EVERYONE.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('21450000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
        jsonb_build_array(pg_temp.t('hi '), pg_temp.everyone(), pg_temp.t(' and '), pg_temp.here()));
INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('21450000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
        jsonb_build_array(
          '{"type":"role_mention","roleId":"21430000-0000-0000-0000-000000000001","roleName":"quiet","roleColor":null}'::jsonb,
          '{"type":"role_mention","roleId":"21439999-0000-0000-0000-000000000009","roleName":"@everyone","roleColor":null}'::jsonb,
          '{"type":"role_mention","roleId":"HERE"}'::jsonb));
SELECT tests.clear_authentication();
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000001'),
          jsonb_build_array(pg_temp.t('hi '), pg_temp.t('@everyone'), pg_temp.t(' and '), pg_temp.t('@here')),
          'a member without MENTION_EVERYONE writes @role:<default> and @role:here as text');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.notifications
                       WHERE type = 'mention' AND data->>'message_id' = '21450000-0000-0000-0000-000000000001')
          AND COALESCE((SELECT unread_mentions FROM public.unread_counts
                         WHERE user_id = '11111111-0000-0000-0000-000000000001'
                           AND channel_id = '66666666-0000-0000-0000-000000000006'), 0) = 0,
          'and notifies no one, nor counts as an unread mention');
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000002'),
          jsonb_build_array(
            '{"type":"role_mention","roleId":"21430000-0000-0000-0000-000000000001","roleName":"quiet","roleColor":null}'::jsonb,
            pg_temp.t('@everyone'), pg_temp.t('@role')),
          'a role of the server stays; a roleId naming none becomes its name as text');

-- Typed @everyone arrives as text and stays text.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('21450000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
        jsonb_build_array(pg_temp.t('@everyone hi')));
SELECT tests.clear_authentication();
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000003'), jsonb_build_array(pg_temp.t('@everyone hi')),
          'typed @everyone text is left alone');

-- alice owns the server.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('21450000-0000-0000-0000-000000000004', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
        jsonb_build_array(pg_temp.everyone(), pg_temp.t(' '), pg_temp.here()));
SELECT tests.clear_authentication();
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000004'),
          jsonb_build_array(pg_temp.everyone(), pg_temp.t(' '), pg_temp.here()),
          'an author holding MENTION_EVERYONE keeps @everyone and @here');
SELECT ok(EXISTS (SELECT 1 FROM public.notifications
                   WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'mention'
                     AND data->>'message_id' = '21450000-0000-0000-0000-000000000004'),
          'and pings');

-- Edits.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.messages SET content = jsonb_build_array(pg_temp.t('edited '), pg_temp.everyone(), pg_temp.here())
 WHERE id = '21450000-0000-0000-0000-000000000003';
SELECT tests.clear_authentication();
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000003'),
          jsonb_build_array(pg_temp.t('edited '), pg_temp.t('@everyone'), pg_temp.t('@here')),
          'an edit adding @everyone and @here without MENTION_EVERYONE writes text');

INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '21430000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.messages SET content = jsonb_build_array(pg_temp.t('again '), pg_temp.everyone())
 WHERE id = '21450000-0000-0000-0000-000000000003';
SELECT tests.clear_authentication();
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000003'),
          jsonb_build_array(pg_temp.t('again '), pg_temp.everyone()),
          'an edit by a member granted MENTION_EVERYONE keeps @everyone');
DELETE FROM public.user_roles
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = '21430000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.messages SET content = jsonb_build_array(pg_temp.t('again, '), pg_temp.everyone(), pg_temp.here())
 WHERE id = '21450000-0000-0000-0000-000000000003';
SELECT tests.clear_authentication();
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000003'),
          jsonb_build_array(pg_temp.t('again, '), pg_temp.everyone(), pg_temp.t('@here')),
          'after the right is gone, an edit keeps the stored @everyone and writes a new @here as text');

-- Bots and federation: servers of this instance.
INSERT INTO public.messages (id, channel_id, bot_id, content)
VALUES ('21450000-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006', '21440000-0000-0000-0000-000000000001',
        jsonb_build_array(pg_temp.here()));
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000005'), jsonb_build_array(pg_temp.t('@here')),
          'a bot without mention_everyone writes @here as text');
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, mention_everyone)
VALUES ('21440000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005',
        '11111111-0000-0000-0000-000000000001', true);
INSERT INTO public.messages (id, channel_id, bot_id, content)
VALUES ('21450000-0000-0000-0000-000000000006', '66666666-0000-0000-0000-000000000006', '21440000-0000-0000-0000-000000000001',
        jsonb_build_array(pg_temp.here(), pg_temp.everyone()));
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000006'), jsonb_build_array(pg_temp.here(), pg_temp.everyone()),
          'a bot holding mention_everyone keeps both');
SET LOCAL ROLE service_role;
INSERT INTO public.messages (id, channel_id, user_id, content, metadata)
VALUES ('21450000-0000-0000-0000-000000000007', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
        jsonb_build_array(pg_temp.everyone()), '{"federated": true}');
RESET ROLE;
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000007'), jsonb_build_array(pg_temp.t('@everyone')),
          'a federated write by a member without MENTION_EVERYONE writes text');

-- Encrypted content drops the part: only mention parts follow the ciphertext.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO public.messages (id, channel_id, user_id, content, encrypted)
VALUES ('21450000-0000-0000-0000-000000000008', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
        jsonb_build_array(pg_temp.t(repeat('QUJD', 12)),
                          jsonb_build_object('type', 'role_mention', 'roleId', current_setting('tests.everyone')),
                          '{"type":"role_mention","roleId":"21430000-0000-0000-0000-000000000001"}'::jsonb),
        true);
SELECT tests.clear_authentication();
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000008'),
          jsonb_build_array(pg_temp.t(repeat('QUJD', 12)),
                            '{"type":"role_mention","roleId":"21430000-0000-0000-0000-000000000001"}'::jsonb),
          'an encrypted message drops @everyone without MENTION_EVERYONE');

-- A copy of a remote server: its origin decided; a local client is still checked.
INSERT INTO public.servers (id, name, owner, is_local_server)
VALUES ('21460000-0000-0000-0000-000000000001', 'Copy', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('21460000-0000-0000-0000-000000000002', '21460000-0000-0000-0000-000000000001', 'copied', 0);
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '21460000-0000-0000-0000-000000000001', 'accepted');
SET LOCAL ROLE service_role;
INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('21450000-0000-0000-0000-000000000009', '21460000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002',
        jsonb_build_array(pg_temp.here()));
RESET ROLE;
SELECT is(pg_temp.content('21450000-0000-0000-0000-000000000009'), jsonb_build_array(pg_temp.here()),
          'a federated write into a copy keeps @here');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('21450000-0000-0000-0000-00000000000a', '21460000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002',
        jsonb_build_array(pg_temp.here()));
SELECT tests.clear_authentication();
SELECT is(pg_temp.content('21450000-0000-0000-0000-00000000000a'), jsonb_build_array(pg_temp.t('@here')),
          'a client write into a copy is checked');

-- Conversations have no roles.
INSERT INTO public.messages (id, conversation_id, user_id, content)
VALUES ('21450000-0000-0000-0000-00000000000b', '77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002',
        jsonb_build_array(pg_temp.here()));
SELECT is(pg_temp.content('21450000-0000-0000-0000-00000000000b'), jsonb_build_array(pg_temp.here()),
          'a conversation message is left alone');

SELECT ok(NOT has_function_privilege('authenticated', 'public.enforce_message_role_mentions()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.enforce_message_role_mentions()', 'EXECUTE'),
          'clients hold no EXECUTE on the trigger function');

SELECT * FROM finish();
ROLLBACK;
