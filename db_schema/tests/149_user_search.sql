-- search_local_users and search_federated_users from 20261016100003_user_search.sql.
--
--   zqexact      local, the exact username searched
--   zqexactly    local, username prefix
--   bobby149     local, display name 'Zqexact Fan'  (display-name prefix)
--   carl149      local, display name 'The Zqexact'  (display-name word prefix)
--   zqexactremote  remote on r149.example
--   zqexactnoauth  local, no auth user
--   zqexactsusp    local, suspended
--   zqexactdel     local, deleted
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(31);

INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT ('f1490000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@test149.local'
  FROM generate_series(1, 40) n;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_suspended, deleted_at)
VALUES
  ('e1490000-0000-0000-0000-000000000001', 'f1490000-0000-0000-0000-000000000001', 'zqexact',       'Someone',     true, false, NULL),
  ('e1490000-0000-0000-0000-000000000002', 'f1490000-0000-0000-0000-000000000002', 'zqexactly',     'Other',       true, false, NULL),
  ('e1490000-0000-0000-0000-000000000003', 'f1490000-0000-0000-0000-000000000003', 'bobby149',      'Zqexact Fan', true, false, NULL),
  ('e1490000-0000-0000-0000-000000000004', 'f1490000-0000-0000-0000-000000000004', 'carl149',       'The Zqexact', true, false, NULL),
  ('e1490000-0000-0000-0000-000000000005', NULL,                                   'zqexactnoauth', 'No auth',     true, false, NULL),
  ('e1490000-0000-0000-0000-000000000006', 'f1490000-0000-0000-0000-000000000006', 'zqexactsusp',   'Suspended',   true, true,  NULL),
  ('e1490000-0000-0000-0000-000000000007', 'f1490000-0000-0000-0000-000000000007', 'zqexactdel',    'Deleted',     true, false, now()),
  ('e1490000-0000-0000-0000-000000000008', 'f1490000-0000-0000-0000-000000000008', 'zq_x1',         'Under',       true, false, NULL),
  ('e1490000-0000-0000-0000-000000000009', 'f1490000-0000-0000-0000-000000000009', 'zqax1',         'Wild',        true, false, NULL);

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url)
VALUES ('e1490000-0000-0000-0000-000000000010', 'zqexactremote', 'Remote', false, 'r149.example',
        'https://r149.example/users/zqexactremote', 'https://r149.example/users/zqexactremote/inbox');

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT ('e1490000-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid,
       ('f1490000-0000-0000-0000-' || lpad((n + 15)::text, 12, '0'))::uuid,
       'zqmany' || lpad(n::text, 2, '0'), 'Many', true
  FROM generate_series(1, 25) n;

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url)
SELECT ('e1490000-0000-0000-0002-' || lpad(n::text, 12, '0'))::uuid,
       'zqbulk' || lpad(n::text, 2, '0'), 'Bulk', false, 'bulk149.example',
       'https://bulk149.example/users/' || n, 'https://bulk149.example/users/' || n || '/inbox'
  FROM generate_series(1, 55) n;

-- Grants. -------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.search_local_users(text, integer)', 'EXECUTE'),
  'anon cannot search local accounts');
SELECT ok(has_function_privilege('authenticated', 'public.search_local_users(text, integer)', 'EXECUTE'),
  'a signed-in account can');

-- Local search. -------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT is(array(SELECT username FROM public.search_local_users('zqexact', 20)),
  ARRAY['zqexact', 'zqexactly', 'bobby149', 'carl149'],
  'exact username, then username prefix, then display-name prefix, then display-name word');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_local_users('zqexactremote', 20)),
  'a remote account is not offered');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_local_users('zqexactnoauth', 20)),
  'a profile without an auth user is not offered');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_local_users('zqexactsusp', 20)),
  'a suspended account is not offered');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_local_users('zqexactdel', 20)),
  'a deleted account is not offered');
SELECT is(array(SELECT username FROM public.search_local_users('@zqexact', 20)),
  ARRAY['zqexact', 'zqexactly', 'bobby149', 'carl149'], 'a leading @ is ignored');
SELECT is(array(SELECT username FROM public.search_local_users('ZQEXACT', 20)),
  ARRAY['zqexact', 'zqexactly', 'bobby149', 'carl149'], 'matching ignores case');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_local_users('exact', 20)),
  'the middle of a username is no prefix');
SELECT is(array(SELECT username FROM public.search_local_users('zq_', 20)), ARRAY['zq_x1'],
  '_ in the query is a literal underscore');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_local_users('zq%', 20)),
  '% in the query is a literal percent sign');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_local_users('alice', 20)),
  'the caller is not offered to themselves');
SELECT is((SELECT count(*)::int FROM public.search_local_users('', 20)), 0, 'an empty query finds nobody');
SELECT is((SELECT count(*)::int FROM public.search_local_users('  @ ', 20)), 0, 'a bare @ finds nobody');
SELECT is((SELECT count(*)::int FROM public.search_local_users('zqmany', 1000)), 20, 'at most 20 rows');
SELECT is((SELECT count(*)::int FROM public.search_local_users('zqmany', 0)), 1, 'at least 1 row');
SELECT is((SELECT count(*)::int FROM public.search_local_users('zqmany')), 8, 'eight rows by default');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(array(SELECT username FROM public.search_local_users('alice', 20)), ARRAY['alice'],
  'another account finds the caller');

-- Federated search. ---------------------------------------------------------------------
SELECT is(array(SELECT username FROM public.search_federated_users('zqexact', 50)),
  ARRAY['bobby149', 'carl149', 'zqexact', 'zqexactdel', 'zqexactly', 'zqexactnoauth', 'zqexactremote'],
  'username and display-name substrings, local first, suspended left out');
SELECT is(array(SELECT username FROM public.search_federated_users('xactrem', 10)), ARRAY['zqexactremote'],
  'the middle of a username matches');
SELECT is(array(SELECT username FROM public.search_federated_users('remote@r149.ex', 10)), ARRAY['zqexactremote'],
  'user@domain matches the end of the username and the start of the domain');
SELECT is(array(SELECT username FROM public.search_federated_users('@zqexactremote@r149.example', 10)),
  ARRAY['zqexactremote'], 'a leading @ is ignored');
SELECT is(array(SELECT username FROM public.search_federated_users('r149.exam', 10)), ARRAY['zqexactremote'],
  'a query without @ matches the domain');
SELECT is((SELECT handle FROM public.search_federated_users('zqexactremote', 10)), 'zqexactremote@r149.example',
  'the handle is username@domain');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_federated_users('exactremote@r149.example.org', 10)),
  'the domain part must match from its start');
SELECT is(array(SELECT username FROM public.search_federated_users('q_x', 10)), ARRAY['zq_x1'],
  '_ in the query is a literal underscore');
SELECT is((SELECT count(*)::int FROM public.search_federated_users('%', 10)), 0,
  '% in the query is a literal percent sign');
SELECT is((SELECT count(*)::int FROM public.search_federated_users('zqbulk', 1000)), 50, 'at most 50 rows');
SELECT is((SELECT count(*)::int FROM public.search_federated_users('zqbulk', -5)), 1, 'at least 1 row');
SELECT is((SELECT count(*)::int FROM public.search_federated_users('', 10)), 0, 'an empty query finds nobody');

SELECT * FROM finish();
ROLLBACK;
