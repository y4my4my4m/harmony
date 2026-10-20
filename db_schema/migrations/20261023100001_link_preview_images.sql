-- Link preview images hosted by the instance.
--
-- The federation backend copies a link preview's image into this bucket when it builds the
-- preview, and the stored preview names the copy. Readers then load it from the instance
-- instead of the site: no request reaches the site from their address, and an image the site
-- serves to hotlinkers unreliably (GitHub's opengraph.githubassets.com answers cache misses
-- with 429 for 15 minutes) still shows. Raster formats only: an SVG served from this origin
-- would run script when opened directly.
--
-- Writes are the service role's (storage bypasses RLS for it); readers only read.

BEGIN;

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'storage schema absent, link-preview-images bucket skipped';
        RETURN;
    END IF;

    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('link-preview-images', 'link-preview-images', true, 5242880,
            ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
    ON CONFLICT (id) DO UPDATE SET
        public = true,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

    DROP POLICY IF EXISTS "Public read access for link preview images" ON storage.objects;
    CREATE POLICY "Public read access for link preview images" ON storage.objects
        AS PERMISSIVE FOR SELECT TO public
        USING (bucket_id = 'link-preview-images');
END;
$$;

COMMIT;
