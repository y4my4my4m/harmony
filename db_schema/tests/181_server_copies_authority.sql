-- 20261027200001_server_copies_authority.sql.
--
--   copy      f181…c0, a copy of https://host.test/servers/f181…c0; alice (local) is its owner,
--             as the backend wrote before 1.8.12, and holds its Admin role; bob a member with a
--             copy role holding ADMINISTRATOR; channel f181…c1, bob's message f181…a1 (pinned)
--   hostowner f181…e1, the remote profile https://host.test/users/hostowner
--   mallory   instance admin, a member of the copy only
--   server_1  local, owned by alice (fixtures)
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(66);

UPDATE public.profiles SET is_admin = true WHERE id = '33333333-0000-0000-0000-000000000003';

INSERT INTO public.profiles (id, username, display_name, domain, is_local, federated_id) VALUES
  ('f1810000-0000-0000-0000-0000000000e1', 'hostowner', 'Host Owner', 'host.test', false,
   'https://host.test/users/hostowner'),
  ('f1810000-0000-0000-0000-0000000000e2', 'elsewhere', 'Elsewhere', 'other.test', false,
   'https://other.test/users/elsewhere');

INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, ap_id, host_domain,
                            federation_domain, federation_inbox_url, federation_metadata) VALUES
  ('f1810000-0000-0000-0000-0000000000c0', 'Copy 181', 'f1810000-0000-0000-0000-0000000000e1', false, true,
   'https://host.test/servers/f1810000-0000-0000-0000-0000000000c0', 'host.test', 'host.test',
   'https://host.test/servers/f1810000-0000-0000-0000-0000000000c0/inbox',
   '{"attributedTo":"https://host.test/users/hostowner"}');

SELECT is((SELECT count(*)::int FROM public.user_roles WHERE server_id = 'f1810000-0000-0000-0000-0000000000c0'),
          0, 'a new copy assigns its Admin role to no one');
SELECT is((SELECT count(*)::int FROM public.server_roles WHERE server_id = 'f1810000-0000-0000-0000-0000000000c0'),
          2, 'a new copy still has @everyone and Admin');

INSERT INTO public.servers (id, name, owner) VALUES
  ('f1810000-0000-0000-0000-0000000000b0', 'Local 181', '22222222-0000-0000-0000-000000000002');
SELECT ok(EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
                   WHERE ur.server_id = 'f1810000-0000-0000-0000-0000000000b0'
                     AND ur.user_id = '22222222-0000-0000-0000-000000000002' AND sr.is_admin),
          'a new local server assigns its Admin role to its owner');

-- Legacy state: the oldest local admin as the copy's owner, with the stand-in Admin role.
UPDATE public.servers SET owner = '11111111-0000-0000-0000-000000000001'
 WHERE id = 'f1810000-0000-0000-0000-0000000000c0';
INSERT INTO public.user_roles (user_id, role_id, server_id)
SELECT '11111111-0000-0000-0000-000000000001', sr.id, sr.server_id
  FROM public.server_roles sr
 WHERE sr.server_id = 'f1810000-0000-0000-0000-0000000000c0' AND sr.is_admin;
INSERT INTO public.server_roles (id, server_id, name, permissions, position) VALUES
  ('f1810000-0000-0000-0000-0000000000d1', 'f1810000-0000-0000-0000-0000000000c0', 'Copy admins', 1, 5);
INSERT INTO public.user_servers (user_id, server_id, status, member_instance) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f1810000-0000-0000-0000-0000000000c0', 'accepted', 'localhost'),
  ('22222222-0000-0000-0000-000000000002', 'f1810000-0000-0000-0000-0000000000c0', 'accepted', 'localhost'),
  ('33333333-0000-0000-0000-000000000003', 'f1810000-0000-0000-0000-0000000000c0', 'accepted', 'localhost');
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1810000-0000-0000-0000-0000000000d1', 'f1810000-0000-0000-0000-0000000000c0');
INSERT INTO public.channels (id, server_id, name, type, is_remote, ap_id) VALUES
  ('f1810000-0000-0000-0000-0000000000c1', 'f1810000-0000-0000-0000-0000000000c0', 'general', 0, true,
   'https://host.test/servers/f1810000-0000-0000-0000-0000000000c0/channels/f1810000-0000-0000-0000-0000000000c1');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, user_id, allow_permissions, deny_permissions) VALUES
  ('f1810000-0000-0000-0000-0000000000c1', 'user', '22222222-0000-0000-0000-000000000002', 2097152, 0);
INSERT INTO public.messages (id, channel_id, user_id, content, is_pinned) VALUES
  ('f1810000-0000-0000-0000-0000000000a1', 'f1810000-0000-0000-0000-0000000000c1',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob in the copy https://example.com"}]', true),
  ('f1810000-0000-0000-0000-0000000000a2', 'f1810000-0000-0000-0000-0000000000c1',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"alice in the copy"}]', false);
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('f1810000-0000-0000-0000-0000000000f1', 'f1810000-0000-0000-0000-0000000000c1',
   'f1810000-0000-0000-0000-0000000000a1', 'bob''s thread', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.server_settings (server_id) VALUES ('f1810000-0000-0000-0000-0000000000c0')
ON CONFLICT (server_id) DO NOTHING;
INSERT INTO public.bots (id, username, owner_id) VALUES
  ('f1810000-0000-0000-0000-0000000000b1', 'bot181', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by) VALUES
  ('f1810000-0000-0000-0000-0000000000b1', 'f1810000-0000-0000-0000-0000000000c0', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.emojis (id, name, url, server_id, uploader, scope) VALUES
  ('f1810000-0000-0000-0000-0000000000e5', 'copy181', 'https://host.test/e.png',
   'f1810000-0000-0000-0000-0000000000c0', '11111111-0000-0000-0000-000000000001', 'server');

-- get_user_permissions ------------------------------------------------------------------------
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', 'f1810000-0000-0000-0000-0000000000c0')
            ->> 'MANAGE_SERVER', 'false', 'the owner of a copy holds no owner bits there');
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', 'f1810000-0000-0000-0000-0000000000c0')
            ->> 'ADMINISTRATOR', 'false', 'nor ADMINISTRATOR, through the stand-in Admin role');
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', 'f1810000-0000-0000-0000-0000000000c0')
            ->> 'SEND_MESSAGES', 'true', 'a member of a copy keeps @everyone''s member bits');
SELECT is(public.get_user_permissions('22222222-0000-0000-0000-000000000002', 'f1810000-0000-0000-0000-0000000000c0')
            ->> 'KICK_MEMBERS', 'false', 'a copy role holding ADMINISTRATOR grants no moderation');
SELECT is(public.get_user_permissions('22222222-0000-0000-0000-000000000002', 'f1810000-0000-0000-0000-0000000000c0',
                                      'f1810000-0000-0000-0000-0000000000c1') ->> 'MANAGE_MESSAGES', 'false',
          'nor does a channel override allowing MANAGE_MESSAGES in a copy');
SELECT is(public.get_user_permissions('22222222-0000-0000-0000-000000000002', 'f1810000-0000-0000-0000-0000000000c0',
                                      'f1810000-0000-0000-0000-0000000000c1') ->> 'READ_MESSAGE_HISTORY', 'true',
          'the channel''s member bits stay');
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005')
            ->> 'ADMINISTRATOR', 'true', 'the owner of a local server holds every bit');

-- RPCs refuse a copy ----------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.kick_server_member('f1810000-0000-0000-0000-0000000000c0', '22222222-0000-0000-0000-000000000002', 'x', 0)$q$,
                 '42501', 'Members of this server are moderated on its home instance', 'kick refuses a copy, to its owner');
SELECT throws_ok($q$SELECT public.ban_server_member('f1810000-0000-0000-0000-0000000000c0', '22222222-0000-0000-0000-000000000002', 'x', 0)$q$,
                 '42501', 'Members of this server are moderated on its home instance', 'ban refuses a copy');
SELECT throws_ok($q$SELECT public.unban_server_member('f1810000-0000-0000-0000-0000000000c0', '44444444-0000-0000-0000-000000000004')$q$,
                 '42501', 'Members of this server are moderated on its home instance', 'unban refuses a copy');
SELECT throws_ok($q$SELECT public.get_server_bans('f1810000-0000-0000-0000-0000000000c0')$q$,
                 '42501', 'Bans of this server are kept on its home instance', 'the ban list refuses a copy');
SELECT throws_ok($q$SELECT public.delete_server_with_cleanup('f1810000-0000-0000-0000-0000000000c0', '11111111-0000-0000-0000-000000000001')$q$,
                 '42501', 'This server is deleted on its home instance; leave it instead', 'delete refuses a copy');
SELECT throws_ok($q$SELECT public.pin_message('f1810000-0000-0000-0000-0000000000a2')$q$,
                 '42501', 'Pins of this server are set on its home instance', 'pin refuses a message of a copy');
SELECT throws_ok($q$SELECT public.unpin_message('f1810000-0000-0000-0000-0000000000a1')$q$,
                 '42501', 'Pins of this server are set on its home instance', 'unpin refuses a message of a copy');
SELECT throws_ok($q$SELECT public.set_message_embeds_suppressed('f1810000-0000-0000-0000-0000000000a1', true)$q$,
                 '42501', 'Only the author changes embeds in a server hosted on another instance',
                 'another member''s embeds stay in a copy');
SELECT throws_ok($q$INSERT INTO public.invites (server_id, created_by, code) VALUES
                    ('f1810000-0000-0000-0000-0000000000c0', '11111111-0000-0000-0000-000000000001', 'copy181')$q$,
                 '42501', NULL, 'no invite is created for a copy');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_message_embeds_suppressed('f1810000-0000-0000-0000-0000000000a1', true), true,
          'the author hides their own message''s embeds in a copy');
SELECT throws_ok($q$SELECT public.kick_server_member('f1810000-0000-0000-0000-0000000000c0', '11111111-0000-0000-0000-000000000001', 'x', 0)$q$,
                 '42501', 'Members of this server are moderated on its home instance', 'kick refuses a copy, to a copy role holder');

-- Client writes refuse a copy, to its owner and to an instance admin ----------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$INSERT INTO public.channels (server_id, name, type) VALUES ('f1810000-0000-0000-0000-0000000000c0', 'new', 0)$q$,
                 '42501', NULL, 'the copy''s owner creates no channel');
WITH u AS (UPDATE public.channels SET name = 'renamed' WHERE id = 'f1810000-0000-0000-0000-0000000000c1' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor renames one') FROM u;
WITH d AS (DELETE FROM public.channels WHERE id = 'f1810000-0000-0000-0000-0000000000c1' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor deletes one') FROM d;
SELECT throws_ok($q$INSERT INTO public.channel_categories (server_id, name) VALUES ('f1810000-0000-0000-0000-0000000000c0', 'cat')$q$,
                 '42501', NULL, 'nor creates a category');
SELECT throws_ok($q$INSERT INTO public.server_roles (server_id, name, permissions, position) VALUES ('f1810000-0000-0000-0000-0000000000c0', 'r', 0, 1)$q$,
                 '42501', NULL, 'nor a role');
WITH u AS (UPDATE public.server_roles SET permissions = 0
                       WHERE server_id = 'f1810000-0000-0000-0000-0000000000c0' AND is_default RETURNING 1)
SELECT is(count(*)::int, 0, 'nor edits @everyone') FROM u;
WITH d AS (DELETE FROM public.server_roles WHERE id = 'f1810000-0000-0000-0000-0000000000d1' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor deletes a role') FROM d;
SELECT throws_ok($q$INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
                    ('22222222-0000-0000-0000-000000000002',
                     (SELECT id FROM public.server_roles WHERE server_id = 'f1810000-0000-0000-0000-0000000000c0' AND is_admin),
                     'f1810000-0000-0000-0000-0000000000c0')$q$,
                 '42501', NULL, 'nor assigns a role');
WITH d AS (DELETE FROM public.user_roles WHERE role_id = 'f1810000-0000-0000-0000-0000000000d1' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor removes one') FROM d;
SELECT throws_ok($q$INSERT INTO public.emojis (name, url, server_id, uploader, scope) VALUES
                    ('nope181', 'https://x.test/e.png', 'f1810000-0000-0000-0000-0000000000c0', '11111111-0000-0000-0000-000000000001', 'server')$q$,
                 '42501', NULL, 'nor uploads a server emoji');
WITH d AS (DELETE FROM public.emojis WHERE id = 'f1810000-0000-0000-0000-0000000000e5' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor deletes one') FROM d;
WITH u AS (UPDATE public.server_settings SET system_messages_enabled = false
                       WHERE server_id = 'f1810000-0000-0000-0000-0000000000c0' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor changes server settings') FROM u;
WITH u AS (UPDATE public.bot_server_permissions SET is_active = false
                       WHERE server_id = 'f1810000-0000-0000-0000-0000000000c0' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor a bot installation') FROM u;
SELECT throws_ok($q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, user_id, allow_permissions, deny_permissions) VALUES
                    ('f1810000-0000-0000-0000-0000000000c1', 'user', '11111111-0000-0000-0000-000000000001', 0, 2)$q$,
                 '42501', NULL, 'nor sets a channel override');
WITH u AS (UPDATE public.threads SET name = 'renamed' WHERE id = 'f1810000-0000-0000-0000-0000000000f1' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor renames another member''s thread') FROM u;
WITH u AS (UPDATE public.servers SET name = 'renamed' WHERE id = 'f1810000-0000-0000-0000-0000000000c0' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor renames the copy') FROM u;
WITH d AS (DELETE FROM public.servers WHERE id = 'f1810000-0000-0000-0000-0000000000c0' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor deletes it') FROM d;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
WITH u AS (UPDATE public.threads SET name = 'mine' WHERE id = 'f1810000-0000-0000-0000-0000000000f1' RETURNING 1)
SELECT is(count(*)::int, 1, 'a member renames their own thread in a copy') FROM u;
WITH u AS (UPDATE public.messages SET is_deleted = true WHERE id = 'f1810000-0000-0000-0000-0000000000a2' RETURNING 1)
SELECT is(count(*)::int, 0, 'a copy role holder hides no one else''s message') FROM u;

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$INSERT INTO public.channels (server_id, name, type) VALUES ('f1810000-0000-0000-0000-0000000000c0', 'new', 0)$q$,
                 '42501', NULL, 'an instance admin and member creates no channel in a copy');
SELECT throws_ok($q$INSERT INTO public.server_roles (server_id, name, permissions, position) VALUES ('f1810000-0000-0000-0000-0000000000c0', 'r', 0, 1)$q$,
                 '42501', NULL, 'nor a role');
SELECT throws_ok($q$INSERT INTO public.emojis (name, url, server_id, uploader, scope) VALUES
                    ('nope181', 'https://x.test/e.png', 'f1810000-0000-0000-0000-0000000000c0', '33333333-0000-0000-0000-000000000003', 'server')$q$,
                 '42501', NULL, 'nor uploads a server emoji');
WITH u AS (UPDATE public.server_settings SET system_messages_enabled = false
                       WHERE server_id = 'f1810000-0000-0000-0000-0000000000c0' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor changes server settings') FROM u;
WITH u AS (UPDATE public.threads SET name = 'staff' WHERE id = 'f1810000-0000-0000-0000-0000000000f1' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor renames a thread') FROM u;
WITH u AS (UPDATE public.messages SET is_deleted = true WHERE id = 'f1810000-0000-0000-0000-0000000000a2' RETURNING 1)
SELECT is(count(*)::int, 1, 'instance staff still hide a message in a copy') FROM u;

-- Host side ---------------------------------------------------------------------------------
SELECT throws_ok($q$INSERT INTO public.channels (server_id, name, type) VALUES ('55555555-0000-0000-0000-000000000005', 'staff181', 0)$q$,
                 '42501', NULL, 'an instance admin creates no channel in a local server it does not manage');
WITH u AS (UPDATE public.server_roles SET permissions = 0
                       WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default RETURNING 1)
SELECT is(count(*)::int, 0, 'nor edits its roles') FROM u;
WITH u AS (UPDATE public.server_settings SET system_messages_enabled = false
                       WHERE server_id = '55555555-0000-0000-0000-000000000005' RETURNING 1)
SELECT is(count(*)::int, 0, 'nor its settings') FROM u;
SELECT is(public.caller_outranks_all('55555555-0000-0000-0000-000000000005'), false,
          'an instance admin does not outrank a local server''s roles');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.channels (server_id, name, type) VALUES ('55555555-0000-0000-0000-000000000005', 'owner181', 0)$q$,
                'the owner of a local server creates a channel');
WITH u AS (UPDATE public.server_roles SET name = 'Admin 181'
                       WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_admin RETURNING 1)
SELECT is(count(*)::int, 1, 'and edits a role') FROM u;
SELECT lives_ok($q$INSERT INTO public.channel_categories (server_id, name) VALUES ('55555555-0000-0000-0000-000000000005', 'cat181')$q$,
                'and creates a category');
SELECT is(public.caller_outranks_all('55555555-0000-0000-0000-000000000005'), true,
          'the owner of a local server outranks its roles');
SELECT is(public.pin_message('88888888-0000-0000-0000-000000000008'), true, 'the owner pins in a local server');
SELECT lives_ok($q$INSERT INTO public.invites (server_id, created_by, code) VALUES
                   ('55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 'local181')$q$,
                'a member creates an invite to a local server');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO public.channels (server_id, name, type) VALUES ('55555555-0000-0000-0000-000000000005', 'bob181', 0)$q$,
                 '42501', NULL, 'a member without MANAGE_CHANNELS creates no channel');

-- Existing copies ------------------------------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, ap_id, federation_metadata) VALUES
  ('f1810000-0000-0000-0000-0000000000c2', 'Copy 181 b', '11111111-0000-0000-0000-000000000001', false, true,
   'https://host.test/servers/f1810000-0000-0000-0000-0000000000c2', '{"attributedTo":"https://other.test/users/elsewhere"}'),
  ('f1810000-0000-0000-0000-0000000000c3', 'Copy 181 c', '11111111-0000-0000-0000-000000000001', false, true,
   'https://host.test/servers/f1810000-0000-0000-0000-0000000000c3', '{}'),
  ('f1810000-0000-0000-0000-0000000000c4', 'Copy 181 d', '11111111-0000-0000-0000-000000000001', false, true,
   'https://host.test/servers/f1810000-0000-0000-0000-0000000000c4', '{"attributedTo":"https://host.test/users/unknown"}');
INSERT INTO public.messages (id, channel_id, content, is_system, metadata) VALUES
  ('f1810000-0000-0000-0000-000000000101', 'f1810000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"was kicked from the server"}]', true,
   '{"type":"member_kick","subject_id":"22222222-0000-0000-0000-000000000002","actor_id":"11111111-0000-0000-0000-000000000001","reason":""}'),
  ('f1810000-0000-0000-0000-000000000102', 'f1810000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"was banned from the server"}]', true,
   '{"type":"member_ban","subject_id":"22222222-0000-0000-0000-000000000002","actor_id":"11111111-0000-0000-0000-000000000001","reason":""}'),
  ('f1810000-0000-0000-0000-000000000103', 'f1810000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"was kicked from the server"}]', true,
   '{"type":"member_kick","subject_id":"22222222-0000-0000-0000-000000000002","federated":true,
     "ap_id":"https://host.test/servers/f1810000-0000-0000-0000-0000000000c0/messages/103"}'),
  ('f1810000-0000-0000-0000-000000000104', 'f1810000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"has joined the server"}]', true,
   '{"type":"member_join","subject_id":"22222222-0000-0000-0000-000000000002"}'),
  ('f1810000-0000-0000-0000-000000000105', '66666666-0000-0000-0000-000000000006',
   '[{"type":"text","text":"was kicked from the server"}]', true,
   '{"type":"member_kick","subject_id":"22222222-0000-0000-0000-000000000002","actor_id":"11111111-0000-0000-0000-000000000001","reason":""}');

\! sed -n '/^-- Existing copies\. /,/^COMMIT;$/{/^COMMIT;$/!p}' /db_schema/migrations/20261027200001_server_copies_authority.sql > /tmp/upgrade181.sql
\! test -s /tmp/upgrade181.sql || echo 'ERROR: /db_schema/migrations/20261027200001_server_copies_authority.sql is not in the container; copy db_schema to /db_schema'
\i /tmp/upgrade181.sql

SELECT results_eq(
    $q$SELECT id, owner FROM public.servers WHERE id::text LIKE 'f1810000-0000-0000-0000-0000000000c%' ORDER BY id$q$,
    $q$VALUES ('f1810000-0000-0000-0000-0000000000c0'::uuid, 'f1810000-0000-0000-0000-0000000000e1'::uuid),
              ('f1810000-0000-0000-0000-0000000000c2', NULL),
              ('f1810000-0000-0000-0000-0000000000c3', NULL),
              ('f1810000-0000-0000-0000-0000000000c4', NULL)$q$,
    'each copy is owned by the profile its Group names on its own host, else by no one');
SELECT is((SELECT owner FROM public.servers WHERE id = 'f1810000-0000-0000-0000-0000000000b0'),
          '22222222-0000-0000-0000-000000000002'::uuid, 'a local server keeps its owner');
SELECT is((SELECT count(*)::int FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
            WHERE ur.server_id = 'f1810000-0000-0000-0000-0000000000c0' AND sr.is_admin),
          0, 'no one holds a copy''s stand-in Admin role');
SELECT is((SELECT count(*)::int FROM public.user_roles WHERE role_id = 'f1810000-0000-0000-0000-0000000000d1'),
          0, 'no copy-local role assignment outlives the upgrade: nobody could change it afterwards');
SELECT is((SELECT count(*)::int FROM public.server_roles WHERE id = 'f1810000-0000-0000-0000-0000000000d1'),
          0, 'nor a copy-local role');
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f1810000-0000-0000-0000-0000000000c0' AND is_default),
          3343872258::bigint, 'a copy''s @everyone holds the default of a new server');
SELECT ok(EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
                   WHERE ur.server_id = '55555555-0000-0000-0000-000000000005' AND sr.is_admin),
          'a local server''s Admin role keeps its holders');
SELECT set_eq(
    $q$SELECT id FROM public.messages WHERE id::text LIKE 'f1810000-0000-0000-0000-0000000001%'$q$,
    $q$VALUES ('f1810000-0000-0000-0000-000000000103'::uuid), ('f1810000-0000-0000-0000-000000000104'),
              ('f1810000-0000-0000-0000-000000000105')$q$,
    'kick and ban notices posted here in a copy are gone; the host''s, other notices and a local server''s stay');

CREATE TEMP TABLE servers181 AS SELECT id, owner FROM public.servers;
CREATE TEMP TABLE roles181 AS SELECT user_id, role_id FROM public.user_roles;
CREATE TEMP TABLE messages181 AS SELECT id FROM public.messages;
\i /tmp/upgrade181.sql
SELECT ok(NOT EXISTS (SELECT id, owner FROM public.servers EXCEPT SELECT * FROM servers181)
          AND NOT EXISTS (SELECT user_id, role_id FROM public.user_roles EXCEPT SELECT * FROM roles181)
          AND NOT EXISTS (SELECT * FROM roles181 EXCEPT SELECT user_id, role_id FROM public.user_roles)
          AND NOT EXISTS (SELECT * FROM messages181 EXCEPT SELECT id FROM public.messages),
          'a second run changes nothing');

SELECT * FROM finish();
ROLLBACK;
