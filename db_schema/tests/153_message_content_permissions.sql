-- 20261017100001_message_content_permissions.sql: EMBED_LINKS, USE_EXTERNAL_EMOJIS and
-- READ_MESSAGE_HISTORY for members of local servers.
--
--   alice    owns server_1; membership 30 days old
--   bob      member; membership 2 days old
--   mallory  member for this file; joined 1 hour ago
--
--   history  @everyone: Deny READ_MESSAGE_HISTORY
--   links    @everyone: Deny EMBED_LINKS
--   emoji    @everyone: Deny USE_EXTERNAL_EMOJIS
--   general  no overrides
--
-- Bits: EMBED_LINKS 1 << 16 = 65536, USE_EXTERNAL_EMOJIS 1 << 19 = 524288,
-- READ_MESSAGE_HISTORY 1 << 22 = 4194304; default @everyone mask 3343872258.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(72);

UPDATE public.server_automod_settings SET enabled = false WHERE server_id = '55555555-0000-0000-0000-000000000005';
UPDATE public.user_servers SET created_at = now() - interval '30 days'
 WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = '55555555-0000-0000-0000-000000000005';
UPDATE public.user_servers SET created_at = now() - interval '2 days'
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND server_id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.user_servers (user_id, server_id, status, created_at)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted', now() - interval '1 hour')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = 'accepted', created_at = EXCLUDED.created_at;

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1530000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'history', 0),
  ('f1530000-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000005', 'links', 0),
  ('f1530000-0000-0000-0000-0000000000a3', '55555555-0000-0000-0000-000000000005', 'emoji', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT ch, 'role', (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 0, bit
  FROM (VALUES ('f1530000-0000-0000-0000-0000000000a1'::uuid, 4194304::bigint),
               ('f1530000-0000-0000-0000-0000000000a2'::uuid, 65536::bigint),
               ('f1530000-0000-0000-0000-0000000000a3'::uuid, 524288::bigint)) v(ch, bit);
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1531000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'readers', 1, 0),
  ('f1531000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'historians', 2, 4194304);

-- History: alice's message from yesterday, mallory's own from before she rejoined, alice's from
-- ten minutes ago, an old pinned message, a thread on the old message with one reply on each
-- side of the join, and an old message in general.
INSERT INTO public.messages (id, channel_id, user_id, content, created_at, updated_at, is_pinned) VALUES
  ('f1532000-0000-0000-0000-0000000000a1', 'f1530000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"before mallory joined"}]', now() - interval '1 day', now() - interval '1 day', false),
  ('f1532000-0000-0000-0000-0000000000a2', 'f1530000-0000-0000-0000-0000000000a1', '33333333-0000-0000-0000-000000000003',
   '[{"type":"text","text":"mallory before she rejoined"}]', now() - interval '3 days', now() - interval '3 days', false),
  ('f1532000-0000-0000-0000-0000000000a3', 'f1530000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"after mallory joined"}]', now() - interval '10 minutes', now() - interval '10 minutes', false),
  ('f1532000-0000-0000-0000-0000000000a4', 'f1530000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"old pinned notice"}]', now() - interval '1 day', now() - interval '1 day', true),
  ('f1532000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"old general message"}]', now() - interval '1 day', now() - interval '1 day', false);
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
VALUES ('f1533000-0000-0000-0000-000000000001', 'f1530000-0000-0000-0000-0000000000a1',
        'f1532000-0000-0000-0000-0000000000a1', 'old thread', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content, created_at, updated_at) VALUES
  ('f1532000-0000-0000-0000-0000000000a5', 'f1530000-0000-0000-0000-0000000000a1', 'f1533000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"old thread reply"}]', now() - interval '23 hours', now() - interval '23 hours'),
  ('f1532000-0000-0000-0000-0000000000a6', 'f1530000-0000-0000-0000-0000000000a1', 'f1533000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"new thread reply"}]', now() - interval '5 minutes', now() - interval '5 minutes');
INSERT INTO public.message_polls (id, message_id, question) VALUES
  ('f1536000-0000-0000-0000-000000000001', 'f1532000-0000-0000-0000-0000000000a1', 'old question'),
  ('f1536000-0000-0000-0000-000000000002', 'f1532000-0000-0000-0000-0000000000a3', 'new question');
INSERT INTO public.message_poll_options (id, poll_id, position, text) VALUES
  ('f1536100-0000-0000-0000-000000000001', 'f1536000-0000-0000-0000-000000000001', 0, 'yes'),
  ('f1536100-0000-0000-0000-000000000002', 'f1536000-0000-0000-0000-000000000002', 0, 'yes');

-- A remote server copy: @everyone lacks READ_MESSAGE_HISTORY there too.
INSERT INTO public.servers (id, name, owner, is_local_server)
VALUES ('f1535000-0000-0000-0000-000000000002', 'Remote copy', '11111111-0000-0000-0000-000000000001', false);
UPDATE public.server_roles SET permissions = 3343872258 & ~4194304
 WHERE server_id = 'f1535000-0000-0000-0000-000000000002' AND is_default;
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f1530000-0000-0000-0000-0000000000c1', 'f1535000-0000-0000-0000-000000000002', 'remote', 0);
INSERT INTO public.user_servers (user_id, server_id, status, created_at)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1535000-0000-0000-0000-000000000002', 'accepted', now() - interval '1 hour')
ON CONFLICT (user_id, server_id) DO NOTHING;
INSERT INTO public.messages (id, channel_id, user_id, content, created_at, updated_at)
VALUES ('f1532000-0000-0000-0000-0000000000c1', 'f1530000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"remote history"}]', now() - interval '1 day', now() - interval '1 day');

-- Emoji: server_1's own, another server's, instance, personal, and a Discord emoji imported
-- into server_1.
INSERT INTO public.servers (id, name, owner)
VALUES ('f1535000-0000-0000-0000-000000000001', 'Other server', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.emojis (id, name, url, server_id, scope, uploader, discord_emoji_id) VALUES
  ('f1534000-0000-0000-0000-000000000001', 'local153', 'https://cdn.test/local.png', '55555555-0000-0000-0000-000000000005', 'server', NULL, NULL),
  ('f1534000-0000-0000-0000-000000000002', 'other153', 'https://cdn.test/other.png', 'f1535000-0000-0000-0000-000000000001', 'server', NULL, NULL),
  ('f1534000-0000-0000-0000-000000000003', 'inst153', 'https://cdn.test/instance.png', NULL, 'instance', NULL, NULL),
  ('f1534000-0000-0000-0000-000000000004', 'mine153', 'https://cdn.test/mine.png', NULL, 'user', '33333333-0000-0000-0000-000000000003', NULL),
  ('f1534000-0000-0000-0000-000000000005', 'imported153', 'https://cdn.test/imported.png', '55555555-0000-0000-0000-000000000005', 'server', NULL, '900000000000001531');
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f1532000-0000-0000-0000-0000000000e1', 'f1530000-0000-0000-0000-0000000000a3', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"react here"}]'),
  ('f1532000-0000-0000-0000-0000000000e2', 'f1530000-0000-0000-0000-0000000000a3', '33333333-0000-0000-0000-000000000003',
   '[{"type":"text","text":"bridged "},{"type":"emoji","emoji":{"id":"f1534000-0000-0000-0000-000000000002","name":"other153","url":"https://cdn.test/other.png"}}]');

CREATE TEMP TABLE m153 (k text PRIMARY KEY, id uuid);
GRANT ALL ON m153 TO authenticated;

CREATE FUNCTION pg_temp.ids(p_sql text) RETURNS uuid[] LANGUAGE plpgsql AS $fn$
DECLARE r uuid[];
BEGIN
  EXECUTE 'SELECT COALESCE(array_agg(x ORDER BY x), ''{}'') FROM (' || p_sql || ') s(x)' INTO r;
  RETURN r;
END $fn$;
CREATE FUNCTION pg_temp.post(p_user uuid, p_channel uuid, p_content jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE m jsonb;
BEGIN
  INSERT INTO public.messages (channel_id, user_id, content) VALUES (p_channel, p_user, p_content)
  RETURNING metadata INTO m;
  RETURN m;
END $fn$;
CREATE FUNCTION pg_temp.post_id(p_user uuid, p_channel uuid, p_content jsonb) RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE i uuid;
BEGIN
  INSERT INTO public.messages (channel_id, user_id, content) VALUES (p_channel, p_user, p_content) RETURNING id INTO i;
  RETURN i;
END $fn$;
CREATE FUNCTION pg_temp.post_dm(p_user uuid) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE m jsonb;
BEGIN
  INSERT INTO public.messages (conversation_id, user_id, content)
  VALUES ('77777777-0000-0000-0000-000000000007', p_user, '[{"type":"url","url":"https://example.com/dm","preview":true}]')
  RETURNING metadata INTO m;
  RETURN m;
END $fn$;
CREATE FUNCTION pg_temp.emoji(p_id text, p_url text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'look '),
         jsonb_build_object('type', 'emoji', 'emoji', jsonb_build_object('id', p_id, 'name', 'e', 'url', p_url)));
$fn$;
CREATE FUNCTION pg_temp.react(p_message uuid, p_user uuid, p_emoji_id uuid, p_content text) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.reactions (message_id, user_id, emoji_id, custom_emoji_content) VALUES (p_message, p_user, p_emoji_id, p_content);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

-- READ_MESSAGE_HISTORY ----------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE channel_id = 'f1530000-0000-0000-0000-0000000000a1' AND thread_id IS NULL$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000a2', 'f1532000-0000-0000-0000-0000000000a3']::uuid[],
          'without READ_MESSAGE_HISTORY a member reads messages from after joining and their own');
SELECT is((public.current_user_history_cutoffs() ->> 'f1530000-0000-0000-0000-0000000000a1')::timestamptz, now() - interval '1 hour',
          'the cutoff is the membership''s created_at');
SELECT is(public.current_user_history_cutoffs() ? '66666666-0000-0000-0000-000000000006', false,
          'a channel with the permission has no cutoff');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE channel_id = '66666666-0000-0000-0000-000000000006' AND id = 'f1532000-0000-0000-0000-0000000000b1'$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000b1']::uuid[], 'and keeps its whole history');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE thread_id = 'f1533000-0000-0000-0000-000000000001'$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000a6']::uuid[], 'thread replies follow the cutoff');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE channel_id = 'f1530000-0000-0000-0000-0000000000a1' AND is_pinned$q$),
          '{}'::uuid[], 'an old pinned message is not listed');
SELECT is(public.count_pinned_messages('f1530000-0000-0000-0000-0000000000a1', NULL), 0, 'nor counted');
SELECT is(pg_temp.ids($q$SELECT (m ->> 'id')::uuid FROM jsonb_array_elements(public.get_message_page('f1530000-0000-0000-0000-0000000000a1', NULL, 50, NULL) -> 'messages') m$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000a3']::uuid[],
          'a get_message_page page starts at the cutoff');
SELECT is((public.get_message_page('f1530000-0000-0000-0000-0000000000a1', NULL, 50, NULL) ->> 'history_since')::timestamptz,
          now() - interval '1 hour', 'and reports where it starts');
SELECT is(pg_temp.ids($q$SELECT message_id FROM public.search_messages(p_channel_id => 'f1530000-0000-0000-0000-0000000000a1')$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000a2', 'f1532000-0000-0000-0000-0000000000a3', 'f1532000-0000-0000-0000-0000000000a6']::uuid[],
          'search_messages follows the cutoff');
SELECT is(pg_temp.ids($q$SELECT message_id FROM public.search_messages(p_query => 'mallory') WHERE channel_id = 'f1530000-0000-0000-0000-0000000000a1'$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000a2', 'f1532000-0000-0000-0000-0000000000a3']::uuid[],
          'across every channel too');
SELECT is(pg_temp.ids($q$SELECT message_id FROM public.message_search_index WHERE channel_id = 'f1530000-0000-0000-0000-0000000000a1'$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000a2', 'f1532000-0000-0000-0000-0000000000a3', 'f1532000-0000-0000-0000-0000000000a6']::uuid[],
          'message_search_index follows the cutoff');
SELECT is(pg_temp.ids($q$SELECT poll_id FROM public.get_message_polls(ARRAY['f1536000-0000-0000-0000-000000000001', 'f1536000-0000-0000-0000-000000000002']::uuid[])$q$),
          ARRAY['f1536000-0000-0000-0000-000000000002']::uuid[], 'get_message_polls follows the cutoff');
SELECT is(pg_temp.ids($q$SELECT id FROM public.message_polls WHERE id IN ('f1536000-0000-0000-0000-000000000001', 'f1536000-0000-0000-0000-000000000002')$q$),
          ARRAY['f1536000-0000-0000-0000-000000000002']::uuid[], 'and so does message_polls');
SELECT throws_ok($q$SELECT * FROM public.vote_message_poll('f1536000-0000-0000-0000-000000000001', ARRAY['f1536100-0000-0000-0000-000000000001']::uuid[])$q$,
                 'P0002', NULL, 'a vote on a poll before the cutoff is refused');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE id = 'f1532000-0000-0000-0000-0000000000c1'$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000c1']::uuid[], 'a remote server copy keeps its history');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = '77777777-0000-0000-0000-000000000007'), 0,
          'a non-participant still reads no DM');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE channel_id = 'f1530000-0000-0000-0000-0000000000a1' AND thread_id IS NULL$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000a1', 'f1532000-0000-0000-0000-0000000000a3', 'f1532000-0000-0000-0000-0000000000a4']::uuid[],
          'each member''s cutoff is their own join');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE conversation_id = '77777777-0000-0000-0000-000000000007'$q$),
          ARRAY['99999999-0000-0000-0000-000000000009']::uuid[], 'DMs are untouched');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.messages WHERE channel_id = 'f1530000-0000-0000-0000-0000000000a1'), 6,
          'the owner reads everything');
SELECT is(public.current_user_history_cutoffs(), NULL::jsonb, 'and has no cutoffs');

-- The broadcast of an edit.
SELECT tests.clear_authentication();
DELETE FROM realtime.messages;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.messages SET content = '[{"type":"text","text":"before mallory joined, edited"}]'
 WHERE id = 'f1532000-0000-0000-0000-0000000000a1';
UPDATE public.messages SET content = '[{"type":"text","text":"after mallory joined, edited"}]'
 WHERE id = 'f1532000-0000-0000-0000-0000000000a3';
UPDATE public.messages SET content = '[{"type":"text","text":"old general message, edited"}]'
 WHERE id = 'f1532000-0000-0000-0000-0000000000b1';
SELECT tests.clear_authentication();
SELECT ok((SELECT (payload -> 'new' ->> 'restricted')::boolean AND NOT (payload -> 'new' ? 'content') AND NOT (payload -> 'new' ? 'user_id')
             FROM realtime.messages
            WHERE topic = 'channel-messages-f1530000-0000-0000-0000-0000000000a1'
              AND payload -> 'new' ->> 'id' = 'f1532000-0000-0000-0000-0000000000a1'),
          'an edit to a message older than the newest join broadcasts ids only');
SELECT ok((SELECT payload -> 'new' -> 'content' -> 0 ->> 'text' = 'after mallory joined, edited'
                  AND NOT (payload -> 'new' ? 'restricted')
             FROM realtime.messages
            WHERE topic = 'channel-messages-f1530000-0000-0000-0000-0000000000a1'
              AND payload -> 'new' ->> 'id' = 'f1532000-0000-0000-0000-0000000000a3'),
          'one newer than every join carries its content');
SELECT ok((SELECT payload -> 'new' ? 'content'
             FROM realtime.messages
            WHERE topic = 'channel-messages-66666666-0000-0000-0000-000000000006'
              AND payload -> 'new' ->> 'id' = 'f1532000-0000-0000-0000-0000000000b1'),
          'and so does any edit where everyone reads history');

-- A channel Allow on a role, then on the member, restores the history.
SELECT tests.clear_authentication();
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1531000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channel_permission_overrides (id, channel_id, target_type, role_id, allow_permissions)
VALUES ('f1537000-0000-0000-0000-000000000001', 'f1530000-0000-0000-0000-0000000000a1', 'role', 'f1531000-0000-0000-0000-000000000001', 4194304);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.messages WHERE channel_id = 'f1530000-0000-0000-0000-0000000000a1'), 6,
          'a role''s channel Allow restores READ_MESSAGE_HISTORY');
SELECT is(public.current_user_history_cutoffs(), NULL::jsonb, 'and clears the cutoff');
SELECT tests.clear_authentication();
DELETE FROM public.user_roles WHERE role_id = 'f1531000-0000-0000-0000-000000000001';
INSERT INTO public.channel_permission_overrides (id, channel_id, target_type, user_id, allow_permissions)
VALUES ('f1537000-0000-0000-0000-000000000002', 'f1530000-0000-0000-0000-0000000000a1', 'user', '33333333-0000-0000-0000-000000000003', 4194304);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.messages WHERE channel_id = 'f1530000-0000-0000-0000-0000000000a1'), 6,
          'so does a member Allow');
SELECT tests.clear_authentication();
DELETE FROM public.channel_permission_overrides WHERE id = 'f1537000-0000-0000-0000-000000000002';

-- Server level: @everyone without the bit restricts general; a role with it restores it; a
-- member Deny on the channel outranks the role.
UPDATE public.server_roles SET permissions = 3343872258 & ~4194304
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE id = 'f1532000-0000-0000-0000-0000000000b1'$q$),
          '{}'::uuid[], '@everyone without READ_MESSAGE_HISTORY hides older messages server-wide');
SELECT tests.clear_authentication();
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1531000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE id = 'f1532000-0000-0000-0000-0000000000b1'$q$),
          ARRAY['f1532000-0000-0000-0000-0000000000b1']::uuid[], 'a role granting it server-wide restores them');
SELECT tests.clear_authentication();
INSERT INTO public.channel_permission_overrides (channel_id, target_type, user_id, deny_permissions)
VALUES ('66666666-0000-0000-0000-000000000006', 'user', '33333333-0000-0000-0000-000000000003', 4194304);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.ids($q$SELECT id FROM public.messages WHERE id = 'f1532000-0000-0000-0000-0000000000b1'$q$),
          '{}'::uuid[], 'a member Deny in the channel outranks the role');
SELECT tests.clear_authentication();
DELETE FROM public.channel_permission_overrides
 WHERE channel_id = '66666666-0000-0000-0000-000000000006' AND user_id = '33333333-0000-0000-0000-000000000003';
DELETE FROM public.user_roles WHERE role_id = 'f1531000-0000-0000-0000-000000000002';
UPDATE public.server_roles SET permissions = 3343872258
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
DELETE FROM public.channel_permission_overrides WHERE id = 'f1537000-0000-0000-0000-000000000001';

-- EMBED_LINKS -------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a2',
                       '[{"type":"text","text":"see "},{"type":"url","url":"https://example.com/a","preview":true}]') -> 'suppress_embeds',
          'true'::jsonb, 'a link from a member without EMBED_LINKS is stored with embeds suppressed');
SELECT is(pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a2',
                       '[{"type":"embed","url":"https://example.com/b","provider":"generic","previewId":"x"}]') -> 'suppress_embeds',
          'true'::jsonb, 'so is an embed part');
SELECT ok(NOT (pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a2',
                            '[{"type":"text","text":"just words"}]') ? 'suppress_embeds'), 'text alone is untouched');
SELECT ok(NOT (pg_temp.post('33333333-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006',
                            '[{"type":"url","url":"https://example.com/c","preview":true}]') ? 'suppress_embeds'),
          'a link where the member holds EMBED_LINKS is untouched');
INSERT INTO m153 VALUES
  ('link', pg_temp.post_id('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a2',
                           '[{"type":"url","url":"https://example.com/d","preview":true}]')),
  ('plain', pg_temp.post_id('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a2',
                            '[{"type":"text","text":"edit me"}]')),
  ('general', pg_temp.post_id('33333333-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006',
                              '[{"type":"url","url":"https://example.com/e","preview":true}]'));
UPDATE public.messages SET content = '[{"type":"text","text":"edit me "},{"type":"url","url":"https://example.com/f","preview":true}]'
 WHERE id = (SELECT id FROM m153 WHERE k = 'plain');
SELECT is((SELECT metadata -> 'suppress_embeds' FROM public.messages WHERE id = (SELECT id FROM m153 WHERE k = 'plain')),
          'true'::jsonb, 'an edit that adds a link suppresses its embeds');
SELECT throws_ok($q$SELECT public.set_message_embeds_suppressed((SELECT id FROM m153 WHERE k = 'link'), false)$q$,
                 '42501', 'Missing permission: EMBED_LINKS', 'the author cannot restore the embeds');
SELECT lives_ok($q$SELECT public.set_message_embeds_suppressed((SELECT id FROM m153 WHERE k = 'general'), true)$q$,
                'the author suppresses embeds where they hold EMBED_LINKS');
SELECT lives_ok($q$SELECT public.set_message_embeds_suppressed((SELECT id FROM m153 WHERE k = 'general'), false)$q$,
                'and restores them');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.set_message_embeds_suppressed((SELECT id FROM m153 WHERE k = 'link'), false)$q$,
                 '42501', 'Missing permission: EMBED_LINKS', 'nor can the owner while the author lacks the permission');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT ok(NOT (pg_temp.post_dm('22222222-0000-0000-0000-000000000002') ? 'suppress_embeds'),
          'a DM link is untouched');
SELECT tests.clear_authentication();
SELECT ok(NOT (pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a2',
                            '[{"type":"url","url":"https://example.com/g","preview":true}]') ? 'suppress_embeds'),
          'a server-side writer is untouched');
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1531000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions)
VALUES ('f1530000-0000-0000-0000-0000000000a2', 'role', 'f1531000-0000-0000-0000-000000000001', 65536);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT ok(NOT (pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a2',
                            '[{"type":"url","url":"https://example.com/h","preview":true}]') ? 'suppress_embeds'),
          'a role''s channel Allow restores EMBED_LINKS');
SELECT lives_ok($q$SELECT public.set_message_embeds_suppressed((SELECT id FROM m153 WHERE k = 'link'), false)$q$,
                'and lets the author restore earlier embeds');
SELECT tests.clear_authentication();
DELETE FROM public.user_roles WHERE role_id = 'f1531000-0000-0000-0000-000000000001';

-- USE_EXTERNAL_EMOJIS -----------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                   pg_temp.emoji('f1534000-0000-0000-0000-000000000001', 'https://cdn.test/local.png'))$q$,
                'the server''s own emoji posts without USE_EXTERNAL_EMOJIS');
SELECT lives_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                   pg_temp.emoji('discord:imported153:900000000000001531', 'https://cdn.discordapp.com/emojis/900000000000001531.png'))$q$,
                'so does a Discord emoji imported into the server');
SELECT lives_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                   '[{"type":"text","text":"unicode 🎉"}]')$q$, 'and unicode');
SELECT throws_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                    pg_temp.emoji('f1534000-0000-0000-0000-000000000002', 'https://cdn.test/other.png'))$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'another server''s emoji is refused');
SELECT throws_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                    pg_temp.emoji('f1534000-0000-0000-0000-000000000003', 'https://cdn.test/instance.png'))$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'an instance emoji is refused');
SELECT throws_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                    pg_temp.emoji('f1534000-0000-0000-0000-000000000004', 'https://cdn.test/mine.png'))$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'a personal emoji is refused');
SELECT throws_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                    pg_temp.emoji('remote:blobcat', 'https://remote.test/blobcat.png'))$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'a remote emoji is refused');
SELECT throws_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                    pg_temp.emoji(NULL, 'https://cdn.discordapp.com/emojis/900000000000009999.png'))$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'a Discord emoji the server has not imported is refused');
SELECT throws_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                    pg_temp.emoji('f1534000-0000-0000-0000-000000000001', 'https://cdn.test/other.png'))$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'a local emoji id with another image is refused');
SELECT lives_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006',
                   pg_temp.emoji('f1534000-0000-0000-0000-000000000002', 'https://cdn.test/other.png'))$q$,
                'another server''s emoji posts where the member holds USE_EXTERNAL_EMOJIS');
SELECT lives_ok($q$UPDATE public.messages SET content = '[{"type":"text","text":"bridged, reworded "},{"type":"emoji","emoji":{"id":"f1534000-0000-0000-0000-000000000002","name":"other153","url":"https://cdn.test/other.png"}}]'
                    WHERE id = 'f1532000-0000-0000-0000-0000000000e2'$q$,
                'an edit keeping an external emoji already there passes');
SELECT throws_ok($q$UPDATE public.messages SET content = content || pg_temp.emoji('f1534000-0000-0000-0000-000000000003', 'https://cdn.test/instance.png')
                     WHERE id = 'f1532000-0000-0000-0000-0000000000e2'$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'an edit adding one is refused');

SELECT is(pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '33333333-0000-0000-0000-000000000003', 'f1534000-0000-0000-0000-000000000001', NULL), 1,
          'a reaction with the server''s own emoji passes');
SELECT is(pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '33333333-0000-0000-0000-000000000003', NULL, '🎉'), 1,
          'so does unicode');
SELECT is(pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '33333333-0000-0000-0000-000000000003', NULL, 'discord:imported153:900000000000001531'), 1,
          'and an imported Discord emoji');
SELECT throws_ok($q$SELECT pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '33333333-0000-0000-0000-000000000003', 'f1534000-0000-0000-0000-000000000002', NULL)$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'a reaction with another server''s emoji is refused');
SELECT throws_ok($q$SELECT pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '33333333-0000-0000-0000-000000000003', 'f1534000-0000-0000-0000-000000000004', NULL)$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'and with a personal emoji');
SELECT throws_ok($q$SELECT pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '33333333-0000-0000-0000-000000000003', NULL, 'discord:blob:900000000000009999')$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'and with a Discord emoji the server lacks');
SELECT throws_ok($q$SELECT pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '33333333-0000-0000-0000-000000000003', NULL, ':blobcat:')$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'and with a remote shortcode');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-000000000001', 'f1534000-0000-0000-0000-000000000002', NULL), 1,
          'the owner reacts with an external emoji');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '33333333-0000-0000-0000-000000000003', 'f1534000-0000-0000-0000-000000000002', NULL)$q$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS', 'joining that reaction is still refused');
SELECT is(pg_temp.react('f1532000-0000-0000-0000-0000000000b1', '33333333-0000-0000-0000-000000000003', 'f1534000-0000-0000-0000-000000000002', NULL), 1,
          'an external reaction passes where the member holds the permission');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.messages (conversation_id, user_id, content)
                   VALUES ('77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002',
                           pg_temp.emoji('f1534000-0000-0000-0000-000000000003', 'https://cdn.test/instance.png'))$q$,
                'a DM is exempt');

SELECT tests.clear_authentication();
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1531000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions)
VALUES ('f1530000-0000-0000-0000-0000000000a3', 'role', 'f1531000-0000-0000-0000-000000000001', 524288);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1530000-0000-0000-0000-0000000000a3',
                   pg_temp.emoji('f1534000-0000-0000-0000-000000000003', 'https://cdn.test/instance.png'))$q$,
                'a role''s channel Allow restores USE_EXTERNAL_EMOJIS for messages');
SELECT is(pg_temp.react('f1532000-0000-0000-0000-0000000000e1', '33333333-0000-0000-0000-000000000003', 'f1534000-0000-0000-0000-000000000002', NULL), 1,
          'and reactions');

-- Helpers ----------------------------------------------------------------------------------
SELECT tests.clear_authentication();
SELECT is(public.message_custom_emoji_keys(
              '[{"type":"text","text":"a"},
                {"type":"emoji","emoji":{"id":"F1534000-0000-0000-0000-000000000001","url":"https://cdn.test/local.png"}},
                {"type":"emoji","emoji":{"id":null,"domain":"discord.com","url":"https://cdn.discordapp.com/emojis/900000000000001531.gif"}},
                {"type":"emoji","emoji":{"id":"discord:a:blob:900000000000009999"}},
                {"type":"emoji","emoji":{"id":"remote:x","url":"https://remote.test/x.png"}},
                {"type":"emoji","emoji":{"name":"smile"}}]'),
          ARRAY['discord:900000000000001531', 'discord:900000000000009999',
                'id:f1534000-0000-0000-0000-000000000001|https://cdn.test/local.png', 'url:https://remote.test/x.png'],
          'message_custom_emoji_keys names each custom emoji once');
SELECT ok(public.channel_grants_everyone('66666666-0000-0000-0000-000000000006', 4194304)
          AND NOT public.channel_grants_everyone('f1530000-0000-0000-0000-0000000000a1', 4194304)
          AND NOT public.channel_grants_everyone('66666666-0000-0000-0000-000000000006', 1)
          AND NOT public.channel_grants_everyone(NULL, 4194304),
          'channel_grants_everyone follows @everyone and the channel''s denies');
SELECT tests.authenticate_as_anon();
SELECT is(public.get_message_page('f1530000-0000-0000-0000-0000000000a1', NULL, 50, NULL),
          '{"messages": [], "reactions": [], "history_since": null}'::jsonb, 'anon still reads an empty page');
SELECT tests.clear_authentication();
SELECT ok(NOT has_function_privilege('authenticated', 'public.enforce_message_content_permissions()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.enforce_reaction_external_emoji()', 'EXECUTE'),
          'the trigger functions are not callable');

SELECT * FROM finish();
ROLLBACK;
