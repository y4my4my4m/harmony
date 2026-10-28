-- 20261031900001_reserved_usernames.sql: a new local username is none of the reserved names
-- (everyone, here, staff words, the instance's own name) nor a label of the instance's domain
-- before its last. A local row from before the rule keeps its name through other edits. Remote
-- rows are untouched.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(20);

DELETE FROM public.instance_config WHERE config_key = 'domain';
INSERT INTO public.instance_config (config_key, config_value) VALUES ('domain', '"chat.example.test:8443"');

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('21400000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n214@test.local');

-- Onboarding: the new account inserts its own profile.
SELECT tests.authenticate_as('21400000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
                    VALUES ('21400000-0000-0000-0000-0000000000a1', '21400000-0000-0000-0000-0000000000a1', 'everyone', 'N', true, 'chat.example.test:8443')$q$,
  '23514', 'The username everyone is reserved', 'onboarding refuses everyone');
SELECT throws_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
                    VALUES ('21400000-0000-0000-0000-0000000000a1', '21400000-0000-0000-0000-0000000000a1', 'example', 'N', true, 'chat.example.test:8443')$q$,
  '23514', 'The username example is reserved', 'and a label of the instance domain');
SELECT lives_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
                   VALUES ('21400000-0000-0000-0000-0000000000a1', '21400000-0000-0000-0000-0000000000a1', 'everyone2', 'N', true, 'chat.example.test:8443')$q$,
  'and takes a name that only starts with one');
SELECT tests.clear_authentication();

-- Any writer, local rows.
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('here', true)$q$,
  '23514', NULL, 'here is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('system', true)$q$,
  '23514', NULL, 'system is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('harmony', true)$q$,
  '23514', NULL, 'harmony is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('administrator', true)$q$,
  '23514', NULL, 'administrator is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('moderators', true)$q$,
  '23514', NULL, 'moderators is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('root', true)$q$,
  '23514', NULL, 'root is refused');
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('chat', true)$q$,
  '23514', NULL, 'the first domain label is refused');
SELECT lives_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('test', true)$q$,
  'the top-level domain is taken');
SELECT lives_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('admin_bob', true)$q$,
  'a name containing a reserved word is taken');

-- Remote rows.
SELECT lives_ok($q$INSERT INTO public.profiles (username, domain, is_local) VALUES ('everyone', 'remote.test', false)$q$,
  'a remote everyone is taken');
SELECT lives_ok($q$UPDATE public.profiles SET display_name = 'Everyone' WHERE username = 'everyone' AND domain = 'remote.test'$q$,
  'and takes edits');
SELECT throws_ok($q$UPDATE public.profiles SET is_local = true WHERE username = 'everyone' AND domain = 'remote.test'$q$,
  '23514', NULL, 'and is checked if the row turns local');

-- A local row from before the rule.
ALTER TABLE public.profiles DISABLE TRIGGER guard_local_username;
INSERT INTO public.profiles (id, username, display_name, is_local)
VALUES ('21410000-0000-0000-0000-000000000001', 'admin', 'Old admin', true);
ALTER TABLE public.profiles ENABLE TRIGGER guard_local_username;
SELECT lives_ok($q$UPDATE public.profiles SET display_name = 'Older', bio = 'b' WHERE id = '21410000-0000-0000-0000-000000000001'$q$,
  'an older reserved username takes other edits');
SELECT is((SELECT username FROM public.profiles WHERE id = '21410000-0000-0000-0000-000000000001'), 'admin',
  'and keeps its name');
SELECT throws_ok($q$UPDATE public.profiles SET username = 'staff' WHERE id = '21410000-0000-0000-0000-000000000001'$q$,
  '23514', NULL, 'a new reserved username for it is refused');
SELECT lives_ok($q$UPDATE public.profiles SET username = 'old_admin' WHERE id = '21410000-0000-0000-0000-000000000001'$q$,
  'one that is not reserved is taken');

-- Domain without a dot: the whole host is reserved.
UPDATE public.instance_config SET config_value = '"localhost"' WHERE config_key = 'domain';
SELECT throws_ok($q$INSERT INTO public.profiles (username, is_local) VALUES ('localhost', true)$q$,
  '23514', NULL, 'a single-label domain is reserved');

SELECT * FROM finish();
ROLLBACK;
