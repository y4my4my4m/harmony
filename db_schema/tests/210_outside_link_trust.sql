-- 20261031500001_outside_link_trust.sql: outside_link_settings and trusted_link_hosts hold one
-- account's outside-link choices, readable and writable by that account only, 500 hosts at most,
-- gone with the auth user.
--
--   alice, bob   fixture members (01_fixtures.sql)
--   carol210     an auth user without a profile, deleted at the end

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(19);

CREATE TEMP TABLE r210 (k text PRIMARY KEY, v text);
GRANT ALL ON r210 TO anon, authenticated;

-- Grants. -----------------------------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('anon', 'public.trusted_link_hosts', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.outside_link_settings', 'SELECT'),
  'anon reads neither table');
SELECT ok(NOT has_table_privilege('authenticated', 'public.trusted_link_hosts', 'UPDATE'),
  'a trusted host is added or removed, never rewritten');

-- Trusted hosts. ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$INSERT INTO public.trusted_link_hosts (host) VALUES ('example.com')$$,
  'alice trusts a host');
SELECT lives_ok($$INSERT INTO public.trusted_link_hosts (host) VALUES ('localhost:8080'), ('[::1]:3000'), ('xn--e1afmkfd.xn--p1ai')$$,
  'a port, an IPv6 literal and punycode are hosts');
SELECT throws_ok($$INSERT INTO public.trusted_link_hosts (host) VALUES ('www.example.org')$$,
  '23514', NULL, 'a host with a leading www. is refused');
SELECT throws_ok($$INSERT INTO public.trusted_link_hosts (host) VALUES ('Example.org')$$,
  '23514', NULL, 'a host is lower case');
SELECT throws_ok($$INSERT INTO public.trusted_link_hosts (host) VALUES ('example.org/path')$$,
  '23514', NULL, 'a host has no path');
SELECT throws_ok($$INSERT INTO public.trusted_link_hosts (host) VALUES ('javascript:alert(1)')$$,
  '23514', NULL, 'a host has no scheme');
SELECT throws_ok($$INSERT INTO public.trusted_link_hosts (user_id, host)
                   VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'evil.example')$$,
  '42501', NULL, 'alice cannot add a host for bob');
INSERT INTO r210 SELECT 'alice:' || host, user_id::text FROM public.trusted_link_hosts;
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM r210 WHERE k = 'alice:example.com'), 'aaaaaaaa-0000-0000-0000-000000000001',
  'the row belongs to the caller''s auth user');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO public.trusted_link_hosts (host) VALUES ('bob.example');
INSERT INTO r210 SELECT 'bob:' || host, user_id::text FROM public.trusted_link_hosts;
DELETE FROM public.trusted_link_hosts WHERE host = 'example.com';
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM r210 WHERE k LIKE 'bob:%'), 1, 'bob reads his own hosts only');
SELECT is((SELECT count(*)::int FROM public.trusted_link_hosts
            WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND host = 'example.com'), 1,
  'bob cannot remove alice''s host');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
DELETE FROM public.trusted_link_hosts WHERE host = 'localhost:8080';
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.trusted_link_hosts
            WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND host = 'localhost:8080'), 0,
  'alice removes her host');

-- 500 hosts per account. --------------------------------------------------------------------------
INSERT INTO public.trusted_link_hosts (user_id, host)
SELECT 'aaaaaaaa-0000-0000-0000-000000000001', 'cap' || g || '.example'
  FROM generate_series(1, 500 - (SELECT count(*) FROM public.trusted_link_hosts
                                  WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001')) g;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$INSERT INTO public.trusted_link_hosts (host) VALUES ('one-too-many.example')$$,
  '54000', NULL, 'the 501st host is refused');
SELECT tests.clear_authentication();

-- Settings. ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$INSERT INTO public.outside_link_settings (ask_every_link) VALUES (true)
                  ON CONFLICT (user_id) DO UPDATE SET ask_every_link = EXCLUDED.ask_every_link$$,
  'alice turns on asking for every link');
SELECT lives_ok($$INSERT INTO public.outside_link_settings (ask_every_link) VALUES (false)
                  ON CONFLICT (user_id) DO UPDATE SET ask_every_link = EXCLUDED.ask_every_link$$,
  'and off again through the same upsert');
SELECT tests.clear_authentication();
UPDATE public.outside_link_settings SET ask_every_link = true
 WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO r210 SELECT 'bob-settings', count(*)::text FROM public.outside_link_settings;
UPDATE public.outside_link_settings SET ask_every_link = false
 WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM r210 WHERE k = 'bob-settings'), '0', 'bob does not read alice''s settings');
SELECT ok((SELECT ask_every_link FROM public.outside_link_settings
            WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'bob cannot change alice''s settings');

-- Account deletion. -------------------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2100000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol210@test.local');
SELECT tests.authenticate_as('f2100000-0000-0000-0000-0000000000a1');
INSERT INTO public.trusted_link_hosts (host) VALUES ('carol.example');
INSERT INTO public.outside_link_settings (ask_every_link) VALUES (true);
SELECT tests.clear_authentication();
DELETE FROM auth.users WHERE id = 'f2100000-0000-0000-0000-0000000000a1';
SELECT is((SELECT count(*)::int FROM public.trusted_link_hosts
            WHERE user_id = 'f2100000-0000-0000-0000-0000000000a1')
        + (SELECT count(*)::int FROM public.outside_link_settings
            WHERE user_id = 'f2100000-0000-0000-0000-0000000000a1'), 0,
  'deleting the auth user deletes its rows');

SELECT * FROM finish();
ROLLBACK;
