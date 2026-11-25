-- 20261125200002_bridge_upload_reservations.sql: bytes of bot uploads, mirrored files and bridge
-- avatars claimed before they are read.
--
--   server_1  (5555..., alice) general (6666...); s2 (alice) with channel c4
--   cap       2 MB per server; server_1 holds 1 MB of mirrored files
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(43);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f3850000-0000-0000-0000-0000000000e2', 'Server 385', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f3850000-0000-0000-0000-0000000000c4', 'f3850000-0000-0000-0000-0000000000e2', 'elsewhere', 0);
INSERT INTO public.bots (id, username, display_name, owner_id, bot_type, is_active) VALUES
  ('f3850000-0000-0000-0000-0000000000b1', 'mx385', 'Matrix 385', '11111111-0000-0000-0000-000000000001', 'bot', true);
UPDATE public.instance_config SET config_value = '2'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/b1/a.png', '{"size": 1048576}');

-- A claim of reservation r<n> in general; an avatar of b1 with a limit of p_max.
CREATE FUNCTION pg_temp.claim(p_n integer, p_bytes bigint, p_channel uuid DEFAULT '66666666-0000-0000-0000-000000000006') RETURNS text LANGUAGE sql AS $$
    SELECT public.bridge_upload_reserve(('f3850000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid, p_channel, p_bytes)
$$;
CREATE FUNCTION pg_temp.avatar(p_n integer, p_bytes bigint, p_max integer, p_channel uuid DEFAULT '66666666-0000-0000-0000-000000000006') RETURNS text LANGUAGE sql AS $$
    SELECT public.bridge_upload_reserve(('f3850000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid, p_channel, p_bytes,
                                        'f3850000-0000-0000-0000-0000000000b1', p_max)
$$;
CREATE FUNCTION pg_temp.release(p_n integer) RETURNS void LANGUAGE sql AS $$
    SELECT public.bridge_upload_release(('f3850000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid)
$$;
CREATE FUNCTION pg_temp.held() RETURNS bigint LANGUAGE sql AS $$
    SELECT COALESCE(sum(bytes), 0)::bigint FROM public.bridge_upload_reservations
$$;

-- Access ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT * FROM public.bridge_upload_reservations$$, '42501', NULL, 'authenticated cannot read the claims');
SELECT throws_ok($$SELECT public.bridge_upload_reserve(gen_random_uuid(), '66666666-0000-0000-0000-000000000006', 1)$$, '42501', NULL,
                 'authenticated cannot claim');
SELECT throws_ok($$SELECT public.bridge_upload_release(gen_random_uuid())$$, '42501', NULL, 'authenticated cannot release');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT public.bridge_upload_reserve(gen_random_uuid(), '66666666-0000-0000-0000-000000000006', 1)$$, '42501', NULL,
                 'anon cannot claim');
SELECT throws_ok($$SELECT public.bridge_upload_release(gen_random_uuid())$$, '42501', NULL, 'anon cannot release');
SELECT tests.clear_authentication();
SELECT ok(has_function_privilege('service_role', 'public.bridge_upload_reserve(uuid, uuid, bigint, uuid, integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_upload_release(uuid)', 'EXECUTE'), 'service_role claims and releases');
SELECT ok(NOT has_table_privilege('service_role', 'public.bridge_upload_reservations', 'INSERT')
          AND NOT has_table_privilege('service_role', 'public.bridge_upload_reservations', 'DELETE'), 'through the functions alone');

-- Claims ------------------------------------------------------------------------------------------
SELECT is(pg_temp.claim(1, 1048577), 'full', 'a claim past what the stored bytes leave is refused as full');
SELECT is(pg_temp.held(), 0::bigint, 'and holds nothing');
SELECT is(pg_temp.claim(1, 600000), 'reserved', 'one within it is held');
SELECT is(pg_temp.claim(2, 600000), 'busy', 'the next reads the first''s bytes, and is refused as busy: the stored ones leave it room');
SELECT is(pg_temp.claim(2, 1048576), 'busy', 'up to what the stored bytes leave');
SELECT is(pg_temp.claim(2, 1048577), 'full', 'and not a byte more');
SELECT is(pg_temp.held(), 600000::bigint, 'a refused claim holds nothing');
SELECT is(pg_temp.claim(2, 448576), 'reserved', 'the rest is taken exactly');
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1), false, 'bridge_mirror_allows counts bytes in flight');
SELECT is(pg_temp.claim(3, 1, 'f3850000-0000-0000-0000-0000000000c4'), 'reserved', 'another server is not affected');
SELECT pg_temp.release(3);
SELECT pg_temp.release(1);
SELECT is(pg_temp.held(), 448576::bigint, 'a released claim is gone');
SELECT pg_temp.release(1);
SELECT is(pg_temp.claim(4, 600000), 'reserved', 'and leaves its room');
SELECT is(pg_temp.claim(4, 600001), 'busy', 'a raise past the cap is refused');
SELECT is(pg_temp.held(), 448576::bigint, 'and drops the claim it raises');
SELECT is(pg_temp.claim(2, 1048576), 'reserved', 'a raise counts its own bytes once');
SELECT is(pg_temp.held(), 1048576::bigint, 'and replaces them');
SELECT is(pg_temp.claim(2, 0), 'reserved', 'a claim may shrink');
SELECT is(pg_temp.claim(2, -5), 'reserved', 'a negative size claims nothing');
SELECT is(pg_temp.claim(2, NULL), 'reserved', 'nor does an unknown one');
SELECT pg_temp.release(2);

SELECT is(pg_temp.claim(5, 1, 'f3850000-0000-0000-0000-0000000000ff'), 'full', 'no claim in a channel that does not exist');
SELECT is(public.bridge_upload_reserve(NULL, '66666666-0000-0000-0000-000000000006', 1), 'full', 'nor without a reservation id');

-- A gateway that died -----------------------------------------------------------------------------
SELECT pg_temp.claim(6, 1048576);
UPDATE public.bridge_upload_reservations SET expires_at = now() - interval '1 second';
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1048576), true, 'an expired claim counts no more');
SELECT is(pg_temp.claim(7, 1048576), 'reserved', 'nor for the next claim');
SELECT is((SELECT count(*)::int FROM public.bridge_upload_reservations), 1, 'which clears it away');
SELECT ok((SELECT expires_at BETWEEN now() + interval '1799 seconds' AND now() + interval '1801 seconds'
             FROM public.bridge_upload_reservations), 'a claim lasts 1800 s');

-- No cap ------------------------------------------------------------------------------------------
UPDATE public.instance_config SET config_value = '0'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT is(pg_temp.claim(8, 1099511627776), 'reserved', 'a cap of 0 refuses no claim');
SELECT pg_temp.release(7);
SELECT pg_temp.release(8);

-- Avatars -----------------------------------------------------------------------------------------
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('avatars', 'bridges/f3850000-0000-0000-0000-0000000000b1/55555555-0000-0000-0000-000000000005/a.png', '{"size": 100}'),
  ('avatars', 'bridges/f3850000-0000-0000-0000-0000000000b1/f3850000-0000-0000-0000-0000000000e2/a.png', '{"size": 100}');
SELECT is(pg_temp.avatar(9, 100, 1), 'avatars', 'a bot''s avatars are counted, without a cap too');
SELECT is(pg_temp.avatar(9, 100, 2), 'reserved', 'the last one is admitted');
SELECT is(pg_temp.avatar(10, 100, 2), 'avatars', 'and counts while it is in flight');
SELECT is(pg_temp.avatar(10, 100, 2, 'f3850000-0000-0000-0000-0000000000c4'), 'reserved', 'in its own server alone');
SELECT is(pg_temp.claim(11, 100), 'reserved', 'a bot''s other files are not avatars');
DELETE FROM storage.objects
 WHERE bucket_id = 'avatars' AND name = 'bridges/f3850000-0000-0000-0000-0000000000b1/55555555-0000-0000-0000-000000000005/a.png';
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'), 1048576::bigint, 'a removed avatar''s bytes are given back');
SELECT is(pg_temp.avatar(12, 100, 2), 'reserved', 'and so is its place');
SELECT pg_temp.release(9);
SELECT pg_temp.release(11);
SELECT pg_temp.release(12);
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT is(pg_temp.avatar(12, 100, 0), 'full', 'an avatar needs room under the server''s cap before a place');
UPDATE public.instance_config SET config_value = '2'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT pg_temp.claim(13, 1048576);
SELECT is(pg_temp.avatar(12, 100, 0), 'busy', 'and waits for files in flight before one is replaced');

DELETE FROM public.servers WHERE id = 'f3850000-0000-0000-0000-0000000000e2';
SELECT is((SELECT count(*)::int FROM public.bridge_upload_reservations WHERE server_id = 'f3850000-0000-0000-0000-0000000000e2'), 0,
          'a deleted server takes its claims');

SELECT * FROM finish();
ROLLBACK;
