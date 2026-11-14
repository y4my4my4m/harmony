-- 20261111400001_public_remote_profile_pages.sql: public_profile_page with p_domain reads a
-- remote account as this instance holds it.
--
-- modiie264   remote on piaille264.test, origin counts read, a public, a followers-only and a
--             pinned post
-- quiet264    remote on piaille264.test, origin counts withheld
-- local264    local, same username as a remote account on far264.test
-- far264      remote on blocked264.test, a blocked instance

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

SELECT ok(NOT has_function_privilege('anon', 'public.public_profile_page(text, uuid, integer, text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.public_profile_page(text, uuid, integer, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.public_profile_page(text, uuid, integer, text)', 'EXECUTE'),
  'only service callers read the page');
SELECT is((SELECT count(*)::int FROM pg_proc
            WHERE proname = 'public_profile_page' AND pronamespace = 'public'::regnamespace), 1,
  'one public_profile_page remains');

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('e2640000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'local264@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('e2640000-0000-0000-0000-0000000000c1', 'e2640000-0000-0000-0000-0000000000a1', 'local264', 'Local', true);
INSERT INTO public.profiles (id, username, display_name, bio, is_local, domain, federated_id, followers_count,
                             remote_followers_count, remote_following_count, remote_posts_count, remote_counts_fetched_at,
                             federation_metadata) VALUES
  ('e2640000-0000-0000-0000-0000000000d1', 'Modiie', 'Modiie', 'Streamer', false, 'piaille264.test',
   'https://piaille264.test/users/Modiie', 1, 6481, 172, 724, now(), '{"url": "https://piaille264.test/@Modiie"}'),
  ('e2640000-0000-0000-0000-0000000000d2', 'quiet264', 'Quiet', NULL, false, 'piaille264.test',
   'https://piaille264.test/users/quiet264', 3, NULL, NULL, NULL, now(), '{}'),
  ('e2640000-0000-0000-0000-0000000000d3', 'local264', 'Far twin', NULL, false, 'far264.test',
   'https://far264.test/users/local264', 0, NULL, NULL, NULL, NULL, '{}'),
  ('e2640000-0000-0000-0000-0000000000d4', 'far264', 'Far', NULL, false, 'blocked264.test',
   'https://blocked264.test/users/far264', 0, NULL, NULL, NULL, NULL, '{}');
INSERT INTO public.federated_instances (domain, is_blocked) VALUES ('blocked264.test', true);

INSERT INTO public.posts (id, author_id, content, visibility, created_at, metadata, is_deleted, is_pinned, is_local,
                          media_attachments, ap_id) VALUES
  ('e2643000-0000-0000-0000-000000000001', 'e2640000-0000-0000-0000-0000000000d1', '[{"type":"text","text":"public"}]',
   'public', now() - interval '3 minutes', '{}', false, false, false, '[]', 'https://piaille264.test/notes/1'),
  ('e2643000-0000-0000-0000-000000000002', 'e2640000-0000-0000-0000-0000000000d1', '[{"type":"text","text":"followers"}]',
   'followers', now() - interval '2 minutes', '{}', false, false, false, '[]', 'https://piaille264.test/notes/2'),
  ('e2643000-0000-0000-0000-000000000003', 'e2640000-0000-0000-0000-0000000000d1', '[{"type":"text","text":"pinned"}]',
   'public', now() - interval '1 minutes', '{}', false, true, false, '[]', 'https://piaille264.test/notes/3');

CREATE TEMP TABLE page264 AS SELECT public.public_profile_page('modiie', NULL, NULL, 'Piaille264.TEST') AS j;

SELECT is((SELECT j #>> '{account,id}' FROM page264), 'e2640000-0000-0000-0000-0000000000d1',
  'username and domain match without case');
SELECT results_eq(
    $q$SELECT j #>> '{account,username}', j #>> '{account,domain}', (j #>> '{account,is_local}')::boolean,
              j #>> '{account,url}', j #>> '{account,bio}'
         FROM page264$q$,
    $q$VALUES ('Modiie'::text, 'piaille264.test'::text, false, 'https://piaille264.test/@Modiie'::text, 'Streamer'::text)$q$,
    'the page carries the remote account, its origin URL and bio');
SELECT results_eq(
    $q$SELECT (j #>> '{account,followers_count}')::int, (j #>> '{account,following_count}')::int,
              (j #>> '{account,posts_count}')::int FROM page264$q$,
    $q$VALUES (6481, 172, 724)$q$,
    'counts are the origin''s figures');
SELECT is((SELECT j -> 'account' -> 'created_at' FROM page264), 'null'::jsonb,
  'a remote account carries no join date');
SELECT results_eq(
    $q$SELECT e ->> 'id' FROM page264, jsonb_array_elements(j -> 'posts') e$q$,
    $q$VALUES ('e2643000-0000-0000-0000-000000000001'::text)$q$,
    'posts are the public ones held here, followers-only left out');
SELECT results_eq(
    $q$SELECT e ->> 'id' FROM page264, jsonb_array_elements(j -> 'pinned') e$q$,
    $q$VALUES ('e2643000-0000-0000-0000-000000000003'::text)$q$,
    'pinned posts come first');

SELECT is((public.public_profile_page('quiet264', NULL, NULL, 'piaille264.test') #>> '{account,followers_count}')::int, 3,
  'withheld origin counts fall back to this instance''s counters');

SELECT is(public.public_profile_page('local264', NULL, NULL) #>> '{account,id}', 'e2640000-0000-0000-0000-0000000000c1',
  'without a domain the local account answers');
SELECT is(public.public_profile_page('local264', NULL, NULL, 'far264.test') #>> '{account,id}', 'e2640000-0000-0000-0000-0000000000d3',
  'with a domain the remote one does');
SELECT is(public.public_profile_page('modiie', NULL, NULL) -> 'account', 'null'::jsonb,
  'a remote account is not found without its domain');
SELECT is(public.public_profile_page('modiie', NULL, NULL, 'other264.test') -> 'account', 'null'::jsonb,
  'nor under another domain');
SELECT is(public.public_profile_page('far264', NULL, NULL, 'blocked264.test') -> 'account', 'null'::jsonb,
  'an account of a blocked instance is not shown');

SELECT * FROM finish();
ROLLBACK;
