-- 20261125200001_bridge_avatar_usage.sql: Matrix bridge avatars counted per bot and server, toward
-- the server's cap, and listed for removal an hour after the bot's last binding in the server goes.
--
--   server_1  (5555..., alice) general (6666...); s2 (alice) with channel c4
--   b1        alice's Matrix bot, bound to general and to c4
--   b2        alice's Matrix bot, bound to general
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(33);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f3840000-0000-0000-0000-0000000000e2', 'Server 384', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f3840000-0000-0000-0000-0000000000c4', 'f3840000-0000-0000-0000-0000000000e2', 'elsewhere', 0);
INSERT INTO public.bots (id, username, display_name, owner_id, bot_type, is_active) VALUES
  ('f3840000-0000-0000-0000-0000000000b1', 'mx384', 'Matrix 384', '11111111-0000-0000-0000-000000000001', 'bot', true),
  ('f3840000-0000-0000-0000-0000000000b2', 'mxb384', 'Matrix 384 b', '11111111-0000-0000-0000-000000000001', 'bot', true);
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, allowed_channel_ids) VALUES
  ('f3840000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]),
  ('f3840000-0000-0000-0000-0000000000b1', 'f3840000-0000-0000-0000-0000000000e2', '11111111-0000-0000-0000-000000000001',
   ARRAY['f3840000-0000-0000-0000-0000000000c4']::uuid[]),
  ('f3840000-0000-0000-0000-0000000000b2', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]);

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.configure_matrix_bridge('f3840000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
                                      ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]);
SELECT public.configure_matrix_bridge('f3840000-0000-0000-0000-0000000000b1', 'f3840000-0000-0000-0000-0000000000e2',
                                      ARRAY['f3840000-0000-0000-0000-0000000000c4']::uuid[]);
SELECT public.configure_matrix_bridge('f3840000-0000-0000-0000-0000000000b2', '55555555-0000-0000-0000-000000000005',
                                      ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]);
SELECT tests.clear_authentication();

-- '<objects>:<bytes>' of a pair, NULL without a row.
CREATE FUNCTION pg_temp.usage(p_bot text, p_server uuid) RETURNS text LANGUAGE sql AS $$
    SELECT u.objects || ':' || u.bytes FROM public.bridge_avatar_usage u
     WHERE u.bot_id = ('f3840000-0000-0000-0000-0000000000' || p_bot)::uuid AND u.server_id = p_server
$$;
CREATE FUNCTION pg_temp.unbound() RETURNS text LANGUAGE sql AS $$
    SELECT COALESCE(string_agg(p.pair, ',' ORDER BY p.pair), '')
      FROM (SELECT right(u.bot_id::text, 2) || '@' || left(u.server_id::text, 4) AS pair
              FROM public.bridge_avatar_unbound(50) u) p
$$;
CREATE FUNCTION pg_temp.hours_pass() RETURNS void LANGUAGE sql AS $$
    UPDATE public.bridge_avatar_usage SET unbound_at = unbound_at - interval '61 minutes'
$$;

-- Access ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT * FROM public.bridge_avatar_usage$$, '42501', NULL, 'authenticated cannot read the usage');
SELECT throws_ok($$SELECT * FROM public.bridge_avatar_unbound(1)$$, '42501', NULL, 'authenticated cannot list unbound avatars');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT * FROM public.bridge_avatar_usage$$, '42501', NULL, 'anon cannot read the usage');
SELECT throws_ok($$SELECT * FROM public.bridge_avatar_unbound(1)$$, '42501', NULL, 'anon cannot list unbound avatars');
SELECT tests.clear_authentication();
SELECT ok(has_table_privilege('service_role', 'public.bridge_avatar_usage', 'SELECT')
          AND NOT has_table_privilege('service_role', 'public.bridge_avatar_usage', 'INSERT')
          AND NOT has_table_privilege('service_role', 'public.bridge_avatar_usage', 'UPDATE')
          AND NOT has_table_privilege('service_role', 'public.bridge_avatar_usage', 'DELETE'),
          'service_role reads the usage and does not write it');
SELECT ok(has_function_privilege('service_role', 'public.bridge_avatar_unbound(integer)', 'EXECUTE'), 'service_role lists unbound avatars');
SELECT is((SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger
            WHERE tgrelid = 'storage.objects'::regclass AND tgname LIKE 'bridge_avatar_track_%'),
          ARRAY['bridge_avatar_track_delete', 'bridge_avatar_track_insert', 'bridge_avatar_track_update'],
          'storage.objects carries the three tracking triggers');

-- Counting ----------------------------------------------------------------------------------------
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'), 0::bigint, 'nothing is stored at first');
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('avatars', 'bridges/f3840000-0000-0000-0000-0000000000b1/55555555-0000-0000-0000-000000000005/a.png', '{"size": 1000}'),
  ('avatars', 'bridges/f3840000-0000-0000-0000-0000000000b1/55555555-0000-0000-0000-000000000005/b.png', '{"size": 2000}'),
  ('avatars', 'bridges/f3840000-0000-0000-0000-0000000000b1/55555555-0000-0000-0000-000000000005/c.png', '{"size": "unknown"}'),
  ('avatars', 'bridges/f3840000-0000-0000-0000-0000000000b1/f3840000-0000-0000-0000-0000000000e2/a.png', '{"size": 64}'),
  ('avatars', 'bridges/f3840000-0000-0000-0000-0000000000b2/55555555-0000-0000-0000-000000000005/a.png', '{"size": 500}'),
  -- another bucket, a name without a server, a member's avatar
  ('banners', 'bridges/f3840000-0000-0000-0000-0000000000b1/55555555-0000-0000-0000-000000000005/a.png', '{"size": 7}'),
  ('avatars', 'bridges/f3840000-0000-0000-0000-0000000000b1/a.png', '{"size": 7}'),
  ('avatars', '11111111-0000-0000-0000-000000000001/avatar.png', '{"size": 7}');
SELECT is(pg_temp.usage('b1', '55555555-0000-0000-0000-000000000005'), '3:3000', 'avatars count per bot and server, an unreadable size as 0 bytes');
SELECT is(pg_temp.usage('b1', 'f3840000-0000-0000-0000-0000000000e2'), '1:64', 'a bot''s avatars of another server count there');
SELECT is((SELECT count(*)::int FROM public.bridge_avatar_usage), 3, 'nothing else counts');
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'), 3500::bigint,
          'a server''s usage holds the avatars of all its bridges');
INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/b1/a.png', '{"size": 10000}');
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'), 13500::bigint, 'beside its mirrored files');
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1048576 - 13500), true, 'a 1 MB cap has the rest left');
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1048576 - 13499), false, 'and not a byte more');

UPDATE storage.objects SET metadata = '{"size": 1500}'
 WHERE bucket_id = 'avatars' AND name = 'bridges/f3840000-0000-0000-0000-0000000000b1/55555555-0000-0000-0000-000000000005/a.png';
SELECT is(pg_temp.usage('b1', '55555555-0000-0000-0000-000000000005'), '3:3500', 'a size written again replaces the old one');
UPDATE storage.objects SET last_accessed_at = now()
 WHERE bucket_id = 'avatars' AND name LIKE 'bridges/%';
SELECT is(pg_temp.usage('b1', '55555555-0000-0000-0000-000000000005'), '3:3500', 'an update that keeps name and size changes nothing');
DELETE FROM storage.objects
 WHERE bucket_id = 'avatars' AND name = 'bridges/f3840000-0000-0000-0000-0000000000b1/55555555-0000-0000-0000-000000000005/b.png';
SELECT is(pg_temp.usage('b1', '55555555-0000-0000-0000-000000000005'), '2:1500', 'a removed avatar is subtracted');

-- Unbound -----------------------------------------------------------------------------------------
SELECT is(pg_temp.unbound(), '', 'a bound bridge keeps its avatars');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.unconfigure_matrix_bridge('f3840000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005'), true, 'the bridge is unconfigured');
SELECT tests.clear_authentication();
SELECT is(pg_temp.unbound(), '', 'its avatars stay for an hour');
SELECT pg_temp.hours_pass();
SELECT is(pg_temp.unbound(), 'b1@5555', 'then they are listed, those of its other server are not');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.configure_matrix_bridge('f3840000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
                                      ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]);
SELECT tests.clear_authentication();
SELECT is(pg_temp.unbound(), '', 'a bridge configured again keeps what is left');
SELECT is((SELECT count(*)::int FROM public.bridge_avatar_usage WHERE unbound_at IS NOT NULL), 0, 'and its hour starts anew');

DELETE FROM public.bots WHERE id = 'f3840000-0000-0000-0000-0000000000b2';
SELECT is(pg_temp.usage('b2', '55555555-0000-0000-0000-000000000005'), '1:500', 'a deleted bot''s avatars still count');
SELECT is(pg_temp.unbound(), '', 'for an hour');
SELECT pg_temp.hours_pass();
SELECT is(pg_temp.unbound(), 'b2@5555', 'then they are listed');

DELETE FROM public.channels WHERE id = 'f3840000-0000-0000-0000-0000000000c4';
SELECT pg_temp.unbound();
SELECT pg_temp.hours_pass();
SELECT is(pg_temp.unbound(), 'b1@f384,b2@5555', 'so are those of a server whose paired channels are gone');
DELETE FROM public.servers WHERE id = 'f3840000-0000-0000-0000-0000000000e2';
SELECT is(pg_temp.unbound(), 'b1@f384,b2@5555', 'and of a deleted server');
SELECT is((SELECT count(*)::int FROM public.bridge_avatar_unbound(1)), 1, 'the list is as long as asked');

DELETE FROM storage.objects WHERE bucket_id = 'avatars' AND name LIKE 'bridges/f3840000-0000-0000-0000-0000000000b2/%';
SELECT is(pg_temp.usage('b2', '55555555-0000-0000-0000-000000000005'), NULL, 'the row goes with its last avatar');
SELECT is(pg_temp.unbound(), 'b1@f384', 'and leaves the list');
SELECT is(pg_temp.usage('b1', '55555555-0000-0000-0000-000000000005'), '2:1500', 'the bound bridge''s avatars are untouched');

SELECT * FROM finish();
ROLLBACK;
