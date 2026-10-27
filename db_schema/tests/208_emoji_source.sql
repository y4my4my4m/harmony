-- 20261031300001_emoji_source.sql: get_emoji_source / get_emoji_source_by_url reveal a
-- server only to its members, or when it is public and not suspended; every other case is
-- the same {"kind": "unavailable"}.
--
-- Fixtures: server_1 'Test Server' (private; alice and bob accepted, banned banned), mallory
-- in no server. Added here:
--   Plaza 208       public, alice owner and member; emoji plaza_a (used most), plaza_b
--   Shut 208        public, suspended; bob a member; emoji shut_a
--   Gone 208        created with emoji gone_a, then deleted
--   Far 208         a remote server copy (fed.example), public; emoji far_a
--   secret_a        an emoji of server_1
--   bob_own         bob's personal emoji
--   inst_a / imp_a  instance emoji, local and imported from remote.example
--   blobcat         remote_emojis_cache entry from fedi.example

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(36);

INSERT INTO public.servers (id, name, owner, public) VALUES
  ('a2080000-0000-0000-0000-0000000000c1', 'Plaza 208', '11111111-0000-0000-0000-000000000001', true),
  ('a2080000-0000-0000-0000-0000000000c2', 'Shut 208',  '11111111-0000-0000-0000-000000000001', true),
  ('a2080000-0000-0000-0000-0000000000c3', 'Gone 208',  '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.servers (id, name, public, is_local_server, host_domain) VALUES
  ('a2080000-0000-0000-0000-0000000000c4', 'Far 208', true, false, 'Fed.Example');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'a2080000-0000-0000-0000-0000000000c1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'a2080000-0000-0000-0000-0000000000c2', 'accepted')
ON CONFLICT DO NOTHING;
UPDATE public.servers SET suspended_at = now() WHERE id = 'a2080000-0000-0000-0000-0000000000c2';

INSERT INTO public.emojis (id, name, url, server_id, uploader, scope, usage_count, domain) VALUES
  ('a2080000-0000-0000-0000-0000000000e1', 'plaza_a', 'https://cdn.test/plaza_a.png', 'a2080000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', 'server', 9, NULL),
  ('a2080000-0000-0000-0000-0000000000e2', 'plaza_b', 'https://cdn.test/plaza_b.png', 'a2080000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', 'server', 1, NULL),
  ('a2080000-0000-0000-0000-0000000000e3', 'shut_a', 'https://cdn.test/shut_a.png', 'a2080000-0000-0000-0000-0000000000c2', '11111111-0000-0000-0000-000000000001', 'server', 0, NULL),
  ('a2080000-0000-0000-0000-0000000000e4', 'gone_a', 'https://cdn.test/gone_a.png', 'a2080000-0000-0000-0000-0000000000c3', '11111111-0000-0000-0000-000000000001', 'server', 0, NULL),
  ('a2080000-0000-0000-0000-0000000000e5', 'secret_a', 'https://cdn.test/secret_a.png', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 'server', 0, NULL),
  ('a2080000-0000-0000-0000-0000000000e6', 'bob_own', 'https://cdn.test/bob_own.png', NULL, '22222222-0000-0000-0000-000000000002', 'user', 0, NULL),
  ('a2080000-0000-0000-0000-0000000000e7', 'inst_a', 'https://cdn.test/inst_a.png', NULL, NULL, 'instance', 0, NULL),
  ('a2080000-0000-0000-0000-0000000000e8', 'imp_a', 'https://cdn.test/imp_a.png', NULL, NULL, 'instance', 0, 'Remote.Example'),
  ('a2080000-0000-0000-0000-0000000000e9', 'far_a', 'https://fed.example/far_a.png', 'a2080000-0000-0000-0000-0000000000c4', NULL, 'server', 0, 'fed.example');
DELETE FROM public.servers WHERE id = 'a2080000-0000-0000-0000-0000000000c3';
INSERT INTO public.remote_emojis_cache (shortcode, origin_domain, full_code, url) VALUES
  ('blobcat', 'fedi.example', 'blobcat@fedi.example', 'https://fedi.example/e/blobcat.png');

-- Grants and shape ------------------------------------------------------------------------
SELECT ok(p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_temp'],
          'get_emoji_source is SECURITY DEFINER with a fixed search_path')
  FROM pg_proc p WHERE p.oid = 'public.get_emoji_source(uuid)'::regprocedure;
SELECT ok(p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_temp'],
          'get_emoji_source_by_url is SECURITY DEFINER with a fixed search_path')
  FROM pg_proc p WHERE p.oid = 'public.get_emoji_source_by_url(text, text)'::regprocedure;
SELECT ok(NOT has_function_privilege('anon', 'public.get_emoji_source(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_emoji_source_by_url(text, text)', 'EXECUTE'),
          'anon executes neither');
SELECT ok(has_function_privilege('authenticated', 'public.get_emoji_source(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_emoji_source_by_url(text, text)', 'EXECUTE'),
          'authenticated executes both');

-- Member ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e5') -> 'server' ->> 'name',
          'Test Server', 'a member sees the private server of its emoji');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e5') -> 'server' -> 'is_member',
          'true'::jsonb, 'is_member is true for a member');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e5') -> 'server' -> 'joinable',
          'false'::jsonb, 'a member is not offered Join');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e5') -> 'server' -> 'member_count',
          '2'::jsonb, 'member_count counts accepted members; the banned row is not one');

-- Non-member of a public server -----------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e2') ->> 'kind', 'server',
          'a non-member sees a public server');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e2') -> 'server' ->> 'name',
          'Plaza 208', 'with its name');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e2') -> 'server' -> 'joinable',
          'true'::jsonb, 'and Join');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e2') -> 'server' -> 'is_member',
          'false'::jsonb, 'is_member is false');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e2') -> 'server' -> 'emojis',
          '[{"id": "a2080000-0000-0000-0000-0000000000e1", "name": "plaza_a", "url": "https://cdn.test/plaza_a.png"}]'::jsonb,
          'other emoji of the server exclude the one asked about');

-- Non-member of a private server: the same bytes as deleted and unknown ------------------
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e5'),
          '{"kind": "unavailable"}'::jsonb, 'a non-member of a private server gets unavailable');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e4'),
          '{"kind": "unavailable"}'::jsonb, 'an emoji of a deleted server is unavailable');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-00000000ffff'),
          '{"kind": "unavailable"}'::jsonb, 'an unknown id is unavailable');
SELECT is(public.get_emoji_source(NULL), '{"kind": "unavailable"}'::jsonb, 'a NULL id is unavailable');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e5')::text,
          public.get_emoji_source('a2080000-0000-0000-0000-00000000ffff')::text,
          'private and unknown are byte-identical as text');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e3'),
          '{"kind": "unavailable"}'::jsonb, 'a suspended public server is unavailable to a non-member');
SELECT is(public.get_emoji_source_by_url('https://cdn.test/secret_a.png', 'secret_a'),
          '{"kind": "unavailable"}'::jsonb, 'by url, a private server''s emoji is unavailable');
SELECT is(public.get_emoji_source_by_url('https://cdn.test/nothing.png', 'nothing'),
          '{"kind": "unavailable"}'::jsonb, 'by url, an unknown url is unavailable');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e5'),
          '{"kind": "unavailable"}'::jsonb, 'a banned user_servers row is not membership');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e3') -> 'server' ->> 'name',
          'Shut 208', 'a member still sees a suspended server');

-- Remote server copy ----------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e9') -> 'server' ->> 'domain',
          'fed.example', 'a public remote server shows its domain');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e9') -> 'server' -> 'joinable',
          'false'::jsonb, 'a remote server is not joined here');
SELECT tests.clear_authentication();
UPDATE public.servers SET public = false WHERE id = 'a2080000-0000-0000-0000-0000000000c4';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e9'),
          '{"kind": "unavailable"}'::jsonb, 'a private remote server is unavailable, domain included');

-- Personal, instance, remote --------------------------------------------------------------
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e6') -> 'owner' ->> 'username',
          'bob', 'a personal emoji names its owner');
SELECT tests.clear_authentication();
INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('22222222-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e6'),
          '{"kind": "personal", "owner": null}'::jsonb, 'an owner who blocked the viewer is not named');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e7'),
          '{"kind": "instance"}'::jsonb, 'an instance emoji');
SELECT is(public.get_emoji_source('a2080000-0000-0000-0000-0000000000e8'),
          '{"kind": "remote", "domain": "remote.example"}'::jsonb, 'an imported emoji names its instance');
SELECT is(public.get_emoji_source_by_url('https://fedi.example/e/blobcat.png', 'blobcat'),
          '{"kind": "remote", "domain": "fedi.example"}'::jsonb, 'by url, a cached remote emoji names its instance');
SELECT is(public.get_emoji_source_by_url('https://cdn.test/plaza_a.png', 'plaza_a') -> 'server' ->> 'name',
          'Plaza 208', 'by url, a public server''s emoji shows the server');
SELECT is(public.get_emoji_source_by_url('https://cdn.test/plaza_a.png', NULL) -> 'server' ->> 'name',
          'Plaza 208', 'by url without a name');
SELECT is(public.get_emoji_source_by_url(repeat('x', 2049), NULL),
          '{"kind": "unavailable"}'::jsonb, 'an overlong url is unavailable');

-- Anon ------------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT public.get_emoji_source('a2080000-0000-0000-0000-0000000000e2')$$,
                 '42501', NULL, 'anon cannot call get_emoji_source');
SELECT throws_ok($$SELECT public.get_emoji_source_by_url('https://cdn.test/plaza_a.png', 'plaza_a')$$,
                 '42501', NULL, 'anon cannot call get_emoji_source_by_url');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
