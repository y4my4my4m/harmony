-- 20261013100001_user_emojis.sql: owners rename and delete their user-scope emojis; instance
-- admins list, rename and delete them; the AI generation ledger outlives deletions.
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
SELECT plan(41);

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

CREATE FUNCTION pg_temp.listed(p_search text, p_source text)
RETURNS text[] LANGUAGE sql AS
  $$ SELECT COALESCE(array_agg(name ORDER BY o), '{}')
       FROM public.admin_list_instance_emojis(p_search, p_source, 'newest', 50, 0)
            WITH ORDINALITY t(id, name, url, domain, scope, uploader, uploader_username,
                              created_at, usage_count, reaction_count, total_count,
                              is_ai_generated, o) $$;

-- Grants, policies, ledger. ---------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.rename_my_emoji(uuid, text)', 'EXECUTE'),
          'authenticated executes rename_my_emoji');
SELECT ok(NOT has_function_privilege('anon', 'public.rename_my_emoji(uuid, text)', 'EXECUTE'),
          'anon does not execute rename_my_emoji');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_list_instance_emojis(text, text, text, integer, integer)', 'EXECUTE'),
          'anon does not execute admin_list_instance_emojis');
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
SELECT is(count(*)::int, 1, 'the owner deletes a personal emoji') FROM d;
SELECT tests.clear_authentication();

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.rename_my_emoji('134e0000-0000-0000-0000-000000000001', 'anon_cat')$q$,
                 '42501', NULL, 'anon cannot rename');
SELECT tests.clear_authentication();

-- A non-admin. ------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT * FROM public.admin_list_instance_emojis(NULL, 'user')$q$,
                 '42501', NULL, 'a non-admin cannot list user emojis');
SELECT throws_ok($q$SELECT public.admin_rename_instance_emoji('134e0000-0000-0000-0000-000000000001', 'x_x')$q$,
                 '42501', NULL, 'a non-admin cannot rename another user''s emoji');
SELECT throws_ok($q$SELECT public.admin_delete_instance_emoji('134e0000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'a non-admin cannot delete another user''s emoji');
SELECT tests.clear_authentication();

-- The instance admin. -----------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT is(pg_temp.listed(NULL, 'user'), ARRAY['bob_new', 'owl', 'cat_renamed'],
          'source user lists user-scope emojis only, newest first');
SELECT is(pg_temp.listed('MALLO', 'user'), ARRAY['owl'],
          'source user searches the owner''s username');
SELECT is(pg_temp.listed('mallo', 'all'), '{}'::text[],
          'other sources do not search usernames');
SELECT is(pg_temp.listed(NULL, 'all'), ARRAY['inst_one'],
          'source all still lists instance-level emojis only');
SELECT is((SELECT (uploader_username, is_ai_generated, scope)::text
             FROM public.admin_list_instance_emojis('cat_renamed', 'user')),
          '(bob,t,user)', 'a user emoji row carries its owner and the AI flag');
SELECT is((SELECT is_ai_generated FROM public.admin_list_instance_emojis('inst_one', 'all')),
          false, 'instance rows report is_ai_generated false');

SELECT throws_ok($q$SELECT public.admin_rename_instance_emoji('134e0000-0000-0000-0000-000000000001', 'BOB_NEW')$q$,
                 '23505', NULL, 'an admin rename is unique within the owner''s emojis');
SELECT lives_ok($q$SELECT public.admin_rename_instance_emoji('134e0000-0000-0000-0000-000000000001', 'owl')$q$,
                'an admin renames a user emoji to a name another user holds');
SELECT is((SELECT name::text FROM public.emojis WHERE id = '134e0000-0000-0000-0000-000000000001'),
          'owl', 'the admin rename is stored');
SELECT lives_ok($q$SELECT public.admin_rename_instance_emoji('134e0000-0000-0000-0000-000000000004', 'owl')$q$,
                'an instance rename ignores user-scope names');
SELECT lives_ok($q$SELECT public.admin_delete_instance_emoji('134e0000-0000-0000-0000-000000000003')$q$,
                'an admin deletes a user''s AI emoji');
SELECT throws_ok($q$SELECT public.admin_delete_instance_emoji('134e0000-0000-0000-0000-000000000005')$q$,
                 'P0002', NULL, 'a server emoji stays out of reach');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.emojis WHERE id = '134e0000-0000-0000-0000-000000000003'),
          0, 'the deleted AI emoji is gone');
SELECT is((SELECT profile_id FROM public.ai_emoji_generations WHERE emoji_id = '134e0000-0000-0000-0000-000000000003'),
          '33333333-0000-0000-0000-000000000003'::uuid, 'its ledger row remains and still counts for the owner');

SELECT * FROM finish();
ROLLBACK;
