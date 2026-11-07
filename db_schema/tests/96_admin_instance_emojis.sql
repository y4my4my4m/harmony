-- 20261009300001_admin_instance_emojis.sql, as 20261107100001_emoji_lifecycle.sql leaves it:
-- instance admins list every emoji (admin_list_emojis), rename instance-level ones, remove and
-- purge any. User emojis: 134_user_emojis.sql; lifecycle details: 236_emoji_lifecycle.sql.
--
--   alice    instance admin from setup; owns server_1
--   bob      member of server_1, not an admin
--
-- Emojis (96e00000-...-0000000000NN):
--   01 inst_local    scope instance, local
--   02 inst_bridge   scope instance, domain discord.com
--   03 fed_orphan    scope server, server_id NULL, domain remote.example (federation insert)
--   04 srv_emoji     scope server on server_1
--   05 usr_emoji     scope user, uploaded by bob
--   06 inst_twin     scope instance, local; rename collision target
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(36);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO public.emojis (id, name, url, server_id, uploader, domain, scope, created_at) VALUES
  ('96e00000-0000-0000-0000-000000000001', 'inst_local',  'https://cdn.test/1.png', NULL,
   '11111111-0000-0000-0000-000000000001', NULL, 'instance', now() - interval '5 minutes'),
  ('96e00000-0000-0000-0000-000000000002', 'inst_bridge', 'https://cdn.test/2.png', NULL,
   NULL, 'discord.com', 'instance', now() - interval '4 minutes'),
  ('96e00000-0000-0000-0000-000000000003', 'fed_orphan',  'https://remote.example/3.png', NULL,
   '22222222-0000-0000-0000-000000000002', 'remote.example', 'server', now() - interval '3 minutes'),
  ('96e00000-0000-0000-0000-000000000004', 'srv_emoji',   'https://cdn.test/4.png',
   '55555555-0000-0000-0000-000000000005', NULL, NULL, 'server', now() - interval '2 minutes'),
  ('96e00000-0000-0000-0000-000000000005', 'usr_emoji',   'https://cdn.test/5.png', NULL,
   '22222222-0000-0000-0000-000000000002', NULL, 'user', now() - interval '1 minute'),
  ('96e00000-0000-0000-0000-000000000006', 'inst_twin',   'https://cdn.test/6.png', NULL,
   NULL, NULL, 'instance', now() - interval '30 seconds');

INSERT INTO public.reactions (message_id, user_id, emoji_id, channel_id)
VALUES ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002',
        '96e00000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006');

INSERT INTO public.remote_emojis_cache (id, shortcode, origin_domain, full_code, url, imported_as, imported_at)
VALUES ('96e10000-0000-0000-0000-000000000001', 'fed_orphan', 'remote.example',
        ':fed_orphan@remote.example:', 'https://remote.example/3.png',
        '96e00000-0000-0000-0000-000000000003', now());

CREATE FUNCTION pg_temp.listed(p_search text, p_kind text, p_sort text, p_limit int, p_offset int,
                                p_status text DEFAULT 'active')
RETURNS text[] LANGUAGE sql AS
  $$ SELECT COALESCE(array_agg(name ORDER BY o), '{}')
       FROM (SELECT l.name, row_number() OVER () AS o
               FROM public.admin_list_emojis(p_search, p_kind, p_status, p_sort, p_limit, p_offset) l) t $$;

-- Grants. ----------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.admin_list_emojis(text, text, text, text, integer, integer)', 'EXECUTE'),
          'authenticated executes admin_list_emojis');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_list_emojis(text, text, text, text, integer, integer)', 'EXECUTE'),
          'anon does not execute admin_list_emojis');
SELECT ok(has_function_privilege('authenticated', 'public.admin_rename_instance_emoji(uuid, text)', 'EXECUTE'),
          'authenticated executes admin_rename_instance_emoji');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_rename_instance_emoji(uuid, text)', 'EXECUTE'),
          'anon does not execute admin_rename_instance_emoji');
SELECT ok(has_function_privilege('authenticated', 'public.admin_purge_emoji(uuid)', 'EXECUTE'),
          'authenticated executes admin_purge_emoji');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_purge_emoji(uuid)', 'EXECUTE'),
          'anon does not execute admin_purge_emoji');

-- Non-admin. -------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.admin_list_emojis()$q$, '42501', NULL,
                 'a non-admin cannot list emojis');
SELECT throws_ok($q$SELECT public.admin_rename_instance_emoji('96e00000-0000-0000-0000-000000000001', 'hijack')$q$,
                 '42501', NULL, 'a non-admin cannot rename an instance emoji');
SELECT throws_ok($q$SELECT public.admin_purge_emoji('96e00000-0000-0000-0000-000000000003')$q$,
                 '42501', NULL, 'a non-admin cannot purge a federated emoji');
SELECT throws_ok($q$SELECT public.remove_emoji('96e00000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'nor remove an instance emoji');
RESET ROLE;
SELECT tests.clear_authentication();

-- Listing as the admin. --------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT is(pg_temp.listed(NULL, 'all', 'newest', 50, 0),
          ARRAY['inst_twin', 'usr_emoji', 'srv_emoji', 'fed_orphan', 'inst_bridge', 'inst_local'],
          'every emoji, newest first, server and personal ones included');
SELECT is(pg_temp.listed(NULL, 'all', 'name', 50, 0),
          ARRAY['fed_orphan', 'inst_bridge', 'inst_local', 'inst_twin', 'srv_emoji', 'usr_emoji'],
          'name sort orders by lower(name)');
SELECT is(pg_temp.listed(NULL, 'instance', 'newest', 50, 0), ARRAY['inst_twin', 'inst_local'],
          'instance is this instance''s own: no server, not personal, no domain');
SELECT is(pg_temp.listed(NULL, 'federated', 'newest', 50, 0), ARRAY['fed_orphan', 'inst_bridge'],
          'federated is a domain without a server');
SELECT is((SELECT kind || '|' || server_name FROM public.admin_list_emojis(NULL, 'server')), 'server|Test Server',
          'server emojis are listed with their server');
SELECT is(pg_temp.listed(NULL, 'personal', 'newest', 50, 0), ARRAY['usr_emoji'], 'personal is scope user');
SELECT is(pg_temp.listed('DISCORD', 'all', 'newest', 50, 0), ARRAY['inst_bridge'],
          'search matches the domain case-insensitively');
SELECT is(pg_temp.listed('_LOC', 'all', 'newest', 50, 0), ARRAY['inst_local'],
          'search matches a name substring case-insensitively');
SELECT is(pg_temp.listed('%', 'all', 'newest', 50, 0), '{}'::text[],
          'search treats % literally');
SELECT is(pg_temp.listed(NULL, 'all', 'newest', 2, 1), ARRAY['usr_emoji', 'srv_emoji'],
          'limit and offset page the result');
SELECT is((SELECT DISTINCT total_count FROM public.admin_list_emojis(NULL, 'all', 'active', 'newest', 2, 1)),
          6::bigint, 'total_count is the match count before paging');
SELECT is((SELECT reaction_count FROM public.admin_list_emojis('fed_orphan')),
          1::bigint, 'reaction_count counts referencing reactions');
SELECT is((SELECT uploader_username FROM public.admin_list_emojis('fed_orphan')),
          'bob', 'uploader_username joins the uploader profile');
SELECT throws_ok($q$SELECT * FROM public.admin_list_emojis(NULL, 'servers')$q$, '22023', NULL,
                 'an unknown kind is rejected');

-- Rename. ----------------------------------------------------------------------------
SELECT lives_ok($q$SELECT public.admin_rename_instance_emoji('96e00000-0000-0000-0000-000000000003', ' fed_renamed ')$q$,
                'the admin renames a federated orphan emoji');
SELECT is((SELECT name::text FROM public.emojis WHERE id = '96e00000-0000-0000-0000-000000000003'),
          'fed_renamed', 'the rename is trimmed and stored');
SELECT throws_ok($q$SELECT public.admin_rename_instance_emoji('96e00000-0000-0000-0000-000000000001', 'INST_TWIN')$q$,
                 '23505', NULL, 'a local instance name collision is rejected case-insensitively');
SELECT lives_ok($q$SELECT public.admin_rename_instance_emoji('96e00000-0000-0000-0000-000000000002', 'inst_twin')$q$,
                'the same name on another domain is accepted');
SELECT throws_ok($q$SELECT public.admin_rename_instance_emoji('96e00000-0000-0000-0000-000000000001', 'bad name:')$q$,
                 '22023', NULL, 'an invalid name is rejected');
SELECT throws_ok($q$SELECT public.admin_rename_instance_emoji('96e00000-0000-0000-0000-000000000004', 'srv_new')$q$,
                 'P0002', NULL, 'a server emoji is out of reach');
SELECT lives_ok($q$SELECT public.admin_rename_instance_emoji('96e00000-0000-0000-0000-000000000005', 'inst_local')$q$,
                'a user emoji rename ignores instance names');

-- Remove and purge. --------------------------------------------------------------------
SELECT lives_ok($q$SELECT public.remove_emoji('96e00000-0000-0000-0000-000000000004')$q$,
                'the admin removes a server emoji');
SELECT is(pg_temp.listed(NULL, 'all', 'newest', 50, 0, 'removed'), ARRAY['srv_emoji'],
          'it is listed under status removed');
SELECT is(public.admin_purge_emoji('96e00000-0000-0000-0000-000000000003'), NULL,
          'the admin purges a federated emoji; its file is not in this instance''s bucket');
RESET ROLE;
SELECT tests.clear_authentication();

SELECT results_eq($$SELECT emoji_id, custom_emoji_content FROM public.reactions
                     WHERE message_id = '88888888-0000-0000-0000-000000000008'$$,
                  $$VALUES (NULL::uuid, ':fed_renamed:')$$,
                  'reactions on the purged emoji stay with its :name:');
SELECT is((SELECT imported_as FROM public.remote_emojis_cache WHERE id = '96e10000-0000-0000-0000-000000000001'),
          NULL::uuid, 'the remote cache entry is importable again');

SELECT * FROM finish();
ROLLBACK;
