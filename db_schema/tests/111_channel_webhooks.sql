-- Channel webhooks after 20261010800001_channel_webhooks.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Added:
--   bob     holds role hooks (MANAGE_WEBHOOKS)
--   carol   member without permissions
--   frank   instance admin, no membership
--   @everyone: VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS, ATTACH_FILES, ADD_REACTIONS
--   channels ops (text), secret (text, encrypted later), voice, cap1..cap5 (text)
--   server remote (is_local_server false) with channel far; server doomed with channel gone

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(74);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1110000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol111@test.local'),
  ('f1110000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank111@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('f1110000-0000-0000-0000-0000000000c1', 'f1110000-0000-0000-0000-0000000000a1', 'carol111', 'Carol', true, false),
  ('f1110000-0000-0000-0000-0000000000c2', 'f1110000-0000-0000-0000-0000000000a2', 'frank111', 'Frank', true, true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1110000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted');

UPDATE public.server_roles SET permissions = 462850
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1111000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'hooks', 3, 64);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1111000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1113000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'ops', 0),
  ('f1113000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'secret', 0),
  ('f1113000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'voice', 1),
  ('f1113000-0000-0000-0000-000000000011', '55555555-0000-0000-0000-000000000005', 'cap1', 0),
  ('f1113000-0000-0000-0000-000000000012', '55555555-0000-0000-0000-000000000005', 'cap2', 0),
  ('f1113000-0000-0000-0000-000000000013', '55555555-0000-0000-0000-000000000005', 'cap3', 0),
  ('f1113000-0000-0000-0000-000000000014', '55555555-0000-0000-0000-000000000005', 'cap4', 0),
  ('f1113000-0000-0000-0000-000000000015', '55555555-0000-0000-0000-000000000005', 'cap5', 0);

INSERT INTO public.servers (id, name, owner, is_local_server, host_domain) VALUES
  ('f1112000-0000-0000-0000-000000000002', 'Remote', '11111111-0000-0000-0000-000000000001', false, 'remote.example');
INSERT INTO public.servers (id, name, owner) VALUES
  ('f1112000-0000-0000-0000-000000000003', 'Doomed', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1113000-0000-0000-0000-000000000020', 'f1112000-0000-0000-0000-000000000002', 'far', 0),
  ('f1113000-0000-0000-0000-000000000030', 'f1112000-0000-0000-0000-000000000003', 'gone', 0),
  ('f1113000-0000-0000-0000-000000000031', 'f1112000-0000-0000-0000-000000000003', 'also-gone', 0);

CREATE TEMP TABLE hook (label text PRIMARY KEY, body jsonb);
GRANT ALL ON hook TO authenticated, service_role;

-- sha256 hex of a token, as the federation backend sends it. execute_channel_webhook runs as
-- postgres below: service_role lacks USAGE on the tests schema, and the definer ignores its caller.
CREATE FUNCTION pg_temp.h(p_token text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
$fn$;
CREATE FUNCTION pg_temp.tok(p_label text) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT body ->> 'token' FROM hook WHERE label = p_label
$fn$;
CREATE FUNCTION pg_temp.hid(p_label text) RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT (body ->> 'id')::uuid FROM hook WHERE label = p_label
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.h(text), pg_temp.tok(text), pg_temp.hid(text) TO authenticated, service_role;

-- Privileges --------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.create_channel_webhook(uuid, text, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.list_channel_webhooks(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.delete_channel_webhook(uuid)', 'EXECUTE'),
          'anon cannot call the management RPCs');
SELECT ok(NOT has_function_privilege('authenticated', 'public.execute_channel_webhook(uuid, text, text, text, text, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.execute_channel_webhook(uuid, text, text, text, text, boolean)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.execute_channel_webhook(uuid, text, text, text, text, boolean)', 'EXECUTE'),
          'execute_channel_webhook is service_role only');
SELECT ok(NOT has_table_privilege('authenticated', 'public.channel_webhooks', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.channel_webhooks', 'INSERT')
          AND NOT has_table_privilege('anon', 'public.channel_webhooks', 'SELECT')
          AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.channel_webhooks'::regclass),
          'clients hold no privilege on channel_webhooks, which is under RLS');

-- Who manages -------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1110000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000001', 'CI')$q$,
                 '42501', NULL, 'a member without MANAGE_WEBHOOKS cannot create a webhook');
SELECT throws_ok($q$SELECT public.list_channel_webhooks('f1113000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'nor list them');
SELECT is(public.list_server_webhooks('55555555-0000-0000-0000-000000000005'), '[]'::jsonb,
          'the server listing is empty for them');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000001', 'CI')$q$,
                 '42501', NULL, 'a non-member cannot create a webhook');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000001', 'CI')$q$,
                 '42501', NULL, 'anon cannot create a webhook');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO hook SELECT 'ci', public.create_channel_webhook('f1113000-0000-0000-0000-000000000001', '  CI   bot ', 'https://cdn.test/ci.png')$q$,
                'a MANAGE_WEBHOOKS holder creates a webhook');
SELECT ok(pg_temp.tok('ci') ~ '^[0-9a-f]{64}$', 'the token is 64 hex characters');
SELECT is((SELECT body ->> 'name' FROM hook WHERE label = 'ci'), 'CI bot', 'the name is trimmed and its spaces collapsed');
SELECT is((SELECT body ->> 'token_hint' FROM hook WHERE label = 'ci'), right(pg_temp.tok('ci'), 4),
          'the hint is the token''s last 4 characters');
SELECT is((SELECT jsonb_array_length(public.list_channel_webhooks('f1113000-0000-0000-0000-000000000001'))), 1,
          'the holder lists the channel''s webhook');
SELECT ok(NOT (public.list_channel_webhooks('f1113000-0000-0000-0000-000000000001') -> 0 ?| ARRAY['token', 'token_hash', 'bot_id']),
          'the listing carries neither the token nor its hash nor the bot');
SELECT throws_ok($q$SELECT * FROM public.channel_webhooks$q$, '42501', NULL, 'the table is closed to clients');
SELECT throws_ok($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000001', 'System')$q$,
                 '22023', NULL, 'a reserved name is refused');
SELECT throws_ok($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000001', 'x', 'http://cdn.test/a.png')$q$,
                 '22023', NULL, 'an avatar that is not https is refused');
SELECT throws_ok($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000003', 'x')$q$,
                 '22023', NULL, 'a voice channel takes no webhook');
SELECT tests.clear_authentication();

SELECT is((SELECT token_hash FROM public.channel_webhooks WHERE id = pg_temp.hid('ci')), pg_temp.h(pg_temp.tok('ci')),
          'the row stores the token''s SHA-256 hex digest');

-- The backing bot ----------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT b.bot_type, b.is_public, b.owner_id, b.display_name
         FROM public.bots b JOIN public.channel_webhooks w ON w.bot_id = b.id WHERE w.id = pg_temp.hid('ci')$q$,
    $q$VALUES ('integration'::text, false, '22222222-0000-0000-0000-000000000002'::uuid, 'CI bot'::text)$q$,
    'the webhook posts as a private integration bot its creator owns');
SELECT results_eq(
    $q$SELECT i.is_active, i.read_messages, i.send_messages, i.mention_everyone, i.manage_messages, i.allowed_channel_ids
         FROM public.bot_server_permissions i JOIN public.channel_webhooks w ON w.bot_id = i.bot_id
        WHERE w.id = pg_temp.hid('ci')$q$,
    $q$VALUES (true, false, true, false, false, ARRAY['f1113000-0000-0000-0000-000000000001'::uuid])$q$,
    'the bot is installed with send_messages alone, in the webhook''s channel');
CREATE TEMP TABLE ci_bot AS SELECT bot_id FROM public.channel_webhooks WHERE id = pg_temp.hid('ci');
GRANT SELECT ON ci_bot TO authenticated, service_role;

SELECT tests.authenticate_as('f1110000-0000-0000-0000-0000000000a1');
SELECT is((SELECT count(*)::integer FROM public.bot_server_permissions WHERE bot_id = (SELECT bot_id FROM ci_bot)), 0,
          'members do not read the webhook bot''s install');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.get_server_bots('55555555-0000-0000-0000-000000000005') g
                       WHERE g.id = (SELECT bot_id FROM ci_bot)),
          'the webhook bot is absent from the member list');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$UPDATE public.bots SET display_name = 'Mine' WHERE id = (SELECT bot_id FROM ci_bot)$q$,
                 '42501', NULL, 'the creator cannot edit the backing bot');
SELECT throws_ok($q$DELETE FROM public.bots WHERE id = (SELECT bot_id FROM ci_bot)$q$,
                 '42501', NULL, 'nor delete it');
SELECT throws_ok($q$SELECT public.rotate_bot_token((SELECT bot_id FROM ci_bot))$q$,
                 '42501', 'webhook bots hold no API token', 'nor issue it an API token');
SELECT throws_ok($q$INSERT INTO public.bots (username, bot_type, owner_id, is_public)
                    VALUES ('sneaky111', 'integration', '22222222-0000-0000-0000-000000000002', false)$q$,
                 '42501', NULL, 'a client cannot create an integration bot');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by)
                    VALUES ((SELECT bot_id FROM ci_bot), 'f1112000-0000-0000-0000-000000000003',
                            '11111111-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'a server owner cannot install the webhook bot elsewhere');
SELECT tests.clear_authentication();

-- Execution ----------------------------------------------------------------------------------
SELECT lives_ok($q$INSERT INTO hook SELECT 'm1', public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci')),
                     '@everyone build passed https://ci.test/run/1 and <https://ci.test/log>')$q$,
                'a webhook with its token posts');
SELECT throws_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h('0000'), 'hi')$q$,
                 '28000', NULL, 'a wrong token is refused');
SELECT throws_ok($q$SELECT public.execute_channel_webhook('f1119999-0000-0000-0000-000000000000', pg_temp.h(pg_temp.tok('ci')), 'hi')$q$,
                 '28000', NULL, 'an unknown webhook is refused alike');
UPDATE public.profiles SET is_suspended = true
 WHERE id = (SELECT created_by FROM public.channel_webhooks WHERE id = pg_temp.hid('ci'));
SELECT throws_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci')), 'hi')$q$,
                 '28000', NULL, 'a suspended creator''s webhook is refused');
UPDATE public.profiles SET is_suspended = false
 WHERE id = (SELECT created_by FROM public.channel_webhooks WHERE id = pg_temp.hid('ci'));
UPDATE public.bots SET is_active = false
 WHERE id = (SELECT bot_id FROM public.channel_webhooks WHERE id = pg_temp.hid('ci'));
SELECT throws_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci')), 'hi')$q$,
                 '28000', NULL, 'a webhook whose bot is deactivated is refused');
UPDATE public.bots SET is_active = true
 WHERE id = (SELECT bot_id FROM public.channel_webhooks WHERE id = pg_temp.hid('ci'));
SELECT throws_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci')), E'  \n ')$q$,
                 '22023', NULL, 'blank text is refused');
SELECT throws_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci')), 'hi', 'Sys tem')$q$,
                 '22023', NULL, 'a username impersonating the system is refused');
SELECT throws_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci')), 'hi', 'Ops', 'javascript:alert(1)')$q$,
                 '22023', NULL, 'an avatar that is not https is refused');
SELECT lives_ok($q$INSERT INTO hook SELECT 'm2', public.execute_channel_webhook(pg_temp.hid('ci'), upper(pg_temp.h(pg_temp.tok('ci'))),
                     'deploy https://ci.test/d', 'Deployer', 'https://cdn.test/d.png', true)$q$,
                'a message overrides the name and avatar and suppresses embeds');

SELECT results_eq(
    $q$SELECT m.bot_id, m.user_id, m.metadata -> 'webhook', m.metadata ->> 'created_via', (m.metadata ->> 'bot')::boolean
         FROM public.messages m WHERE m.id = (SELECT (body ->> 'id')::uuid FROM hook WHERE label = 'm1')$q$,
    $q$SELECT (SELECT bot_id FROM ci_bot), NULL::uuid,
              jsonb_build_object('id', pg_temp.hid('ci'), 'name', 'CI bot', 'avatar_url', 'https://cdn.test/ci.png'),
              'webhook'::text, true$q$,
    'the message is the backing bot''s, with webhook metadata');
SELECT is((SELECT content FROM public.messages WHERE id = (SELECT (body ->> 'id')::uuid FROM hook WHERE label = 'm1')),
          '[{"type": "text", "text": "@everyone build passed "},
            {"type": "url", "url": "https://ci.test/run/1", "preview": true},
            {"type": "text", "text": " and "},
            {"type": "url", "url": "https://ci.test/log", "preview": false}]'::jsonb,
          'the content is text and url parts; @everyone stays text');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.messages m, jsonb_array_elements(m.content) p
                       WHERE m.bot_id = (SELECT bot_id FROM ci_bot)
                         AND p ->> 'type' NOT IN ('text', 'url')),
          'no webhook message holds a mention, role, system or embed part');
SELECT results_eq(
    $q$SELECT m.metadata -> 'webhook' ->> 'name', m.metadata -> 'webhook' ->> 'avatar_url', (m.metadata ->> 'suppress_embeds')::boolean
         FROM public.messages m WHERE m.id = (SELECT (body ->> 'id')::uuid FROM hook WHERE label = 'm2')$q$,
    $q$VALUES ('Deployer'::text, 'https://cdn.test/d.png'::text, true)$q$,
    'the overrides are recorded on the message');
SELECT is((SELECT body ->> 'name' FROM hook WHERE label = 'm2'), 'Deployer', 'the result names the shown author');
SELECT results_eq(
    $q$SELECT use_count, last_used_at IS NOT NULL FROM public.channel_webhooks WHERE id = pg_temp.hid('ci')$q$,
    $q$VALUES (2::bigint, true)$q$,
    'each post counts and stamps last use');

INSERT INTO public.instance_config (config_key, config_value) VALUES ('max_message_length', '10')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
SELECT throws_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci')), 'more than ten characters')$q$,
                 '22001', NULL, 'text past max_message_length is refused');
UPDATE public.instance_config SET config_value = '2000' WHERE config_key = 'max_message_length';

-- Reserved metadata --------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                    VALUES ('f1113000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
                            '[{"type":"text","text":"hi"}]', '{"webhook": {"name": "CI bot"}}')$q$,
                 '42501', NULL, 'a client cannot write webhook metadata');
SELECT throws_ok($q$UPDATE public.messages SET metadata = metadata || '{"webhook": {"name": "x"}}'
                    WHERE id = '88888888-0000-0000-0000-000000000008'$q$,
                 '42501', NULL, 'nor add it to their message');

-- Management by others -----------------------------------------------------------------------
SELECT tests.authenticate_as('f1110000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$SELECT public.regenerate_channel_webhook_token(pg_temp.hid('ci'))$q$,
                 '42501', NULL, 'a member without MANAGE_WEBHOOKS cannot regenerate a token');
SELECT throws_ok($q$SELECT public.update_channel_webhook(pg_temp.hid('ci'), 'Mine')$q$,
                 '42501', NULL, 'nor rename a webhook');
SELECT throws_ok($q$SELECT public.delete_channel_webhook(pg_temp.hid('ci'))$q$,
                 '42501', NULL, 'nor delete one');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO hook SELECT 'ci2', public.regenerate_channel_webhook_token(pg_temp.hid('ci'))$q$,
                'the holder regenerates the token');
SELECT isnt(pg_temp.tok('ci2'), pg_temp.tok('ci'), 'the token changes');
SELECT is(public.update_channel_webhook(pg_temp.hid('ci'), 'Builds', '') ->> 'name', 'Builds', 'the holder renames it');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT w.avatar_url, b.display_name, b.avatar_url
         FROM public.channel_webhooks w JOIN public.bots b ON b.id = w.bot_id WHERE w.id = pg_temp.hid('ci')$q$,
    $q$VALUES (NULL::text, 'Builds'::text, '/default_avatar.webp'::text)$q$,
    'a blank avatar clears it, and the bot follows');

SELECT throws_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci')), 'old')$q$,
                 '28000', NULL, 'the previous token stops working');
SELECT lives_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci2')), 'new')$q$,
                'the new token posts');

-- Instance admins ----------------------------------------------------------------------------
SELECT tests.authenticate_as('f1110000-0000-0000-0000-0000000000a2');
SELECT is(jsonb_array_length(public.list_server_webhooks('55555555-0000-0000-0000-000000000005')), 1,
          'an instance admin lists the server''s webhooks without membership');
SELECT tests.clear_authentication();

-- MANAGE_WEBHOOKS for @everyone does not reach non-members ------------------------------------
UPDATE public.server_roles SET permissions = permissions | 64
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.list_channel_webhooks('f1113000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'a non-member is refused even when @everyone holds MANAGE_WEBHOOKS');
SELECT tests.authenticate_as('f1110000-0000-0000-0000-0000000000a1');
SELECT is(jsonb_array_length(public.list_channel_webhooks('f1113000-0000-0000-0000-000000000001')), 1,
          'a member holding it through @everyone lists them');
SELECT tests.clear_authentication();
UPDATE public.server_roles SET permissions = 462850
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;

-- Encrypted and remote channels --------------------------------------------------------------
INSERT INTO public.server_encryption_settings (server_id, encryption_mode)
VALUES ('55555555-0000-0000-0000-000000000005', 'optional')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional';
INSERT INTO public.channel_encryption_settings (channel_id, messages_encrypted)
VALUES ('f1113000-0000-0000-0000-000000000002', true)
ON CONFLICT (channel_id) DO UPDATE SET messages_encrypted = true;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000002', 'Leaky')$q$,
                 '42501', NULL, 'an encrypted channel takes no webhook');
SELECT throws_ok($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000020', 'Far')$q$,
                 '22023', NULL, 'a remote server''s channel takes no webhook');
SELECT tests.clear_authentication();

-- A channel encrypted after the webhook was created.
INSERT INTO public.channel_encryption_settings (channel_id, messages_encrypted)
VALUES ('f1113000-0000-0000-0000-000000000001', true)
ON CONFLICT (channel_id) DO UPDATE SET messages_encrypted = true;
SELECT throws_like($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci2')), 'plain')$q$,
                   'WEBHOOK_CHANNEL_ENCRYPTED%', 'a webhook cannot post once its channel is encrypted');
UPDATE public.channel_encryption_settings SET messages_encrypted = false
 WHERE channel_id = 'f1113000-0000-0000-0000-000000000001';

-- Caps ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$DO $d$ BEGIN
                     FOR i IN 1..10 LOOP
                       PERFORM public.create_channel_webhook('f1113000-0000-0000-0000-000000000011', 'cap ' || i);
                     END LOOP;
                   END $d$$q$,
                'a channel takes 10 webhooks');
SELECT throws_like($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000011', 'eleventh')$q$,
                   'WEBHOOK_LIMIT_CHANNEL%', 'and refuses an eleventh');
SELECT lives_ok($q$DO $d$ BEGIN
                     FOR c IN 2..4 LOOP
                       FOR i IN 1..10 LOOP
                         PERFORM public.create_channel_webhook(('f1113000-0000-0000-0000-00000000001' || c)::uuid, 'cap ' || i);
                       END LOOP;
                     END LOOP;
                     FOR i IN 1..9 LOOP
                       PERFORM public.create_channel_webhook('f1113000-0000-0000-0000-000000000015', 'cap ' || i);
                     END LOOP;
                   END $d$$q$,
                'the server reaches 50 webhooks');
SELECT throws_like($q$SELECT public.create_channel_webhook('f1113000-0000-0000-0000-000000000015', 'fifty-first')$q$,
                   'WEBHOOK_LIMIT_SERVER%', 'and refuses a fifty-first');
SELECT tests.clear_authentication();

-- Deactivation and deletion ------------------------------------------------------------------
UPDATE public.channel_webhooks SET is_active = false
 WHERE channel_id = 'f1113000-0000-0000-0000-000000000011' AND name = 'cap 1';
SELECT ok(NOT (SELECT b.is_active FROM public.bots b JOIN public.channel_webhooks w ON w.bot_id = b.id
                WHERE w.channel_id = 'f1113000-0000-0000-0000-000000000011' AND w.name = 'cap 1'),
          'deactivating a webhook deactivates its bot');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT ok(public.delete_channel_webhook(pg_temp.hid('ci')), 'the holder deletes the webhook');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT (SELECT count(*)::integer FROM public.channel_webhooks WHERE id = pg_temp.hid('ci')),
              (SELECT is_active FROM public.bots WHERE id = (SELECT bot_id FROM ci_bot)),
              (SELECT bool_or(is_active) FROM public.bot_server_permissions WHERE bot_id = (SELECT bot_id FROM ci_bot)),
              (SELECT count(*)::integer FROM public.messages WHERE bot_id = (SELECT bot_id FROM ci_bot))$q$,
    $q$VALUES (0, false, false, 3)$q$,
    'the row goes, the bot and its install go inactive, its messages stay');
SELECT throws_ok($q$SELECT public.execute_channel_webhook(pg_temp.hid('ci'), pg_temp.h(pg_temp.tok('ci2')), 'ghost')$q$,
                 '28000', NULL, 'a deleted webhook is refused');
SELECT throws_ok($q$SELECT public.issue_bot_token((SELECT bot_id FROM ci_bot), 'x')$q$,
                 '42501', 'webhook bots hold no API token', 'a definer issues a webhook bot no token either');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO hook SELECT 'gone', public.create_channel_webhook('f1113000-0000-0000-0000-000000000030', 'Gone');
                   INSERT INTO hook SELECT 'gone2', public.create_channel_webhook('f1113000-0000-0000-0000-000000000031', 'Gone too')$q$,
                'webhooks in another server');
SELECT tests.clear_authentication();
CREATE TEMP TABLE gone_bot AS SELECT bot_id FROM public.channel_webhooks WHERE id = pg_temp.hid('gone');
SELECT lives_ok($q$DELETE FROM public.channels WHERE id = 'f1113000-0000-0000-0000-000000000030'$q$,
                'its channel is deleted');
SELECT results_eq(
    $q$SELECT (SELECT count(*)::integer FROM public.channel_webhooks WHERE id = pg_temp.hid('gone')),
              (SELECT is_active FROM public.bots WHERE id = (SELECT bot_id FROM gone_bot))$q$,
    $q$VALUES (0, false)$q$,
    'the webhook goes with its channel and its bot goes inactive');
SELECT lives_ok($q$DELETE FROM public.servers WHERE id = 'f1112000-0000-0000-0000-000000000003'$q$,
                'a server with a webhook is deleted');

SELECT * FROM finish();
ROLLBACK;
