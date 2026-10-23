-- 20261027600001_local_username_rules.sql: a local account's username is 3-24 characters of a-z,
-- 0-9 and _, from any writer, onboarding's client insert included. Remote usernames keep their own
-- shape. A local row written before the rule keeps its username and takes other edits.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('18600000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n186@test.local');

-- Onboarding: the new account inserts its own profile.
SELECT tests.authenticate_as('18600000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
                    VALUES ('18600000-0000-0000-0000-0000000000a1', '18600000-0000-0000-0000-0000000000a1', 'ab', 'N', true)$q$,
  '23514', NULL, 'onboarding refuses a 2-character username');
SELECT lives_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
                   VALUES ('18600000-0000-0000-0000-0000000000a1', '18600000-0000-0000-0000-0000000000a1', 'abc', 'N', true)$q$,
  'and takes a 3-character one');
SELECT tests.clear_authentication();

-- Any writer, local rows.
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('Mixed_Case', true)$q$,
  '23514', NULL, 'capitals are refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('has-dash', true)$q$,
  '23514', NULL, 'a dash is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('abcdefghijklmnopqrstuvwxy', true)$q$,
  '23514', NULL, '25 characters are refused');
SELECT lives_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('abcdefghijklmnopqrstuvwx', true)$q$,
  '24 characters are taken');
SELECT throws_ok($q$INSERT INTO public.profiles (username) VALUES ('x')$q$,
  '23514', NULL, 'a row with is_local left to its default is local');

-- Remote rows.
SELECT lives_ok($q$INSERT INTO public.profiles (username, domain, is_local) VALUES ('X', 'remote.test', false)$q$,
  'a remote username of one capital is taken');
SELECT throws_ok($q$UPDATE public.profiles SET is_local = true WHERE username = 'X' AND domain = 'remote.test'$q$,
  '23514', NULL, 'and is checked if the row turns local');

-- A local row from before the rule.
ALTER TABLE public.profiles DISABLE TRIGGER guard_local_username;
INSERT INTO public.profiles (id, username, display_name, is_local)
VALUES ('18610000-0000-0000-0000-000000000001', 'Ol', 'Old', true);
ALTER TABLE public.profiles ENABLE TRIGGER guard_local_username;
SELECT lives_ok($q$UPDATE public.profiles SET display_name = 'Older' WHERE id = '18610000-0000-0000-0000-000000000001'$q$,
  'an older local username takes other edits');
SELECT throws_ok($q$UPDATE public.profiles SET username = 'Ol2' WHERE id = '18610000-0000-0000-0000-000000000001'$q$,
  '23514', NULL, 'a new username for it follows the rule');
SELECT lives_ok($q$UPDATE public.profiles SET username = 'old_name' WHERE id = '18610000-0000-0000-0000-000000000001'$q$,
  'one that fits is taken');

SELECT * FROM finish();
ROLLBACK;
