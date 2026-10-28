-- 20261101100002_drive_photo_details.sql: drive_files records what the uploading client did
-- with a photo's metadata (user_metadata 'details' / 'location'), forgets it when the bytes are
-- replaced by a client that sends none, and drive_list_files returns it.
--
--   alice    fixture member (01_fixtures.sql), uploads into her own Drive folder
-- queue_federation_job is replaced for the transaction (drive-hash jobs).
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ SELECT gen_random_uuid() $fn$;

CREATE FUNCTION tests.file216(p_name text) RETURNS public.drive_files
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT * FROM public.drive_files WHERE path LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.file216(text) TO authenticated, anon;

INSERT INTO storage.buckets (id, name, public)
VALUES ('message_media', 'message_media', false), ('user_media', 'user_media', true)
ON CONFLICT (id) DO NOTHING;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO storage.objects (bucket_id, name, owner, metadata, user_metadata) VALUES
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/kept.jpg', 'aaaaaaaa-0000-0000-0000-000000000001',
   '{"size": 100, "mimetype": "image/jpeg", "eTag": "e1"}', '{"details": "kept", "location": true, "name": "kept.jpg"}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/removed.jpg', 'aaaaaaaa-0000-0000-0000-000000000001',
   '{"size": 100, "mimetype": "image/jpeg"}', '{"details": "removed", "location": true}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/plain.png', 'aaaaaaaa-0000-0000-0000-000000000001',
   '{"size": 100, "mimetype": "image/png"}', '{"details": "none"}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/old.jpg', 'aaaaaaaa-0000-0000-0000-000000000001',
   '{"size": 100, "mimetype": "image/jpeg"}', '{"name": "old.jpg"}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/odd.jpg', 'aaaaaaaa-0000-0000-0000-000000000001',
   '{"size": 100, "mimetype": "image/jpeg"}', '{"details": "secret", "location": true}');

SELECT is(ARRAY[(tests.file216('kept.jpg')).photo_details, (tests.file216('kept.jpg')).photo_location::text],
  ARRAY['kept', 'true'], 'a kept photo records its details and its location');
SELECT is(ARRAY[(tests.file216('removed.jpg')).photo_details, (tests.file216('removed.jpg')).photo_location::text],
  ARRAY['removed', 'false'], 'a stripped photo carries no location, whatever the client says');
SELECT is(ARRAY[(tests.file216('plain.png')).photo_details, (tests.file216('plain.png')).photo_location::text],
  ARRAY['none', 'false'], 'a photo without details records none');
SELECT is(ARRAY[(tests.file216('old.jpg')).photo_details, (tests.file216('old.jpg')).photo_location::text],
  ARRAY[NULL, NULL]::text[], 'an upload without the fields is unknown');
SELECT is((tests.file216('odd.jpg')).photo_details, NULL, 'an unknown value is not stored');

SELECT is((SELECT file ->> 'photo_details' FROM public.drive_list_files('all', NULL, NULL, 'kept')), 'kept',
  'the owner''s listing returns photo_details');
SELECT is((SELECT file ->> 'photo_location' FROM public.drive_list_files('all', NULL, NULL, 'kept')), 'true',
  'and photo_location');
SELECT tests.clear_authentication();

-- New bytes under the same name (eTag change) replace the record; metadata alone does not.
UPDATE storage.objects SET metadata = '{"size": 90, "mimetype": "image/jpeg", "eTag": "e1"}',
                           user_metadata = '{"details": "removed"}'
 WHERE name = 'u/aaaaaaaa-0000-0000-0000-000000000001/kept.jpg';
SELECT is((tests.file216('kept.jpg')).photo_details, 'kept', 'an update with the same eTag keeps the record');
UPDATE storage.objects SET metadata = '{"size": 90, "mimetype": "image/jpeg", "eTag": "e2"}',
                           user_metadata = '{"details": "removed"}'
 WHERE name = 'u/aaaaaaaa-0000-0000-0000-000000000001/kept.jpg';
SELECT is(ARRAY[(tests.file216('kept.jpg')).photo_details, (tests.file216('kept.jpg')).photo_location::text],
  ARRAY['removed', 'false'], 'new bytes take the new record');
UPDATE storage.objects SET metadata = '{"size": 90, "mimetype": "image/jpeg", "eTag": "e3"}', user_metadata = '{}'
 WHERE name = 'u/aaaaaaaa-0000-0000-0000-000000000001/kept.jpg';
SELECT is((tests.file216('kept.jpg')).photo_details, NULL, 'new bytes from a client that sends nothing are unknown');

SELECT throws_ok($$UPDATE public.drive_files SET photo_details = 'other' WHERE path LIKE '%/plain.png'$$,
  '23514', NULL, 'photo_details takes none, removed or kept');
SELECT ok(NOT has_function_privilege('authenticated', 'public.drive_track_object()', 'EXECUTE'),
  'the trigger function is not callable by clients');

SELECT * FROM finish();
ROLLBACK;
