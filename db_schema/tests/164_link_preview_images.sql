-- 20261023100001_link_preview_images.sql: link preview images hosted by the instance.
--
-- The federation backend writes as the service role; everyone reads; nobody else writes.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(8);
SELECT set_config('storage.allow_delete_query', 'true', true);

SELECT is((SELECT public FROM storage.buckets WHERE id = 'link-preview-images'), true,
          'the bucket is public');
SELECT is((SELECT file_size_limit FROM storage.buckets WHERE id = 'link-preview-images'), 5242880::bigint,
          'it holds images up to 5 MB');
SELECT ok((SELECT NOT ('image/svg+xml' = ANY (allowed_mime_types)) FROM storage.buckets WHERE id = 'link-preview-images'),
          'it admits no SVG');

INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('link-preview-images', 'ab/ab164.png', '{"size": 2000}');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty(
    $q$SELECT id FROM storage.objects WHERE bucket_id = 'link-preview-images' AND name = 'ab/ab164.png'$q$,
    'a member reads a preview image');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name) VALUES ('link-preview-images', 'cd/cd164.png')$q$,
    '42501', NULL, 'a member cannot store one');
SELECT is_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'link-preview-images' AND name = 'ab/ab164.png' RETURNING id$q$,
    'nor delete one');

SELECT tests.clear_authentication();
SET LOCAL ROLE anon;
SELECT isnt_empty(
    $q$SELECT id FROM storage.objects WHERE bucket_id = 'link-preview-images' AND name = 'ab/ab164.png'$q$,
    'a signed-out reader reads it');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name) VALUES ('link-preview-images', 'ef/ef164.png')$q$,
    '42501', NULL, 'and cannot store one');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
