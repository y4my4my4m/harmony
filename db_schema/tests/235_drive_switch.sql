-- Drive switch from 20261106500001_drive_switch.sql: instance_config.drive_enabled off keeps
-- every upload, refuses none for storage, stops expiry, closes shares and links.
--
--   alice    (aaaaaaaa / 11111111) uploads, shares
--   bob      (bbbbbbbb / 22222222) quota of 500 bytes, share target
-- queue_federation_job is replaced for the transaction; drive-hash jobs are not under test.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(16);

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE sql AS $fn$ SELECT gen_random_uuid() $fn$;

CREATE FUNCTION tests.file235(p_name text) RETURNS public.drive_files
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT * FROM public.drive_files WHERE path LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.file235(text) TO authenticated, anon;

CREATE FUNCTION tests.reads235(p_name text) RETURNS integer
LANGUAGE sql SET search_path = public, pg_temp AS $fn$
  SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'message_media' AND name LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.reads235(text) TO authenticated, anon;

INSERT INTO storage.buckets (id, name, public)
VALUES ('message_media', 'message_media', false)
ON CONFLICT (id) DO NOTHING;

SELECT is(public.drive_enabled(), true, 'Drive is on by default');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((public.get_my_drive_usage() ->> 'enabled')::boolean, true, 'and the usage says so');
SELECT tests.clear_authentication();

-- Setup while on: a share and a link of alice's file, an expired temporary file of bob.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/shared.txt',
   'aaaaaaaa-0000-0000-0000-000000000001', '{"size": 10, "mimetype": "text/plain"}');
SELECT public.drive_share_file((tests.file235('shared.txt')).id, 'user', '22222222-0000-0000-0000-000000000002');
CREATE TEMP TABLE l235 AS SELECT public.drive_link_create((tests.file235('shared.txt')).id) ->> 'token' AS token;
GRANT SELECT ON l235 TO anon, authenticated;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.reads235('shared.txt'), 1, 'on, the share admits its target');
INSERT INTO storage.objects (bucket_id, name, owner, metadata, user_metadata) VALUES
  ('message_media', 'u/bbbbbbbb-0000-0000-0000-000000000002/old.bin',
   'bbbbbbbb-0000-0000-0000-000000000002', '{"size": 10}', '{"ephemeral": true}');
SELECT tests.clear_authentication();
UPDATE public.drive_files SET expires_at = now() - interval '1 minute' WHERE path LIKE '%/old.bin';

-- Off. ----------------------------------------------------------------------------------
UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'drive_enabled';
UPDATE public.instance_config SET config_value = '0' WHERE config_key = 'drive_ephemeral_daily_mb';
INSERT INTO public.drive_quota_overrides (profile_id, quota_bytes) VALUES ('22222222-0000-0000-0000-000000000002', 500)
ON CONFLICT (profile_id) DO UPDATE SET quota_bytes = 500;
SELECT is(public.drive_enabled(), false, 'drive_enabled false turns Drive off');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((public.get_my_drive_usage() ->> 'enabled')::boolean, false, 'the usage says Drive is off');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, owner, metadata, user_metadata) VALUES
       ('message_media', 'c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/big.bin',
        'bbbbbbbb-0000-0000-0000-000000000002', '{"size": 100000}', '{"ephemeral": true}')$q$,
    'an upload past the quota with the daily allowance used is accepted');
SELECT is((tests.file235('big.bin')).state, 'drive', 'and kept, though it asked to be temporary');
SELECT ok((tests.file235('big.bin')).expires_at IS NULL AND NOT (tests.file235('big.bin')).ephemeral_at_upload,
  'it never expires');
SELECT ok(public.drive_can_upload(), 'drive_can_upload holds over quota');
SELECT is(tests.reads235('shared.txt'), 0, 'a share admits nobody');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.drive_share_file((tests.file235('shared.txt')).id, 'user', '22222222-0000-0000-0000-000000000002')$q$,
    '42501'::char(5), 'Drive is turned off on this instance', 'files cannot be shared');
SELECT is(tests.reads235('shared.txt'), 1, 'the owner still reads the file');
SELECT tests.authenticate_as_anon();
SELECT is(public.drive_link_resolve((SELECT token FROM l235)), NULL, 'links resolve to nothing');
SELECT tests.clear_authentication();
SELECT is(public.drive_expire_due(), 0, 'temporary files do not expire');
SELECT is((tests.file235('old.bin')).state, 'ephemeral', 'the expired temporary file is still there');

-- On again. -----------------------------------------------------------------------------
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'drive_enabled';
SELECT is(public.drive_expire_due(), 1, 'turned on again, the past-due file expires on the next run');

SELECT * FROM finish();
ROLLBACK;
