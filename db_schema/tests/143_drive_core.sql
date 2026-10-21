-- Drive tracking, quotas and access from 20261015100001_drive_core.sql.
--
--   alice    owns server_1, participant in the DM
--   bob      member of server_1, participant in the DM
--   carol    (cccccccc) in no server and no conversation
--   remote   remote member of server_1 on remote143.example
-- queue_federation_job is replaced for the transaction so queued jobs can be read back.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(35);

-- Remote instances read a server's media only with federation on (166_federation_off_closes_group.sql).
UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT set_config('storage.allow_delete_query', 'true', true);

CREATE TABLE tests.jobs143 (name text, data jsonb);
GRANT INSERT, SELECT ON tests.jobs143 TO authenticated, anon;
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs143 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

CREATE FUNCTION tests.file143(p_name text) RETURNS public.drive_files
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT * FROM public.drive_files WHERE path LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.file143(text) TO authenticated, anon;

CREATE FUNCTION tests.reads143(p_name text) RETURNS integer
LANGUAGE sql SET search_path = public, pg_temp AS $fn$
  SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'message_media' AND name LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.reads143(text) TO authenticated, anon;

INSERT INTO storage.buckets (id, name, public)
VALUES ('message_media', 'message_media', false), ('user_media', 'user_media', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url)
VALUES ('f1430000-0000-0000-0000-000000000001', 'remote143', 'Remote', false, 'remote143.example',
        'https://remote143.example/users/r', 'https://remote143.example/users/r/inbox');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('f1430000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'accepted');

-- Tracking. -----------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO storage.objects (bucket_id, name, owner, metadata, user_metadata) VALUES
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/photo.png',
   'aaaaaaaa-0000-0000-0000-000000000001', '{"size": 1000, "mimetype": "image/png"}',
   jsonb_build_object('name', ' holiday/photo.png ', 'sha256', repeat('ab', 32))),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/notes.txt',
   'aaaaaaaa-0000-0000-0000-000000000001', '{"size": 10, "mimetype": "text/plain"}', '{"ephemeral": true}');

SELECT is((tests.file143('photo.png')).owner_id, '11111111-0000-0000-0000-000000000001'::uuid,
  'an upload is a Drive file of its uploader''s profile');
SELECT is((tests.file143('photo.png')).name, 'holiday photo.png',
  'the name comes from user_metadata, trimmed and without slashes');
SELECT is((tests.file143('photo.png')).sha256, repeat('ab', 32), 'the claimed hash is recorded');
SELECT ok((tests.file143('photo.png')).state = 'drive' AND NOT (tests.file143('photo.png')).sha256_verified,
  'it is kept in Drive, its hash not verified yet');
SELECT ok((tests.file143('notes.txt')).state = 'ephemeral'
          AND (tests.file143('notes.txt')).expires_at BETWEEN now() + interval '29 days' AND now() + interval '31 days',
  'an upload asking to be ephemeral expires in drive_ephemeral_days');
SELECT is((SELECT count(*)::int FROM tests.jobs143 WHERE name = 'drive-hash'), 2,
  'each upload queues a server hash');

SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name) VALUES ('message_media', 'u/bbbbbbbb-0000-0000-0000-000000000002/x.txt')$q$,
    '42501'::char(5), NULL, 'nobody uploads into another account''s Drive folder');

-- Quota. --------------------------------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.drive_quota_overrides (profile_id, quota_bytes) VALUES ('22222222-0000-0000-0000-000000000002', 1500);
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/first.bin', '{"size": 1000}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/second.bin', '{"size": 1000}');
SELECT is((tests.file143('first.bin')).state, 'drive', 'an upload within the quota is kept');
SELECT is((tests.file143('second.bin')).state, 'ephemeral', 'an upload past the quota is ephemeral');
SELECT tests.clear_authentication();
SELECT ok(public.drive_used_bytes('22222222-0000-0000-0000-000000000002') = 1000,
  'ephemeral files do not count toward the quota');

SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '0' WHERE config_key = 'drive_ephemeral_daily_mb';
INSERT INTO public.drive_quota_overrides (profile_id, quota_bytes) VALUES ('22222222-0000-0000-0000-000000000002', 500)
ON CONFLICT (profile_id) DO UPDATE SET quota_bytes = 500;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, metadata)
       VALUES ('message_media', 'c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/third.bin', '{"size": 10}')$q$,
    '42501'::char(5), NULL, 'over quota with the daily ephemeral allowance used, uploads are refused');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '2048' WHERE config_key = 'drive_ephemeral_daily_mb';
DELETE FROM public.drive_quota_overrides WHERE profile_id = '22222222-0000-0000-0000-000000000002';

-- Verified duplicates count once.
UPDATE public.drive_files SET sha256 = repeat('cd', 32), sha256_verified = true, state = 'drive', expires_at = NULL
 WHERE path LIKE '%/bbbbbbbb-0000-0000-0000-000000000002/%.bin';
SELECT is(public.drive_used_bytes('22222222-0000-0000-0000-000000000002'), 1000::bigint,
  'files with the same verified hash count once');

-- A blocked hash. ------------------------------------------------------------------------
INSERT INTO public.drive_blocked_hashes (sha256, reason) VALUES (repeat('ef', 32), 'test');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, user_metadata)
       VALUES ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/bad.bin', jsonb_build_object('sha256', repeat('ef', 32)))$q$,
    '42501'::char(5), 'This file was removed by the instance moderators', 'an upload claiming a blocked hash is refused');

-- Read access. ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.reads143('photo.png'), 0, 'a member cannot read an upload no message names');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f1431000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","fileType":"image","url":"","fileName":"other.png","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/photo.png"}]');
SELECT is((tests.file143('photo.png')).name, 'holiday photo.png', 'a message does not rename a named file');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.reads143('photo.png'), 1, 'a member reads a file a live message in the channel names');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(tests.reads143('photo.png'), 0, 'a non-member does not');

-- Reuse in the DM by its owner; the channel message goes away.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO public.messages (id, conversation_id, user_id, content) VALUES
       ('f1431000-0000-0000-0000-000000000002', '77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
        '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/photo.png"}]')$q$,
    'the owner sends her Drive file into another room without uploading it again');
UPDATE public.messages SET is_deleted = true, content = '[{"type":"text","text":"[deleted]"}]'
 WHERE id = 'f1431000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.reads143('photo.png'), 1, 'the DM still names it: its participant reads it');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content) VALUES
       ('77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002',
        '[{"type":"file","fileType":"image","url":"","path":"u/aaaaaaaa-0000-0000-0000-000000000001/notes.txt"}]')$q$,
    '42501'::char(5), NULL, 'nobody sends another account''s Drive file');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.messages SET is_deleted = true, content = '[{"type":"text","text":"[deleted]"}]'
 WHERE id = 'f1431000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.reads143('photo.png'), 0, 'with no live message naming it the room loses access');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.reads143('photo.png'), 1, 'the owner keeps it');

-- Explicit shares.
SELECT tests.clear_authentication();
INSERT INTO public.drive_shares (file_id, scope, target_id)
SELECT id, 'user', '22222222-0000-0000-0000-000000000002' FROM public.drive_files WHERE path LIKE '%/photo.png';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.reads143('photo.png'), 1, 'a user share admits its target');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(tests.reads143('photo.png'), 0, 'and nobody else');
SELECT tests.clear_authentication();
UPDATE public.drive_files SET state = 'trashed', trashed_at = now() WHERE path LIKE '%/photo.png';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.reads143('photo.png'), 0, 'a trashed file admits nobody but its owner');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content) VALUES
       ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
        '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/photo.png"}]')$q$,
    '42501'::char(5), NULL, 'a trashed file cannot be sent');
SELECT tests.clear_authentication();
UPDATE public.drive_files SET state = 'drive', trashed_at = NULL WHERE path LIKE '%/photo.png';

-- Names from messages. -------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/unnamed.pdf', '{"size": 5}');
INSERT INTO public.messages (channel_id, user_id, content) VALUES
  ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","fileType":"file","url":"","fileName":"report.pdf","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/unnamed.pdf"}]');
SELECT is((tests.file143('unnamed.pdf')).name, 'report.pdf', 'an unnamed file takes the name its first message gives it');

-- Federation. ----------------------------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('message_media', 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm-only.png', '{"size": 5}');
SELECT ok(NOT public.federation_media_access(
              'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm-only.png', 'remote143.example'),
  'a DM object is not served to a server member''s instance');
INSERT INTO public.messages (channel_id, user_id, content) VALUES
  ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","fileType":"image","url":"","path":"d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm-only.png"}]');
SELECT ok(public.federation_media_access(
              'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm-only.png', 'remote143.example'),
  'once a channel message names it, the channel''s remote instances read it');

-- Deletion and the sweep. ---------------------------------------------------------------
SELECT ok('c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/photo.png'
          NOT IN (SELECT public.message_media_deletable(NULL, interval '0')),
  'the sweep keeps a Drive file no message names');
SELECT ok('u/aaaaaaaa-0000-0000-0000-000000000001/notes.txt'
          NOT IN (SELECT public.message_media_deletable(NULL, interval '0')),
  'the sweep keeps an ephemeral Drive upload until it expires');
DELETE FROM storage.objects WHERE bucket_id = 'message_media'
   AND name = 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/unnamed.pdf';
SELECT ok((tests.file143('unnamed.pdf')).state = 'gone' AND (tests.file143('unnamed.pdf')).gone_reason = 'deleted',
  'deleting the object leaves a gone row');

-- Privileges. ----------------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.drive_files', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.drive_files', 'UPDATE')
          AND NOT has_table_privilege('anon', 'public.drive_files', 'SELECT'),
  'clients write Drive rows only through functions; anon reads none');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.drive_files WHERE owner_id = '11111111-0000-0000-0000-000000000001'), 0,
  'an account reads only its own Drive rows');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.drive_used_bytes('22222222-0000-0000-0000-000000000002')$q$,
    '42501'::char(5), NULL, 'usage of another account is not callable by clients');

SELECT * FROM finish();
ROLLBACK;
