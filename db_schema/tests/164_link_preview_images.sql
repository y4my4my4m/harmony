-- 20261023100001_link_preview_images.sql added a bucket for link preview images;
-- 20261024100001_drop_link_preview_images.sql removed it: previews name the site's image.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(2);

SELECT is_empty(
    $q$SELECT id FROM storage.buckets WHERE id = 'link-preview-images'$q$,
    'no link-preview-images bucket');
SELECT is_empty(
    $q$SELECT policyname FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'Public read access for link preview images'$q$,
    'no policy for it on storage.objects');

SELECT * FROM finish();
ROLLBACK;
