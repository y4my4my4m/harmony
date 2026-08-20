BEGIN;

-- Rename 'backgrounds' bucket to 'banners' to match frontend code
-- The code uses .from('banners') everywhere, but the bucket was named 'backgrounds'

-- Create the banners bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'banners',
    'banners',
    true,
    10485760,
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Copy objects from backgrounds to banners (if any exist)
INSERT INTO storage.objects (bucket_id, name, owner, created_at, updated_at, metadata, version)
SELECT 'banners', name, owner, created_at, updated_at, metadata, version
FROM storage.objects
WHERE bucket_id = 'backgrounds'
ON CONFLICT DO NOTHING;

-- Drop old policies for backgrounds bucket
DROP POLICY IF EXISTS "Public read access for backgrounds" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own background" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own background" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own background" ON storage.objects;

-- Create policies for banners bucket (idempotent: DROP IF EXISTS then CREATE)
DROP POLICY IF EXISTS "Public read access for banners" ON storage.objects;
CREATE POLICY "Public read access for banners"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'banners');

DROP POLICY IF EXISTS "Users can upload their own banner" ON storage.objects;
CREATE POLICY "Users can upload their own banner"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'banners'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

DROP POLICY IF EXISTS "Users can update their own banner" ON storage.objects;
CREATE POLICY "Users can update their own banner"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'banners'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

DROP POLICY IF EXISTS "Users can delete their own banner" ON storage.objects;
CREATE POLICY "Users can delete their own banner"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'banners'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

COMMIT;
