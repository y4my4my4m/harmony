-- 20261107100001_emoji_lifecycle.sql: remove_emoji (soft), restore_emoji, rename_emoji,
-- admin_purge_emoji (hard, reactions keep :name:), create_server_emoji, import_remote_emoji and
-- rehost_emoji on re-hosted objects, check_content_emoji_parts on messages and posts,
-- usable_emojis, admin_list_emojis and the emoji file delete guard.
--
--   alice     owns server_1
--   bob       member of server_1 without MANAGE_EMOJIS
--   carol236  member of server_1 holding MANAGE_EMOJIS (16)
--   dave236   instance admin
--   mallory   no server
--
-- Emojis (2360e000-0000-0000-0000-0000000000NN), files under https://db.test/storage/v1/object/public/emojis/:
--   01 srv236    server_1                 <server_1>/<alice>/01.png
--   02 bob236    bob's personal           <bob>/02.png
--   03 inst236   instance                 <instance>/03.png
--   04 far236    a server bob is not in   https://cdn.test/far.png
--   05 alice236  alice's personal         <alice>/05.png
--   06 fed236    federated cache          https://remote.test/fed.png, domain remote.test
--   07 hot236    instance, hotlinked      https://remote.test/hot.png
--   08 copy236   a server copy bob is in  https://remote.test/copy.png
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(90);
SELECT set_config('storage.allow_delete_query', 'true', true);
GRANT USAGE ON SCHEMA tests TO service_role;

-- Setup, as postgres. -------------------------------------------------------------------
UPDATE public.server_automod_settings SET enabled = false WHERE server_id = '55555555-0000-0000-0000-000000000005';
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2360000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol236@test.local'),
  ('f2360000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave236@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('f2360000-0000-0000-0000-0000000000c1', 'f2360000-0000-0000-0000-0000000000a1', 'carol236', 'Carol', true, false),
  ('f2360000-0000-0000-0000-0000000000d1', 'f2360000-0000-0000-0000-0000000000a2', 'dave236', 'Dave', true, true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f2360000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2361000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'emojis236', 3, 16);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f2360000-0000-0000-0000-0000000000c1', 'f2361000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2365000-0000-0000-0000-000000000001', 'Far server', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('f2365000-0000-0000-0000-000000000002', 'Remote copy', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2365000-0000-0000-0000-000000000002', 'accepted');

INSERT INTO public.instance_config (config_key, config_value) VALUES ('storage_origin', '"https://db.test"')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

CREATE FUNCTION pg_temp.url(p_path text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'https://db.test/storage/v1/object/public/emojis/' || p_path $$;
CREATE FUNCTION pg_temp.p(p_folder text, p_n text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT p_folder || '/2360f000-0000-4000-8000-0000000000' || p_n || '.png' $$;
CREATE FUNCTION pg_temp.e(p_n text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT ('2360e000-0000-0000-0000-0000000000' || p_n)::uuid $$;

INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'emojis', n, '{"size": 1000, "mimetype": "image/png"}'::jsonb
  FROM unnest(ARRAY[
    pg_temp.p('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001', '01'),
    pg_temp.p('22222222-0000-0000-0000-000000000002', '02'),
    pg_temp.p('00000000-0000-0000-0000-000000000000', '03'),
    pg_temp.p('11111111-0000-0000-0000-000000000001', '05'),
    pg_temp.p('55555555-0000-0000-0000-000000000005/f2360000-0000-0000-0000-0000000000c1', '11'),
    pg_temp.p('55555555-0000-0000-0000-000000000005/f2360000-0000-0000-0000-0000000000c1', '12'),
    pg_temp.p('22222222-0000-0000-0000-000000000002', '13'),
    pg_temp.p('00000000-0000-0000-0000-000000000000', '14'),
    pg_temp.p('00000000-0000-0000-0000-000000000000', '15'),
    pg_temp.p('22222222-0000-0000-0000-000000000002', '16'),
    pg_temp.p('00000000-0000-0000-0000-000000000000', '17'),
    pg_temp.p('00000000-0000-0000-0000-000000000000', '18')]) n;

INSERT INTO public.emojis (id, name, url, server_id, scope, uploader, domain) VALUES
  (pg_temp.e('01'), 'srv236', pg_temp.url(pg_temp.p('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001', '01')),
   '55555555-0000-0000-0000-000000000005', 'server', '11111111-0000-0000-0000-000000000001', NULL),
  (pg_temp.e('02'), 'bob236', pg_temp.url(pg_temp.p('22222222-0000-0000-0000-000000000002', '02')),
   NULL, 'user', '22222222-0000-0000-0000-000000000002', NULL),
  (pg_temp.e('03'), 'inst236', pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '03')),
   NULL, 'instance', 'f2360000-0000-0000-0000-0000000000d1', NULL),
  (pg_temp.e('04'), 'far236', 'https://cdn.test/far.png', 'f2365000-0000-0000-0000-000000000001', 'server', NULL, NULL),
  (pg_temp.e('05'), 'alice236', pg_temp.url(pg_temp.p('11111111-0000-0000-0000-000000000001', '05')),
   NULL, 'user', '11111111-0000-0000-0000-000000000001', NULL),
  (pg_temp.e('06'), 'fed236', 'https://remote.test/fed.png', NULL, 'instance', NULL, 'remote.test'),
  (pg_temp.e('07'), 'hot236', 'https://remote.test/hot.png', NULL, 'instance', NULL, NULL),
  (pg_temp.e('08'), 'copy236', 'https://remote.test/copy.png', 'f2365000-0000-0000-0000-000000000002', 'server', NULL, 'remote.test');

INSERT INTO public.remote_emojis_cache (id, shortcode, origin_domain, full_code, url) VALUES
  ('2360c000-0000-0000-0000-000000000001', 'blob236', 'remote.test', ':blob236@remote.test:', 'https://remote.test/blob.png'),
  ('2360c000-0000-0000-0000-000000000002', 'inst236', 'remote.test', ':inst236@remote.test:', 'https://remote.test/inst.png'),
  ('2360c000-0000-0000-0000-000000000003', 'eyes236@old.test', 'old.test', ':eyes236@old.test:', 'https://old.test/eyes.png'),
  ('2360c000-0000-0000-0000-000000000004', 'left236', 'remote.test', ':left236@remote.test:', 'https://remote.test/left.png');

-- A message and a post reacted with srv236 by bob, for the purge.
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('2360a000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"react here"}]');
INSERT INTO public.reactions (message_id, user_id, emoji_id)
VALUES ('2360a000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', pg_temp.e('01'));
INSERT INTO public.posts (id, author_id, content, visibility, is_local) VALUES
  ('2360b000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"a post"}]', 'public', true);
INSERT INTO public.post_interactions (user_id, post_id, interaction_type, emoji_id, custom_emoji_content)
VALUES ('22222222-0000-0000-0000-000000000002', '2360b000-0000-0000-0000-000000000001', 'emoji_reaction', pg_temp.e('01'), ':srv236:');

CREATE TEMP TABLE r236 (k text PRIMARY KEY, v jsonb);
GRANT ALL ON r236 TO authenticated, service_role;

CREATE FUNCTION pg_temp.as_user(p_auth uuid) RETURNS void LANGUAGE sql AS $$ SELECT tests.authenticate_as(p_auth) $$;
CREATE FUNCTION pg_temp.send(p_content jsonb, p_channel uuid DEFAULT '66666666-0000-0000-0000-000000000006',
                             p_conversation uuid DEFAULT NULL, p_encrypted boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE c jsonb;
BEGIN
  INSERT INTO public.messages (channel_id, conversation_id, user_id, content, encrypted)
  VALUES (CASE WHEN p_conversation IS NULL THEN p_channel END, p_conversation, public.get_current_profile_id(), p_content, p_encrypted)
  RETURNING content INTO c;
  RETURN c;
END $fn$;
CREATE FUNCTION pg_temp.part(p_id text, p_name text, p_url text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS
  $$ SELECT jsonb_build_array(jsonb_build_object('type', 'emoji', 'emoji',
            jsonb_build_object('id', p_id, 'name', p_name, 'url', p_url))) $$;

-- Shape. --------------------------------------------------------------------------------
SELECT has_column('public', 'emojis', 'deleted_at', 'emojis.deleted_at exists');
SELECT has_column('public', 'emojis', 'imported_from', 'emojis.imported_from exists');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conname = 'reactions_emoji_id_fkey'), 'n',
          'reactions.emoji_id is ON DELETE SET NULL');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'emojis' AND cmd <> 'SELECT'), 0,
          'clients hold no insert, update or delete policy on emojis');
SELECT ok(NOT has_function_privilege('anon', 'public.remove_emoji(uuid)', 'EXECUTE'), 'anon does not execute remove_emoji');
SELECT ok(NOT has_function_privilege('authenticated', 'public.import_remote_emoji(uuid, text, text, text, uuid)', 'EXECUTE'),
          'authenticated does not execute import_remote_emoji');
SELECT ok(NOT has_function_privilege('authenticated', 'public.rehost_emoji(uuid, text, text, uuid)', 'EXECUTE'),
          'authenticated does not execute rehost_emoji');
SELECT ok(to_regprocedure('public.admin_delete_instance_emoji(uuid)') IS NULL
          AND to_regprocedure('public.admin_list_instance_emojis(text, text, text, integer, integer)') IS NULL
          AND to_regprocedure('public.import_remote_emoji(uuid, text, uuid)') IS NULL,
          'the superseded admin delete, admin list and hotlinking import are gone');
SELECT matches((SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'a_messages_content_emoji_parts'),
               'new\.encrypted IS NOT TRUE', 'the message parts trigger skips encrypted rows');
SELECT ok('a_messages_content_emoji_parts' < 'a_messages_content_permissions',
          'and runs before the USE_EXTERNAL_EMOJIS check');

-- Removal. ------------------------------------------------------------------------------
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.remove_emoji(pg_temp.e('01'))$q$, '42501', NULL,
                 'a member without MANAGE_EMOJIS cannot remove a server emoji');
WITH d AS (DELETE FROM public.emojis WHERE id = pg_temp.e('02') RETURNING 1)
SELECT is((SELECT count(*)::int FROM d), 0, 'the owner of a personal emoji cannot delete its row directly');
SELECT throws_ok($q$INSERT INTO public.emojis (name, url, scope, uploader)
                    VALUES ('sneak', 'https://tracker.test/x.png', 'user', '22222222-0000-0000-0000-000000000002')$q$,
                 '42501', NULL, 'clients insert no emojis row directly');

SELECT pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.remove_emoji(pg_temp.e('02'))$q$, '42501', NULL,
                 'another user cannot remove a personal emoji');
SELECT throws_ok($q$SELECT public.remove_emoji('2360e000-0000-0000-0000-0000000000ff')$q$, 'P0002', NULL,
                 'an absent emoji is P0002');

SELECT pg_temp.as_user('f2360000-0000-0000-0000-0000000000a1');
SELECT lives_ok($q$SELECT public.remove_emoji(pg_temp.e('01'))$q$, 'a MANAGE_EMOJIS member removes a server emoji');
SELECT tests.clear_authentication();
SELECT results_eq($$SELECT deleted_at IS NOT NULL, deleted_by FROM public.emojis WHERE id = pg_temp.e('01')$$,
                  $$VALUES (true, 'f2360000-0000-0000-0000-0000000000c1'::uuid)$$,
                  'the row stays, marked removed by the remover');
SELECT is((SELECT count(*)::int FROM public.reactions WHERE emoji_id = pg_temp.e('01')), 1, 'its reactions stay');
SELECT ok(EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'emojis'
                   AND name = pg_temp.p('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001', '01')),
          'its file stays');
SELECT ok(EXISTS (SELECT 1 FROM public.server_audit_log WHERE server_id = '55555555-0000-0000-0000-000000000005'
                   AND action = 'emoji.delete' AND target_id = pg_temp.e('01')::text
                   AND actor_id = 'f2360000-0000-0000-0000-0000000000c1'),
          'the server audit log records emoji.delete by the remover');

SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT public.get_emoji_source(pg_temp.e('01'), url) ->> 'kind' FROM public.emojis WHERE id = pg_temp.e('01')),
          'removed', 'get_emoji_source says removed');
SELECT is((SELECT count(*)::int FROM public.usable_emojis(ARRAY['srv236'])), 0, 'usable_emojis leaves the removed emoji out');
SELECT lives_ok($q$SELECT public.remove_emoji(pg_temp.e('02'))$q$, 'an owner removes a personal emoji');
SELECT is((SELECT name FROM public.create_my_emoji('bob236', pg_temp.p('22222222-0000-0000-0000-000000000002', '13'),
                                                   pg_temp.url(pg_temp.p('22222222-0000-0000-0000-000000000002', '13')))),
          'bob236', 'a removed personal emoji frees its name');

SELECT pg_temp.as_user('f2360000-0000-0000-0000-0000000000a1');
SELECT is((SELECT name FROM public.create_server_emoji('55555555-0000-0000-0000-000000000005', 'srv236',
             pg_temp.p('55555555-0000-0000-0000-000000000005/f2360000-0000-0000-0000-0000000000c1', '11'),
             pg_temp.url(pg_temp.p('55555555-0000-0000-0000-000000000005/f2360000-0000-0000-0000-0000000000c1', '11')))),
          'srv236', 'a removed server emoji frees its name');
SELECT throws_ok($q$SELECT public.restore_emoji(pg_temp.e('01'))$q$, '23505', NULL,
                 'a removed emoji whose name is taken again is not restored');
SELECT lives_ok($q$SELECT public.rename_emoji(pg_temp.e('01'), 'srv236_old')$q$, 'a manager renames the removed emoji');
SELECT lives_ok($q$SELECT public.restore_emoji(pg_temp.e('01'))$q$, 'and restores it under the free name');
SELECT is((SELECT deleted_at FROM public.emojis WHERE id = pg_temp.e('01')), NULL, 'restored rows are active');
SELECT throws_ok($q$SELECT public.rename_emoji(pg_temp.e('01'), 'srv236')$q$, '23505', NULL,
                 'rename refuses a name an active server emoji holds');
SELECT throws_ok($q$SELECT public.rename_emoji(pg_temp.e('01'), 'bad name')$q$, '22023', NULL, 'rename refuses a malformed name');
SELECT lives_ok($q$SELECT public.remove_emoji(pg_temp.e('01'))$q$, 'removed again for the purge below');

-- create_server_emoji. ------------------------------------------------------------------
SELECT throws_ok($q$SELECT public.create_server_emoji('55555555-0000-0000-0000-000000000005', 'x',
                    pg_temp.p('55555555-0000-0000-0000-000000000005/f2360000-0000-0000-0000-0000000000c1', '12'),
                    'https://tracker.test/storage/v1/object/public/emojis/x.png')$q$,
                 '22023', NULL, 'create_server_emoji refuses a url that is not the object''s public URL');
SELECT throws_ok($q$SELECT public.create_server_emoji('55555555-0000-0000-0000-000000000005', 'x',
                    pg_temp.p('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001', '01'),
                    pg_temp.url(pg_temp.p('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001', '01')))$q$,
                 '22023', NULL, 'and a file in another uploader''s folder');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'max_custom_emojis_per_server';
SELECT pg_temp.as_user('f2360000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$SELECT public.create_server_emoji('55555555-0000-0000-0000-000000000005', 'x',
                    pg_temp.p('55555555-0000-0000-0000-000000000005/f2360000-0000-0000-0000-0000000000c1', '12'),
                    pg_temp.url(pg_temp.p('55555555-0000-0000-0000-000000000005/f2360000-0000-0000-0000-0000000000c1', '12')))$q$,
                 '23514', NULL, 'max_custom_emojis_per_server counts active emojis only and caps uploads');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '0'::jsonb WHERE config_key = 'max_custom_emojis_per_server';
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_server_emoji('55555555-0000-0000-0000-000000000005', 'x',
                    pg_temp.p('55555555-0000-0000-0000-000000000005/22222222-0000-0000-0000-000000000002', '12'),
                    pg_temp.url(pg_temp.p('55555555-0000-0000-0000-000000000005/22222222-0000-0000-0000-000000000002', '12')))$q$,
                 '42501', NULL, 'a member without MANAGE_EMOJIS uploads no server emoji');

-- Emoji parts in messages. --------------------------------------------------------------
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('03')::text, 'inst236', 'https://tracker.test/x.png')) -> 0 -> 'emoji',
          jsonb_build_object('id', pg_temp.e('03')::text, 'name', 'inst236',
                             'url', pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '03'))),
          'a part naming an instance emoji is rewritten to the row: a forged url is replaced');
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('02')::text, 'mine', 'https://x.test/a.png') || pg_temp.part(pg_temp.e('16')::text, 'x', NULL)) -> 0,
          '{"type": "text", "text": ":mine:"}'::jsonb, 'the sender''s own removed personal emoji becomes text');
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('05')::text, 'alice236', 'https://x.test/a.png')) -> 0,
          '{"type": "text", "text": ":alice236:"}'::jsonb, 'another user''s personal emoji becomes text');
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('04')::text, 'far236', 'https://cdn.test/far.png')) -> 0,
          '{"type": "text", "text": ":far236:"}'::jsonb, 'an emoji of a server the sender is not in becomes text');
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('01')::text, 'srv236', 'https://x.test/a.png')) -> 0,
          '{"type": "text", "text": ":srv236:"}'::jsonb, 'a removed server emoji becomes text');
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('06')::text, 'fed236', 'https://remote.test/fed.png')) -> 0,
          '{"type": "text", "text": ":fed236:"}'::jsonb, 'a federated cache emoji becomes text');
SELECT is(pg_temp.send(pg_temp.part('2360e000-0000-0000-0000-0000000000ff', 'ghost', 'https://tracker.test/g.png')) -> 0,
          '{"type": "text", "text": ":ghost:"}'::jsonb, 'an unknown uuid becomes text');
SELECT is(pg_temp.send(jsonb_build_array(jsonb_build_object('type', 'emoji', 'emoji',
            jsonb_build_object('name', 'track', 'url', 'https://tracker.test/t.png')))) -> 0,
          '{"type": "text", "text": ":track:"}'::jsonb, 'a url-only part becomes text');
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('08')::text, 'copy236', 'https://x.test/a.png')) -> 0 -> 'emoji' ->> 'url',
          'https://remote.test/copy.png', 'an emoji of a server copy the sender is in is kept, from the row');
SELECT is(pg_temp.send(jsonb_build_array(jsonb_build_object('type', 'emoji', 'emoji',
            jsonb_build_object('id', NULL, 'name', 'pepe', 'url', 'https://cdn.discordapp.com/emojis/123456789012345678.gif',
                               'domain', 'discord.com', 'server_id', NULL)))) -> 0 -> 'emoji' ->> 'url',
          'https://cdn.discordapp.com/emojis/123456789012345678.gif', 'a Discord emoji part is kept');
SELECT is(pg_temp.send(jsonb_build_array(jsonb_build_object('type', 'emoji', 'emoji',
            jsonb_build_object('id', NULL, 'name', 'pepe', 'url', 'https://tracker.test/emojis/123456789012345678.gif',
                               'domain', 'discord.com')))) -> 0,
          '{"type": "text", "text": ":pepe:"}'::jsonb, 'a part claiming discord.com off Discord''s CDN becomes text');
SELECT throws_ok($q$SELECT pg_temp.send('[{"type":"emoji","emoji":"blob"}]')$q$, '22023', NULL,
                 'an emoji that is not an object is refused');
SELECT throws_ok($q$SELECT pg_temp.send(pg_temp.part(NULL, 'two words', 'https://x.test/a.png'))$q$, '22023', NULL,
                 'a name with whitespace is refused');
SELECT throws_ok($q$SELECT pg_temp.send(pg_temp.part(NULL, 'x', 'javascript:alert(1)'))$q$, '22023', NULL,
                 'a url that is not http(s) is refused');
SELECT throws_ok($q$SELECT pg_temp.send(pg_temp.part(NULL, 'x', 'https://x.test/' || repeat('a', 2048)))$q$, '22023', NULL,
                 'a url over 2048 characters is refused');
SELECT throws_ok($q$SELECT pg_temp.send('[{"type":"emoji","emoji":{"id":7,"name":"x","url":"https://x.test/a.png"}}]')$q$,
                 '22023', NULL, 'a numeric id is refused');
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('05')::text, 'alice236', 'https://x.test/a.png'),
                       NULL, '77777777-0000-0000-0000-000000000007', true) -> 0 -> 'emoji' ->> 'url',
          'https://x.test/a.png', 'an encrypted message is not checked');

-- Cross-server use: server_1 keeps its emojis to itself.
SELECT tests.clear_authentication();
UPDATE public.servers SET allow_cross_server_emojis = false WHERE id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.emojis (id, name, url, server_id, scope)
VALUES (pg_temp.e('09'), 'home236', 'https://cdn.test/home.png', '55555555-0000-0000-0000-000000000005', 'server');
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('09')::text, 'home236', 'https://cdn.test/home.png')) -> 0 -> 'emoji' ->> 'id',
          pg_temp.e('09')::text, 'a server emoji is kept in its own server');
SELECT is(pg_temp.send(pg_temp.part(pg_temp.e('09')::text, 'home236', 'https://cdn.test/home.png'),
                       NULL, '77777777-0000-0000-0000-000000000007') -> 0,
          '{"type": "text", "text": ":home236:"}'::jsonb,
          'outside it, allow_cross_server_emojis false turns it into text');

-- Edits keep old parts.
WITH i AS (
  INSERT INTO public.messages (channel_id, user_id, content)
  VALUES ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
          pg_temp.part(pg_temp.e('03')::text, 'inst236', pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '03'))))
  RETURNING id)
INSERT INTO r236 SELECT 'm', to_jsonb(id) FROM i;
SELECT tests.clear_authentication();
UPDATE public.emojis SET deleted_at = now() WHERE id = pg_temp.e('03');
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.messages SET content = content || '[{"type":"text","text":" edited"}]'::jsonb
 WHERE id = (SELECT (v #>> '{}')::uuid FROM r236 WHERE k = 'm');
SELECT is((SELECT content -> 0 -> 'emoji' ->> 'id' FROM public.messages WHERE id = (SELECT (v #>> '{}')::uuid FROM r236 WHERE k = 'm')),
          pg_temp.e('03')::text, 'an edit keeps a part already in the message whose emoji was removed since');
UPDATE public.messages SET content = content || pg_temp.part(pg_temp.e('03')::text, 'inst236',
                                                             pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '03'))) || '[{"type":"text","text":"x"}]'::jsonb
 WHERE id = (SELECT (v #>> '{}')::uuid FROM r236 WHERE k = 'm');
SELECT is((SELECT content -> 1 FROM public.messages WHERE id = (SELECT (v #>> '{}')::uuid FROM r236 WHERE k = 'm')),
          '{"type": "text", "text": " edited"}'::jsonb, 'the old parts stay in place');
SELECT is((SELECT jsonb_array_length(content) FROM public.messages WHERE id = (SELECT (v #>> '{}')::uuid FROM r236 WHERE k = 'm')),
          4, 'and the edit''s new parts are appended');
SELECT tests.clear_authentication();
UPDATE public.emojis SET deleted_at = NULL WHERE id = pg_temp.e('03');

-- The service role (federation, bots) is not checked.
SET LOCAL ROLE service_role;
WITH i AS (
  INSERT INTO public.messages (channel_id, user_id, content)
  VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
          pg_temp.part('remote:blob', 'blob', 'https://remote.test/blob.png'))
  RETURNING content)
INSERT INTO r236 SELECT 'service', content FROM i;
SELECT is((SELECT v FROM r236 WHERE k = 'service') -> 0 -> 'emoji' ->> 'id',
          'remote:blob', 'a service_role insert keeps a remote: part');
RESET ROLE;

-- Emoji parts in posts. -----------------------------------------------------------------
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
WITH i AS (
  INSERT INTO public.posts (author_id, content, visibility, is_local)
  VALUES ('22222222-0000-0000-0000-000000000002',
          pg_temp.part(pg_temp.e('05')::text, 'alice236', 'https://tracker.test/a.png')
          || pg_temp.part(pg_temp.e('03')::text, 'inst236', 'https://tracker.test/b.png'), 'public', true)
  RETURNING content)
INSERT INTO r236 SELECT 'post', content FROM i;
SELECT is((SELECT v FROM r236 WHERE k = 'post'),
          jsonb_build_array('{"type": "text", "text": ":alice236:"}'::jsonb,
                            jsonb_build_object('type', 'emoji', 'emoji', jsonb_build_object(
                                'id', pg_temp.e('03')::text, 'name', 'inst236',
                                'url', pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '03'))))),
          'a post''s parts are checked the same way');
SELECT throws_ok($q$INSERT INTO public.posts (author_id, content, visibility, is_local)
                    VALUES ('22222222-0000-0000-0000-000000000002', '[{"type":"emoji","emoji":[1]}]', 'public', true)$q$,
                 '22023', NULL, 'a malformed post part is refused');
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
INSERT INTO public.posts (id, author_id, content, visibility, is_local) VALUES
  ('2360b000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   pg_temp.part('remote:blob', 'blob', 'https://remote.test/blob.png'), 'public', true);
RESET ROLE;
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
WITH i AS (
  INSERT INTO public.posts (author_id, content, visibility, is_local, metadata)
  VALUES ('22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"x"}]', 'public', true,
          '{"reblog_of": "2360b000-0000-0000-0000-000000000002"}')
  RETURNING content)
INSERT INTO r236 SELECT 'boost', content FROM i;
SELECT is((SELECT v FROM r236 WHERE k = 'boost') -> 0 -> 'emoji' ->> 'id',
          'remote:blob', 'a boost carries the original''s parts unchecked');

-- usable_emojis. ------------------------------------------------------------------------
SELECT set_eq($$SELECT id FROM public.usable_emojis(ARRAY['inst236', 'alice236', 'far236', 'fed236', 'copy236', 'bob236'])$$,
              $$SELECT id FROM public.emojis WHERE name IN ('inst236', 'copy236', 'bob236') AND deleted_at IS NULL$$,
              'usable_emojis answers the instance, server-copy and own personal emoji only');

-- Purge. --------------------------------------------------------------------------------
SELECT pg_temp.as_user('f2360000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$SELECT public.admin_purge_emoji(pg_temp.e('01'))$q$, '42501', NULL, 'a server manager cannot purge');
SELECT pg_temp.as_user('f2360000-0000-0000-0000-0000000000a2');
SELECT is(public.admin_purge_emoji(pg_temp.e('01')),
          pg_temp.p('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001', '01'),
          'an admin purges and gets the object path back');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM public.emojis WHERE id = pg_temp.e('01')), 'the row is gone');
SELECT results_eq($$SELECT emoji_id, custom_emoji_content, metadata ->> 'emoji_removed'
                      FROM public.reactions WHERE message_id = '2360a000-0000-0000-0000-000000000001'$$,
                  $$VALUES (NULL::uuid, ':srv236_old:', 'true')$$,
                  'the reaction stays with :name: and the removed mark');
SELECT results_eq($$SELECT emoji_id, custom_emoji_content, metadata ->> 'remote_emoji_url'
                      FROM public.post_interactions WHERE post_id = '2360b000-0000-0000-0000-000000000001'
                       AND interaction_type = 'emoji_reaction'$$,
                  $$VALUES (NULL::uuid, ':srv236:',
                            pg_temp.url(pg_temp.p('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001', '01')))$$,
                  'the post reaction stays and keeps the purged url for its broken-image chip');
SELECT ok(EXISTS (SELECT 1 FROM public.admin_audit_log WHERE action_type = 'emoji_purge'
                   AND target_id = pg_temp.e('01')::text AND admin_id = 'f2360000-0000-0000-0000-0000000000d1'),
          'the purge is in the admin audit log');

-- Storage guard. ------------------------------------------------------------------------
SELECT pg_temp.as_user('f2360000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$DELETE FROM storage.objects WHERE bucket_id = 'emojis'
                    AND name = pg_temp.p('55555555-0000-0000-0000-000000000005/f2360000-0000-0000-0000-0000000000c1', '11')$q$,
                 '42501', NULL, 'a manager cannot delete the file of an emoji');
SELECT lives_ok($q$DELETE FROM storage.objects WHERE bucket_id = 'emojis'
                   AND name = pg_temp.p('55555555-0000-0000-0000-000000000005/f2360000-0000-0000-0000-0000000000c1', '12')$q$,
                'an upload no emoji names is deleted (a refused record''s cleanup)');
SELECT pg_temp.as_user('f2360000-0000-0000-0000-0000000000a2');
SELECT lives_ok($q$DELETE FROM storage.objects WHERE bucket_id = 'emojis'
                   AND name = pg_temp.p('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001', '01')$q$,
                'an admin removes the purged file');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'emojis'
                       AND name = pg_temp.p('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001', '01')),
          'the purged file is gone');

-- Imports and re-hosting. ---------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT throws_ok($q$SELECT public.import_remote_emoji('2360c000-0000-0000-0000-000000000001', NULL,
                    pg_temp.p('00000000-0000-0000-0000-000000000000', '14'), 'https://remote.test/blob.png',
                    'f2360000-0000-0000-0000-0000000000d1')$q$,
                 '22023', NULL, 'import_remote_emoji refuses the remote url');
SELECT is((SELECT row(name, url, imported_from, scope)::text FROM public.import_remote_emoji(
             '2360c000-0000-0000-0000-000000000001', NULL, pg_temp.p('00000000-0000-0000-0000-000000000000', '14'),
             pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '14')), 'f2360000-0000-0000-0000-0000000000d1')),
          row('blob236', pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '14')),
              'https://remote.test/blob.png', 'instance')::text,
          'an import records the re-hosted file and where it came from');
SELECT ok((SELECT imported_as IS NOT NULL FROM public.remote_emojis_cache WHERE id = '2360c000-0000-0000-0000-000000000001'),
          'the cache row points at the import');
SELECT throws_ok($q$SELECT public.import_remote_emoji('2360c000-0000-0000-0000-000000000002', 'INST236',
                    pg_temp.p('00000000-0000-0000-0000-000000000000', '15'),
                    pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '15')), NULL)$q$,
                 '23505', NULL, 'an import named after an active instance emoji is refused');
SELECT is((SELECT name FROM public.import_remote_emoji('2360c000-0000-0000-0000-000000000002', NULL,
             pg_temp.p('00000000-0000-0000-0000-000000000000', '17'),
             pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '17')), NULL)),
          'inst236_1', 'an import keeping its shortcode takes _1 when an instance emoji holds it');
SELECT is((SELECT name FROM public.import_remote_emoji('2360c000-0000-0000-0000-000000000003', NULL,
             pg_temp.p('00000000-0000-0000-0000-000000000000', '18'),
             pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '18')), NULL)),
          'eyes236', 'a shortcode qualified with @host imports under its name alone');
SELECT is((SELECT row(url, imported_from)::text FROM public.rehost_emoji(
             pg_temp.e('07'), pg_temp.p('00000000-0000-0000-0000-000000000000', '15'),
             pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '15')), 'f2360000-0000-0000-0000-0000000000d1')),
          row(pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '15')), 'https://remote.test/hot.png')::text,
          'rehost_emoji moves a hotlinked instance emoji onto the re-hosted file');
SELECT throws_ok($q$SELECT public.rehost_emoji(pg_temp.e('07'), pg_temp.p('00000000-0000-0000-0000-000000000000', '15'),
                    pg_temp.url(pg_temp.p('00000000-0000-0000-0000-000000000000', '15')), NULL)$q$,
                 '23505', NULL, 'an emoji hosted here is not re-hosted');
SELECT throws_ok($q$SELECT * FROM public.create_federated_emoji('botmoji', 'https://tracker.test/b.png', NULL, NULL)$q$,
                 '22023', NULL, 'create_federated_emoji refuses an emoji without a domain');
RESET ROLE;
SELECT pg_temp.as_user('f2360000-0000-0000-0000-0000000000a2');
SELECT throws_ok($q$SELECT public.import_remote_emoji('2360c000-0000-0000-0000-000000000002', NULL, NULL, NULL, NULL)$q$,
                 '42501', NULL, 'an admin session does not call import_remote_emoji directly');

-- admin_list_emojis. --------------------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.emojis (id, name, url, scope) VALUES (pg_temp.e('10'), 'hot236b', 'https://remote.test/hot2.png', 'instance');
SELECT pg_temp.as_user('f2360000-0000-0000-0000-0000000000a2');
SELECT is((SELECT kind || '|' || server_name FROM public.admin_list_emojis('home236')), 'server|Test Server',
          'server emoji are listed with their server');
SELECT results_eq($$SELECT kind, hotlinked FROM public.admin_list_emojis('236', 'all', 'active', 'name') WHERE name IN ('blob236', 'hot236', 'hot236b', 'fed236', 'bob236')$$,
                  $$VALUES ('imported', false), ('personal', false), ('federated', false), ('imported', false), ('instance', true)$$,
                  'kinds: imported, personal, federated; only an instance emoji off-instance is hotlinked');
SELECT is((SELECT array_agg(name ORDER BY name) FROM public.admin_list_emojis('236', 'personal', 'removed')),
          ARRAY['bob236'], 'removed personal emojis are listed under status removed');
SELECT is((SELECT deleted_by_username FROM public.admin_list_emojis('bob236', 'personal', 'removed')), 'bob',
          'with who removed them');
SELECT is((SELECT array_agg(name) FROM public.admin_list_emojis('236', 'not_imported')), ARRAY['left236'],
          'not_imported lists remote cache rows not imported');
SELECT throws_ok($q$SELECT * FROM public.admin_list_emojis(NULL, 'servers')$q$, '22023', NULL, 'an unknown kind is refused');
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.admin_list_emojis()$q$, '42501', NULL, 'admin_list_emojis is for admins');

SELECT * FROM finish();
ROLLBACK;
