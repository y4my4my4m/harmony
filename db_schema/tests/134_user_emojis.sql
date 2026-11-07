-- 20261013100001_user_emojis.sql, as 20261107100001_emoji_lifecycle.sql leaves it: owners
-- rename and remove their user-scope emojis; instance admins list, rename and purge them; the
-- AI generation ledger outlives purges.
--
--   alice    instance admin from setup; owns server_1
--   bob      member of server_1, not an admin
--   mallory  no server, not an admin
--
-- Emojis (134e0000-...-0000000000NN):
--   01 bob_ai_cat     scope user, bob, AI-generated
--   02 bob_plain      scope user, bob
--   03 owl            scope user, mallory, AI-generated
--   04 inst_one       scope instance, local
--   05 srv_one        scope server on server_1, uploaded by bob
--   06 bob_new        scope user, bob (20261016100004: clients insert through create_my_emoji)
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(43);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO public.emojis (id, name, url, server_id, uploader, domain, scope, is_ai_generated, created_at) VALUES
  ('134e0000-0000-0000-0000-000000000001', 'bob_ai_cat', 'https://cdn.test/ai/1.png', NULL,
   '22222222-0000-0000-0000-000000000002', NULL, 'user', true, now() - interval '5 minutes'),
  ('134e0000-0000-0000-0000-000000000002', 'bob_plain', 'https://cdn.test/2.png', NULL,
   '22222222-0000-0000-0000-000000000002', NULL, 'user', false, now() - interval '4 minutes'),
  ('134e0000-0000-0000-0000-000000000003', 'owl', 'https://cdn.test/ai/3.png', NULL,
   '33333333-0000-0000-0000-000000000003', NULL, 'user', true, now() - interval '3 minutes'),
  ('134e0000-0000-0000-0000-000000000004', 'inst_one', 'https://cdn.test/4.png', NULL,
   NULL, NULL, 'instance', false, now() - interval '2 minutes'),
  ('134e0000-0000-0000-0000-000000000005', 'srv_one', 'https://cdn.test/5.png',
   '55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', NULL, 'server', false,
   now() - interval '1 minute'),
  ('134e0000-0000-0000-0000-000000000006', 'bob_new', 'https://cdn.test/new.png', NULL,
   '22222222-0000-0000-0000-000000000002', NULL, 'user', false, now());

CREATE FUNCTION pg_temp.listed(p_search text, p_kind text, p_status text DEFAULT 'active')
RETURNS text[] LANGUAGE sql AS
  $$ SELECT COALESCE(array_agg(name ORDER BY o), '{}')
       FROM (SELECT l.name, row_number() OVER () AS o
               FROM public.admin_list_emojis(p_search, p_kind, p_status, 'newest', 50, 0) l) t $$;

-- Grants, policies, ledger. ---------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.rename_my_emoji(uuid, text)', 'EXECUTE'),
          'authenticated executes rename_my_emoji');
SELECT ok(NOT has_function_privilege('anon', 'public.rename_my_emoji(uuid, text)', 'EXECUTE'),
          'anon does not execute rename_my_emoji');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_list_emojis(text, text, text, text, integer, integer)', 'EXECUTE'),
          'anon does not execute admin_list_emojis');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = 'emojis' AND cmd = 'UPDATE'
                         AND qual LIKE '%''user''%'),
          'no UPDATE policy reaches user-scope emojis');
SELECT ok(NOT has_table_privilege('authenticated', 'public.ai_emoji_generations', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.ai_emoji_generations', 'SELECT'),
          'clients cannot read the generation ledger');
SELECT ok(NOT has_function_privilege('authenticated', 'public.record_ai_emoji_generation()', 'EXECUTE'),
          'clients do not execute the ledger trigger function');
SELECT is((SELECT array_agg(emoji_id ORDER BY emoji_id) FROM public.ai_emoji_generations
            WHERE emoji_id::text LIKE '134e0000-%'),
          ARRAY['134e0000-0000-0000-0000-000000000001', '134e0000-0000-0000-0000-000000000003']::uuid[],
          'inserting an AI emoji records a ledger row; other emojis do not');

-- The owner. --------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');

SELECT lives_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000001', ' cat_renamed ')$q$,
                'the owner renames an AI emoji');
SELECT is((SELECT name::text FROM public.emojis WHERE id = '134e0000-0000-0000-0000-000000000001'),
          'cat_renamed', 'the new name is trimmed and stored');
SELECT is((SELECT (url::text, is_ai_generated, scope, uploader)::text FROM public.emojis
            WHERE id = '134e0000-0000-0000-0000-000000000001'),
          '(https://cdn.test/ai/1.png,t,user,22222222-0000-0000-0000-000000000002)',
          'only the name changes');
SELECT throws_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000002', 'CAT_RENAMED')$q$,
                 '23505', NULL, 'a name the owner already uses is rejected case-insensitively');
SELECT lives_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000002', 'owl')$q$,
                'a name another user holds is accepted');
SELECT lives_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000002', 'inst_one')$q$,
                'a name an instance emoji holds is accepted');
SELECT throws_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000002', 'a')$q$,
                 '22023', NULL, 'a one-character name is rejected');
SELECT throws_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000002', 'bad name:')$q$,
                 '22023', NULL, 'spaces and colons are rejected');
SELECT throws_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000003', 'stolen')$q$,
                 'P0002', NULL, 'another user''s emoji cannot be renamed');
SELECT throws_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000005', 'srv_two')$q$,
                 'P0002', NULL, 'a server emoji the user uploaded is out of reach');
SELECT throws_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000004', 'inst_two')$q$,
                 'P0002', NULL, 'an instance emoji is out of reach');

WITH u AS (UPDATE public.emojis SET url = 'https://evil.test/x.png', server_id = '55555555-0000-0000-0000-000000000005'
            WHERE id = '134e0000-0000-0000-0000-000000000001' RETURNING 1)
SELECT is(count(*)::int, 0, 'the owner cannot rewrite a user-scope row directly') FROM u;
SELECT throws_ok($q$INSERT INTO public.emojis (name, url, server_id, uploader, scope)
                    VALUES ('inject', 'https://evil.test/y.png', '55555555-0000-0000-0000-000000000005',
                            '22222222-0000-0000-0000-000000000002', 'user')$q$,
                 '42501', NULL, 'a user-scope emoji cannot be inserted into a server');
SELECT throws_ok($q$INSERT INTO public.emojis (name, url, server_id, uploader, scope)
                    VALUES ('bob_direct', 'https://evil.test/z.png', NULL,
                            '22222222-0000-0000-0000-000000000002', 'user')$q$,
                 '42501', NULL, 'a personal emoji is not inserted directly');

WITH d AS (DELETE FROM public.emojis WHERE id = '134e0000-0000-0000-0000-000000000003' RETURNING 1)
SELECT is(count(*)::int, 0, 'another user''s emoji cannot be deleted') FROM d;
WITH d AS (DELETE FROM public.emojis WHERE id = '134e0000-0000-0000-0000-000000000002' RETURNING 1)
SELECT is(count(*)::int, 0, 'the owner deletes no row directly') FROM d;
SELECT lives_ok($q$SELECT public.remove_emoji('134e0000-0000-0000-0000-000000000002')$q$,
                'the owner removes a personal emoji');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000001', 'anon_cat')$q$,
                 '42501', NULL, 'anon cannot rename');
SELECT tests.clear_authentication();

-- A non-admin. ------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT * FROM public.admin_list_emojis(NULL, 'personal')$q$,
                 '42501', NULL, 'a non-admin cannot list user emojis');
SELECT throws_ok($q$SELECT public.admin_rename_instance_emoji('134e0000-0000-0000-0000-000000000001', 'x_x')$q$,
                 '42501', NULL, 'a non-admin cannot rename another user''s emoji');
SELECT throws_ok($q$SELECT public.admin_purge_emoji('134e0000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'a non-admin cannot purge another user''s emoji');
SELECT tests.clear_authentication();

-- The instance admin. -----------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT is(pg_temp.listed(NULL, 'personal'), ARRAY['bob_new'],
          'kind personal lists active personal uploads, newest first');
SELECT is(pg_temp.listed(NULL, 'ai'), ARRAY['owl', 'cat_renamed'],
          'kind ai lists AI-generated personal emojis');
SELECT is(pg_temp.listed('MALLO', 'ai'), ARRAY['owl'],
          'the search matches the owner''s username');
SELECT is(pg_temp.listed('mallo', 'instance'), '{}'::text[],
          'kind instance holds no personal emoji');
SELECT is(pg_temp.listed(NULL, 'instance'), ARRAY['inst_one'],
          'kind instance lists instance-level emojis only');
SELECT is((SELECT (uploader_username, is_ai_generated, scope)::text
             FROM public.admin_list_emojis('cat_renamed', 'ai')),
          '(bob,t,user)', 'a user emoji row carries its owner and the AI flag');
SELECT is((SELECT is_ai_generated FROM public.admin_list_emojis('inst_one', 'instance')),
          false, 'instance rows report is_ai_generated false');

SELECT throws_ok($q$SELECT public.admin_rename_instance_emoji('134e0000-0000-0000-0000-000000000001', 'BOB_NEW')$q$,
                 '23505', NULL, 'an admin rename is unique within the owner''s emojis');
SELECT lives_ok($q$SELECT public.admin_rename_instance_emoji('134e0000-0000-0000-0000-000000000001', 'owl')$q$,
                'an admin renames a user emoji to a name another user holds');
SELECT is((SELECT name::text FROM public.emojis WHERE id = '134e0000-0000-0000-0000-000000000001'),
          'owl', 'the admin rename is stored');
SELECT lives_ok($q$SELECT public.admin_rename_instance_emoji('134e0000-0000-0000-0000-000000000004', 'owl')$q$,
                'an instance rename ignores user-scope names');
SELECT lives_ok($q$SELECT public.admin_purge_emoji('134e0000-0000-0000-0000-000000000003')$q$,
                'an admin purges a user''s AI emoji');
SELECT is(pg_temp.listed(NULL, 'personal', 'removed'), ARRAY['inst_one'],
          'the removed personal emoji is listed under status removed');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.emojis WHERE id = '134e0000-0000-0000-0000-000000000003'),
          0, 'the deleted AI emoji is gone');
SELECT is((SELECT profile_id FROM public.ai_emoji_generations WHERE emoji_id = '134e0000-0000-0000-0000-000000000003'),
          '33333333-0000-0000-0000-000000000003'::uuid, 'its ledger row remains and still counts for the owner');

SELECT * FROM finish();
ROLLBACK;
