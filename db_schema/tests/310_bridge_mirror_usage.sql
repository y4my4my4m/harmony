-- 20261123100002_bridge_mirror_usage.sql: running totals of mirrored Discord files per channel,
-- kept by triggers on storage.objects, and the server usage and admin status that read them.
--
--   server_1  general (6666...) and c1b
--   server_2  c2
--   alice is made instance admin
--
-- Sizes in bytes; 1 MB = 1048576.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(32);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('31000000-0000-0000-0000-0000000001b0', '55555555-0000-0000-0000-000000000005', 'c1b', 0);
INSERT INTO public.servers (id, name, owner)
VALUES ('31000000-0000-0000-0000-000000000052', 'Server 310', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('31000000-0000-0000-0000-0000000000c2', '31000000-0000-0000-0000-000000000052', 'c2', 0);

CREATE FUNCTION pg_temp.channel_bytes(p_channel uuid) RETURNS bigint LANGUAGE sql AS
$$ SELECT u.bytes FROM public.bridge_mirror_usage u WHERE u.channel_id = p_channel $$;

-- The sum 20261112800001 computed from storage.objects for one server.
CREATE FUNCTION pg_temp.computed(p_server uuid) RETURNS bigint LANGUAGE sql AS $$
    SELECT COALESCE(sum(CASE WHEN o.metadata ->> 'size' ~ '^\d{1,18}$' THEN (o.metadata ->> 'size')::bigint ELSE 0 END), 0)::bigint
      FROM public.channels c
      JOIN storage.objects o
        ON o.bucket_id = 'message_media'
       AND o.name COLLATE "C" >= 'c/' || c.id::text || '/bridge/'
       AND o.name COLLATE "C" <  'c/' || c.id::text || '/bridge0'
     WHERE c.server_id = p_server
$$;

-- Access ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT * FROM public.bridge_mirror_usage$$, '42501', NULL, 'authenticated cannot read the usage');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT * FROM public.bridge_mirror_usage$$, '42501', NULL, 'anon cannot read the usage');
SELECT tests.clear_authentication();
SELECT ok(has_table_privilege('service_role', 'public.bridge_mirror_usage', 'SELECT'), 'service_role reads the usage');
SELECT ok(NOT has_table_privilege('service_role', 'public.bridge_mirror_usage', 'INSERT')
          AND NOT has_table_privilege('service_role', 'public.bridge_mirror_usage', 'UPDATE'),
          'service_role does not write it');
SELECT ok(NOT has_function_privilege('service_role', 'public.bridge_mirror_usage_fill()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_mirror_usage_fill()', 'EXECUTE'),
          'no API role runs the fill');
SELECT is((SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger
            WHERE tgrelid = 'storage.objects'::regclass AND tgname LIKE 'bridge_mirror_track_%'),
          ARRAY['bridge_mirror_track_delete', 'bridge_mirror_track_insert', 'bridge_mirror_track_update'],
          'storage.objects carries the three tracking triggers');

-- Inserts -----------------------------------------------------------------------------------------
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/b1/a.png', '{"size": 1048576}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/b1/b.mp4', '{"size": 2097152}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/b1/c.bin', '{"size": "unknown"}'),
  ('message_media', 'c/31000000-0000-0000-0000-0000000001b0/bridge/b1/d.png', '{"size": 4096}'),
  ('message_media', 'c/31000000-0000-0000-0000-0000000000c2/bridge/b1/e.png', '{"size": 8388608}'),
  -- outside the mirror paths, another bucket, a channel that does not exist, an uppercase id
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/photo.png', '{"size": 7}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge-old/x.png', '{"size": 7}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge0', '{"size": 7}'),
  ('stickers', 'c/66666666-0000-0000-0000-000000000006/bridge/b1/a.png', '{"size": 7}'),
  ('message_media', 'c/31000000-0000-0000-0000-0000000000ff/bridge/b1/f.png', '{"size": 7}'),
  ('message_media', 'c/31000000-0000-0000-0000-0000000001B0/bridge/b1/g.png', '{"size": 7}');

SELECT is(pg_temp.channel_bytes('66666666-0000-0000-0000-000000000006'), 3145728::bigint,
          'an upload adds its size to its channel: 1 MB + 2 MB, an unreadable size as 0');
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'), 3149824::bigint,
          'a server''s usage is the sum of its channels: 3 MB + 4096');
SELECT is(public.bridge_mirror_server_bytes('31000000-0000-0000-0000-000000000052'), 8388608::bigint,
          'the second server''s usage is its own 8 MB');
SELECT is((SELECT count(*)::int FROM public.bridge_mirror_usage
            WHERE channel_id NOT IN ('66666666-0000-0000-0000-000000000006', '31000000-0000-0000-0000-0000000001b0',
                                     '31000000-0000-0000-0000-0000000000c2')),
          0, 'objects outside the mirror paths, in another bucket or of no channel count nowhere');
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'),
          pg_temp.computed('55555555-0000-0000-0000-000000000005'), 'the running total equals the computed sum');

-- Updates -----------------------------------------------------------------------------------------
INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/b1/late.png', '{}');
UPDATE storage.objects SET metadata = '{"size": 500}'
 WHERE bucket_id = 'message_media' AND name = 'c/66666666-0000-0000-0000-000000000006/bridge/b1/late.png';
SELECT is(pg_temp.channel_bytes('66666666-0000-0000-0000-000000000006'), 3146228::bigint,
          'a size written after the insert is added');
UPDATE storage.objects SET metadata = '{"size": 200}'
 WHERE bucket_id = 'message_media' AND name = 'c/66666666-0000-0000-0000-000000000006/bridge/b1/late.png';
SELECT is(pg_temp.channel_bytes('66666666-0000-0000-0000-000000000006'), 3145928::bigint,
          'a changed size replaces the old one');
UPDATE storage.objects SET name = 'c/31000000-0000-0000-0000-0000000001b0/bridge/b1/late.png'
 WHERE bucket_id = 'message_media' AND name = 'c/66666666-0000-0000-0000-000000000006/bridge/b1/late.png';
SELECT results_eq($$SELECT pg_temp.channel_bytes('66666666-0000-0000-0000-000000000006'), pg_temp.channel_bytes('31000000-0000-0000-0000-0000000001b0')$$,
                  $$VALUES (3145728::bigint, 4296::bigint)$$, 'a move between channels moves the size');
UPDATE storage.objects SET name = 'c/31000000-0000-0000-0000-0000000001b0/kept/late.png'
 WHERE bucket_id = 'message_media' AND name = 'c/31000000-0000-0000-0000-0000000001b0/bridge/b1/late.png';
SELECT is(pg_temp.channel_bytes('31000000-0000-0000-0000-0000000001b0'), 4096::bigint, 'a move out of the mirror path subtracts');
UPDATE storage.objects SET last_accessed_at = now()
 WHERE bucket_id = 'message_media' AND name = 'c/66666666-0000-0000-0000-000000000006/bridge/b1/a.png';
SELECT is(pg_temp.channel_bytes('66666666-0000-0000-0000-000000000006'), 3145728::bigint, 'an update that keeps name and size changes nothing');

-- Deletes -----------------------------------------------------------------------------------------
DELETE FROM storage.objects
 WHERE bucket_id = 'message_media' AND name = 'c/66666666-0000-0000-0000-000000000006/bridge/b1/a.png';
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'), 2101248::bigint,
          'a removed file is subtracted: 2 MB + 4096');
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1), true, 'the cap reads the total');
UPDATE public.instance_config SET config_value = '2'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1), false,
          'a 2 MB cap refuses a byte more than 2 MB + 4096');
DELETE FROM public.channels WHERE id = '31000000-0000-0000-0000-0000000001b0';
SELECT is(pg_temp.channel_bytes('31000000-0000-0000-0000-0000000001b0'), NULL, 'a deleted channel takes its row');
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'), 2097152::bigint,
          'and stops counting toward its server at once');
SELECT lives_ok($$DELETE FROM storage.objects WHERE name = 'c/31000000-0000-0000-0000-0000000001b0/bridge/b1/d.png'$$,
                'the sweep later removes the deleted channel''s file');
SELECT is(pg_temp.channel_bytes('31000000-0000-0000-0000-0000000001b0'), NULL, 'which leaves no row behind');

-- Reads -------------------------------------------------------------------------------------------
UPDATE public.bridge_mirror_usage SET bytes = 42 WHERE channel_id = '66666666-0000-0000-0000-000000000006';
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'), 42::bigint,
          'a server''s usage reads the running total, not storage.objects');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.bridge_mirror_status() ->> 'stored_bytes')::bigint, 8388650::bigint,
          'the admin status sums the totals of every server: 42 + 8 MB');
SELECT tests.clear_authentication();

-- Fill --------------------------------------------------------------------------------------------
DELETE FROM public.bridge_mirror_usage WHERE channel_id = '31000000-0000-0000-0000-0000000000c2';
UPDATE public.bridge_mirror_usage SET bytes = 0;
SELECT public.bridge_mirror_usage_fill();
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'),
          pg_temp.computed('55555555-0000-0000-0000-000000000005'),
          'the fill recounts a channel from storage.objects: 2 MB');
SELECT is(public.bridge_mirror_server_bytes('31000000-0000-0000-0000-000000000052'), 8388608::bigint,
          'and writes the row of a channel that had none');

-- Server deletion ---------------------------------------------------------------------------------
DELETE FROM public.servers WHERE id = '31000000-0000-0000-0000-000000000052';
SELECT is(pg_temp.channel_bytes('31000000-0000-0000-0000-0000000000c2'), NULL, 'a deleted server takes its channels'' rows');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.bridge_mirror_status() ->> 'stored_bytes')::bigint, 2097152::bigint,
          'and leaves the status with server_1''s 2 MB');
SELECT tests.clear_authentication();

-- Transaction ids ---------------------------------------------------------------------------------
-- The transaction id after the last one given out: an aborted subtransaction that wrote moves the
-- snapshot's xmax past its own id.
CREATE TEMP TABLE xid_probe (n int);
CREATE FUNCTION pg_temp.next_xid() RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        INSERT INTO xid_probe VALUES (1);
        RAISE EXCEPTION 'undone';
    EXCEPTION WHEN raise_exception THEN
        NULL;
    END;
    RETURN txid_snapshot_xmax(txid_current_snapshot());
END;
$$;
INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'message_media', format('c/66666666-0000-0000-0000-000000000006/bridge/bulk/%s.png', n), '{"size": 1024}'
  FROM generate_series(1, 200) n;
INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'message_media', format('c/31000000-0000-0000-0000-0000000000ff/bridge/bulk/%s.png', n), '{"size": 1024}'
  FROM generate_series(1, 200) n;
SELECT is(pg_temp.channel_bytes('66666666-0000-0000-0000-000000000006'), (2097152 + 204800)::bigint, '200 files are added');
SELECT set_config('tests.xid_before', pg_temp.next_xid()::text, true) IS NOT NULL AS noted;
DELETE FROM storage.objects WHERE bucket_id = 'message_media' AND name LIKE 'c/%/bridge/bulk/%';
SELECT ok(pg_temp.next_xid() - current_setting('tests.xid_before')::bigint < 100,
          'removing 400 files takes no transaction id per file');
SELECT is(pg_temp.channel_bytes('66666666-0000-0000-0000-000000000006'), 2097152::bigint, 'and subtracts them all');

SELECT * FROM finish();
ROLLBACK;
