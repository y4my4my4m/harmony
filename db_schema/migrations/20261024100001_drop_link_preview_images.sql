-- Link preview images load from the site again: the bucket link-preview-images
-- (20261023100001) and its read policy are removed.
--
-- Its objects are deleted through the Storage API first on hosts with an S3 backend (prod,
-- R2), which removes the stored files; a row deleted here leaves its file in the backend.

BEGIN;

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'storage schema absent, link-preview-images removal skipped';
        RETURN;
    END IF;

    DROP POLICY IF EXISTS "Public read access for link preview images" ON storage.objects;
    -- Newer storage schemas refuse direct DELETE on objects unless this is set, as storage-api does.
    PERFORM set_config('storage.allow_delete_query', 'true', true);
    DELETE FROM storage.objects WHERE bucket_id = 'link-preview-images';
    DELETE FROM storage.buckets WHERE id = 'link-preview-images';
END;
$$;

COMMIT;
