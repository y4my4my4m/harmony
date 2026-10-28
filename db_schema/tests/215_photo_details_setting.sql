-- 20261101100001_photo_details_setting.sql: photo_details_settings holds one account's default
-- for "Keep photo details", off when absent, readable and writable by that account only, gone
-- with the auth user.
--
--   alice, bob   fixture members (01_fixtures.sql)
--   carol215     an auth user without a profile, deleted at the end

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

CREATE TEMP TABLE r215 (k text PRIMARY KEY, v text);
GRANT ALL ON r215 TO anon, authenticated;

SELECT ok(NOT has_table_privilege('anon', 'public.photo_details_settings', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.photo_details_settings', 'INSERT'),
  'anon neither reads nor writes the setting');
SELECT is((SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'photo_details_settings'
              AND column_name = 'keep_by_default'), 'false',
  'photo details are removed by default');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$INSERT INTO public.photo_details_settings (keep_by_default) VALUES (true)
                  ON CONFLICT (user_id) DO UPDATE SET keep_by_default = EXCLUDED.keep_by_default$$,
  'alice keeps photo details by default');
SELECT lives_ok($$INSERT INTO public.photo_details_settings (keep_by_default) VALUES (false)
                  ON CONFLICT (user_id) DO UPDATE SET keep_by_default = EXCLUDED.keep_by_default$$,
  'and stops through the same upsert');
SELECT throws_ok($$INSERT INTO public.photo_details_settings (user_id, keep_by_default)
                   VALUES ('bbbbbbbb-0000-0000-0000-000000000002', true)$$,
  '42501', NULL, 'alice cannot write bob''s setting');
INSERT INTO r215 SELECT 'alice', user_id::text FROM public.photo_details_settings;
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM r215 WHERE k = 'alice'), 'aaaaaaaa-0000-0000-0000-000000000001',
  'the row belongs to the caller''s auth user');

UPDATE public.photo_details_settings SET keep_by_default = true
 WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO r215 SELECT 'bob-reads', count(*)::text FROM public.photo_details_settings;
UPDATE public.photo_details_settings SET keep_by_default = false
 WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM r215 WHERE k = 'bob-reads'), '0', 'bob does not read alice''s setting');
SELECT ok((SELECT keep_by_default FROM public.photo_details_settings
            WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'bob cannot change alice''s setting');

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2150000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol215@test.local');
SELECT tests.authenticate_as('f2150000-0000-0000-0000-0000000000a1');
INSERT INTO public.photo_details_settings (keep_by_default) VALUES (true);
SELECT tests.clear_authentication();
DELETE FROM auth.users WHERE id = 'f2150000-0000-0000-0000-0000000000a1';
SELECT is((SELECT count(*)::int FROM public.photo_details_settings
            WHERE user_id = 'f2150000-0000-0000-0000-0000000000a1'), 0,
  'deleting the auth user deletes its row');

SELECT * FROM finish();
ROLLBACK;
