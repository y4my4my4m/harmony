-- 20261030700001_channel_names_create_options_instance_branding.sql: the channel naming rule per
-- type and the trigger applying it to every local writer; create_channel's creation options in
-- one transaction; record_instance_branding.
--
-- Fixture server_1: alice owns it, bob is a member without permissions.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(49);

-- Rule. The same cases as src/utils/__tests__/channelName.test.ts. --------------------------
SELECT is(public.channel_name_normalized(v.raw, v.type), v.expected, v.label)
  FROM (VALUES
    ('Release Notes!', 0, 'release-notes', 'text: lowercase, a space becomes ''-'', ASCII punctuation goes'),
    ('  Off Topic!!  Chat', 0, 'off-topic-chat', 'text: runs of ''-'' become one, leading ones go'),
    ('dev_ops--team-', 0, 'dev_ops-team', 'text: ''_'' stays, a trailing ''-'' goes'),
    ('Café Ünïcode', 0, 'café-ünïcode', 'text: letters outside ASCII stay and are lowercased'),
    (U&'日本語\3000チャンネル', 0, '日本語-チャンネル', 'text: an ideographic space becomes ''-'''),
    ('🎮 Game Night', 0, '🎮-game-night', 'text: emoji stay'),
    (U&'a\00A0b', 0, 'a-b', 'text: a no-break space becomes ''-'''),
    ('!!!', 0, '', 'text: a name of punctuation alone is empty'),
    ('  Mike''s  Room 🎮 ', 1, 'Mike''s Room 🎮', 'voice: case, punctuation and emoji stay; spaces collapse and trim'),
    (U&'Late\2003\2003Night', 1, 'Late Night', 'voice: a run of any whitespace becomes one space'),
    ('voice chat', 1, 'voice chat', 'voice: the default voice channel name is unchanged')
  ) v(raw, type, expected, label);

-- Trigger, as a service writer (bots, templates). -------------------------------------------
CREATE TEMP TABLE c201 (k text PRIMARY KEY, id uuid);
GRANT ALL ON c201 TO authenticated;

WITH i AS (
  INSERT INTO public.channels (server_id, name, type) VALUES ('55555555-0000-0000-0000-000000000005', 'Bot Made Channel', 0)
  RETURNING id)
INSERT INTO c201 SELECT 'bot', id FROM i;
WITH i AS (
  INSERT INTO public.channels (server_id, name, type) VALUES ('55555555-0000-0000-0000-000000000005', ' Town   Hall ', 1)
  RETURNING id)
INSERT INTO c201 SELECT 'botvoice', id FROM i;
WITH i AS (
  INSERT INTO public.channels (server_id, name, type, is_remote) VALUES ('55555555-0000-0000-0000-000000000005', 'Mirrored Name', 0, true)
  RETURNING id)
INSERT INTO c201 SELECT 'remote', id FROM i;

SELECT is((SELECT name FROM public.channels WHERE id = (SELECT id FROM c201 WHERE k = 'bot')), 'bot-made-channel',
  'a text channel inserted by a service writer follows the text rule');
SELECT is((SELECT name FROM public.channels WHERE id = (SELECT id FROM c201 WHERE k = 'botvoice')), 'Town Hall',
  'a voice channel inserted by a service writer follows the voice rule');
SELECT is((SELECT name FROM public.channels WHERE id = (SELECT id FROM c201 WHERE k = 'remote')), 'Mirrored Name',
  'a channel from another instance keeps its origin''s name');

-- A stored name the rule would change: the mirrored row made local.
UPDATE public.channels SET is_remote = false WHERE id = (SELECT id FROM c201 WHERE k = 'remote');
UPDATE public.channels SET description = 'kept' WHERE id = (SELECT id FROM c201 WHERE k = 'remote');
UPDATE public.channels SET name = name WHERE id = (SELECT id FROM c201 WHERE k = 'remote');
SELECT is((SELECT name FROM public.channels WHERE id = (SELECT id FROM c201 WHERE k = 'remote')), 'Mirrored Name',
  'an update that leaves the name as it is does not rewrite a stored name');
UPDATE public.channels SET name = 'Mirrored Renamed' WHERE id = (SELECT id FROM c201 WHERE k = 'remote');
SELECT is((SELECT name FROM public.channels WHERE id = (SELECT id FROM c201 WHERE k = 'remote')), 'mirrored-renamed',
  'a rename follows the rule');
SELECT throws_ok(
  $q$INSERT INTO public.channels (server_id, name, type) VALUES ('55555555-0000-0000-0000-000000000005', '?!', 0)$q$,
  '23514', NULL, 'a name the rule empties is refused');

-- A server hosted elsewhere: its channels keep the host's names, is_remote or not.
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local)
VALUES ('f2010000-0000-0000-0000-0000000000e1', 'host201', 'Host 201', 'host201.test',
        'https://host201.test/users/host201', false);
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('f2010000-0000-0000-0000-0000000000a1', 'Copy 201', 'f2010000-0000-0000-0000-0000000000e1', false, true,
        'host201.test', 'https://host201.test/servers/f2010000-0000-0000-0000-0000000000a1');
INSERT INTO public.channels (id, server_id, name, type, is_remote)
VALUES ('f2010000-0000-0000-0000-0000000000c1', 'f2010000-0000-0000-0000-0000000000a1', 'Host Name!', 0, false);
SELECT is((SELECT name FROM public.channels WHERE id = 'f2010000-0000-0000-0000-0000000000c1'), 'Host Name!',
  'a channel of a server hosted elsewhere keeps its name without is_remote');
UPDATE public.channels SET name = '???' WHERE id = 'f2010000-0000-0000-0000-0000000000c1';
SELECT is((SELECT name FROM public.channels WHERE id = 'f2010000-0000-0000-0000-0000000000c1'), '???',
  'and a rename there is the host''s, even one the rule would empty');

-- A template from before the rule: a text channel named by punctuation alone.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok(
  $q$SELECT set_config('t201.tpl_server', public.create_server_from_template('Tpl 201',
       '{"format": "harmony.server-template", "version": 1,
         "channels": [{"ref": "q", "name": "???", "type": 0, "order": 0},
                      {"ref": "n", "name": "Old Style Name", "type": 0, "order": 1},
                      {"ref": "v", "name": "Lounge ?", "type": 1, "order": 2}]}'::jsonb)::text, true)$q$,
  'a template whose channel name the rule empties still creates the server');
SELECT tests.clear_authentication();
SELECT is((SELECT array_agg(name ORDER BY "order") FROM public.channels
            WHERE server_id = NULLIF(current_setting('t201.tpl_server', true), '')::uuid),
          ARRAY['channel', 'old-style-name', 'Lounge ?'],
  'that channel is named ''channel''; the others follow the rule of their type');

-- create_channel. -------------------------------------------------------------------------
INSERT INTO public.server_encryption_settings (server_id, encryption_mode, voice_encryption_mode)
VALUES ('55555555-0000-0000-0000-000000000005', 'optional', 'disabled')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional', voice_encryption_mode = 'disabled';

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO c201 SELECT 'text', (public.create_channel('55555555-0000-0000-0000-000000000005', 'Road Map 2026',
    p_description => '  Plans and dates ', p_slowmode_seconds => 30)).id;
INSERT INTO c201 SELECT 'secret', (public.create_channel('55555555-0000-0000-0000-000000000005', 'secret-201',
    p_messages_encrypted => true, p_history_visibility => 'pinned')).id;
INSERT INTO c201 SELECT 'voice', (public.create_channel('55555555-0000-0000-0000-000000000005', 'Stage  Door', 1,
    p_voice_encrypted => true, p_description => 'Weekly')).id;
INSERT INTO c201 SELECT 'legacy', (public.create_channel('55555555-0000-0000-0000-000000000005', 'Six Args', 0, NULL,
    false, '{}'::uuid[])).id;
SELECT throws_ok(
  $q$SELECT public.create_channel('55555555-0000-0000-0000-000000000005', 'slow-201', p_slowmode_seconds => 21601)$q$,
  '22023', NULL, 'slowmode above six hours is refused');
SELECT throws_ok(
  $q$SELECT public.create_channel('55555555-0000-0000-0000-000000000005', 'history-201', p_messages_encrypted => true,
                                  p_history_visibility => 'everyone')$q$,
  '22023', NULL, 'an unknown history visibility is refused');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT tests.clear_authentication();

SELECT results_eq(
  $q$SELECT name, description, slowmode_seconds, type::int FROM public.channels
      WHERE id = (SELECT id FROM c201 WHERE k = 'text')$q$,
  $q$VALUES ('road-map-2026'::text, 'Plans and dates'::text, 30, 0)$q$,
  'create_channel stores the normalized name, the trimmed description and the slowmode');
SELECT results_eq(
  $q$SELECT name, description, slowmode_seconds FROM public.channels WHERE id = (SELECT id FROM c201 WHERE k = 'voice')$q$,
  $q$VALUES ('Stage Door'::text, 'Weekly'::text, 0)$q$,
  'a voice channel keeps its case and gets its description; slowmode defaults to 0');
SELECT is((SELECT name FROM public.channels WHERE id = (SELECT id FROM c201 WHERE k = 'legacy')), 'six-args',
  'a call naming only the six arguments of 1.9.0 creates the channel');
SELECT results_eq(
  $q$SELECT messages_encrypted, history_visibility FROM public.channel_encryption_settings
      WHERE channel_id = (SELECT id FROM c201 WHERE k = 'secret')$q$,
  $q$VALUES (true, 'pinned'::text)$q$,
  'encryption and history visibility chosen at creation are stored');
SELECT is(public.channel_messages_encrypted((SELECT id FROM c201 WHERE k = 'secret')), true,
  'the channel is encrypted from its creation');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = (SELECT id FROM c201 WHERE k = 'secret') AND is_system
              AND metadata->>'type' = 'channel_encryption_enabled'
              AND metadata->>'actor_id' = '11111111-0000-0000-0000-000000000001'), 1,
  'the encryption notice names the creator');
SELECT is((SELECT voice_encrypted FROM public.channel_encryption_settings
            WHERE channel_id = (SELECT id FROM c201 WHERE k = 'voice')), true,
  'voice encryption chosen at creation is stored');
SELECT is((SELECT count(*)::int FROM public.channels WHERE server_id = '55555555-0000-0000-0000-000000000005'
              AND name IN ('slow-201', 'history-201')), 0,
  'a refused option leaves no channel behind');

-- Atomic against the server's policy: messages encryption on a server without it.
UPDATE public.server_encryption_settings SET encryption_mode = 'disabled'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
  $q$SELECT public.create_channel('55555555-0000-0000-0000-000000000005', 'policy-201', p_messages_encrypted => true)$q$,
  '22023', NULL, 'encryption the server disallows refuses the creation');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.channels WHERE name = 'policy-201'), 0,
  'and no channel is created');

-- A channel manager without ADMINISTRATOR, private channel not listing the manager's role: the
-- options apply before the @everyone deny takes VIEW_CHANNEL from the manager.
UPDATE public.server_encryption_settings SET encryption_mode = 'optional'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2011000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'channel managers 201', 2, 4),
  ('f2011000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'staff 201', 3, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2011000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
  $q$SELECT set_config('t201.private', (public.create_channel('55555555-0000-0000-0000-000000000005', 'staff-only-201',
       p_private => true, p_allowed_role_ids => ARRAY['f2011000-0000-0000-0000-000000000002']::uuid[],
       p_messages_encrypted => true, p_history_visibility => 'none')).id::text, true)$q$,
  'a channel manager creates a private encrypted channel that excludes their own role');
SELECT tests.clear_authentication();
SELECT results_eq(
  $q$SELECT messages_encrypted, history_visibility FROM public.channel_encryption_settings
      WHERE channel_id = NULLIF(current_setting('t201.private', true), '')::uuid$q$,
  $q$VALUES (true, 'none'::text)$q$,
  'its encryption and history visibility are stored');
SELECT results_eq(
  $q$SELECT r.name, o.allow_permissions, o.deny_permissions
       FROM public.channel_permission_overrides o JOIN public.server_roles r ON r.id = o.role_id
      WHERE o.channel_id = NULLIF(current_setting('t201.private', true), '')::uuid ORDER BY r.name$q$,
  $q$VALUES ('everyone'::text, 0::bigint, 2::bigint), ('staff 201'::text, 2::bigint, 0::bigint)$q$,
  'and it is private: @everyone denied VIEW_CHANNEL, the listed role allowed');
UPDATE public.server_encryption_settings SET encryption_mode = 'disabled'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
DELETE FROM public.user_roles WHERE role_id = 'f2011000-0000-0000-0000-000000000001';

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
  $q$SELECT public.create_channel('55555555-0000-0000-0000-000000000005', 'bob-201', p_description => 'x')$q$,
  '42501', NULL, 'a member without MANAGE_CHANNELS cannot create a channel with options');
SELECT throws_ok(
  $q$SELECT public.record_instance_branding('peer201.test', NULL, NULL, NULL)$q$,
  '42501', NULL, 'a client cannot record instance branding');
SELECT tests.clear_authentication();

SELECT ok(to_regprocedure('public.create_channel(uuid, text, integer, uuid, boolean, uuid[])') IS NULL,
  'the six-argument signature is gone, so named calls resolve to one function');
SELECT is(prosecdef, false, 'create_channel stays SECURITY INVOKER')
  FROM pg_proc WHERE oid = 'public.create_channel(uuid, text, integer, uuid, boolean, uuid[], text, integer, boolean, boolean, text)'::regprocedure;
SELECT ok(NOT has_function_privilege('anon', 'public.create_channel(uuid, text, integer, uuid, boolean, uuid[], text, integer, boolean, boolean, text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.create_channel(uuid, text, integer, uuid, boolean, uuid[], text, integer, boolean, boolean, text)', 'EXECUTE'),
  'members call create_channel; anon does not');
SELECT ok(has_function_privilege('authenticated', 'public.channel_name_normalized(text, integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.channel_name_normalized(text, integer)', 'EXECUTE'),
  'the rule runs as the member who writes the channel');

-- record_instance_branding. -----------------------------------------------------------------
INSERT INTO public.federated_instances (domain, software, metadata) VALUES
  ('peer201.test', 'harmony', '{"software_source": "nodeinfo"}'),
  ('masto201.test', 'mastodon', '{"icon_url": "https://masto201.test/old.png", "banner_url": "https://masto201.test/thumb.png"}');

SELECT ok(NOT has_function_privilege('anon', 'public.record_instance_branding(text, text, text, text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.record_instance_branding(text, text, text, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.record_instance_branding(text, text, text, text)', 'EXECUTE'),
  'only service callers execute record_instance_branding');
SELECT is(public.record_instance_branding('Peer201.TEST', 'https://peer201.test/storage/icon.webp',
                                          'https://peer201.test/storage/banner.webp', '#e67e22'), true,
  'a known instance''s branding is recorded');
SELECT results_eq(
  $q$SELECT metadata->>'icon_url', metadata->>'banner_url', metadata->>'theme_color',
            metadata ? 'branding_read_at', metadata->>'software_source'
       FROM public.federated_instances WHERE domain = 'peer201.test'$q$,
  $q$VALUES ('https://peer201.test/storage/icon.webp'::text, 'https://peer201.test/storage/banner.webp'::text,
             '#e67e22'::text, true, 'nodeinfo'::text)$q$,
  'icon, banner, colour and the read time are stored beside the other metadata');
SELECT public.record_instance_branding('peer201.test', 'https://peer201.test/storage/icon-2.webp', NULL, NULL);
SELECT results_eq(
  $q$SELECT metadata->>'icon_url', metadata->>'banner_url', metadata->>'theme_color'
       FROM public.federated_instances WHERE domain = 'peer201.test'$q$,
  $q$VALUES ('https://peer201.test/storage/icon-2.webp'::text, 'https://peer201.test/storage/banner.webp'::text, '#e67e22'::text)$q$,
  'a new icon replaces the old; absent values keep theirs');
SELECT public.record_instance_branding('masto201.test', 'javascript:alert(1)', 'https://masto201.test/has space.png', 'red');
SELECT results_eq(
  $q$SELECT metadata->>'icon_url', metadata->>'banner_url', metadata ? 'theme_color'
       FROM public.federated_instances WHERE domain = 'masto201.test'$q$,
  $q$VALUES ('https://masto201.test/old.png'::text, 'https://masto201.test/thumb.png'::text, false)$q$,
  'values that are not http(s) URLs or hex colours are ignored');
SELECT is(public.record_instance_branding('unknown201.test', 'https://unknown201.test/i.png', NULL, NULL), false,
  'an unknown domain records nothing');
SELECT is((SELECT count(*)::int FROM public.federated_instances WHERE domain = 'unknown201.test'), 0,
  'and gains no row');

SELECT * FROM finish();
ROLLBACK;
