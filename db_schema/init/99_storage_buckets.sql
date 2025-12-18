-- =============================================================================
-- Harmony Database Schema - Storage Buckets
-- =============================================================================
-- Create storage buckets and their RLS policies
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CREATE BUCKETS
-- ---------------------------------------------------------------------------

-- Avatars bucket (profile pictures)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'avatars',
    'avatars',
    true,
    5242880, -- 5MB
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Backgrounds bucket (profile backgrounds/banners)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'backgrounds',
    'backgrounds',
    true,
    10485760, -- 10MB
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Server icons bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'server_icons',
    'server_icons',
    true,
    5242880, -- 5MB
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Server banners bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'server_banners',
    'server_banners',
    true,
    10485760, -- 10MB
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- User media bucket (message attachments, uploads)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'user_media',
    'user_media',
    true,
    52428800, -- 50MB
    NULL -- Allow all file types
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit;

-- Emoji bucket (custom emoji)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'emoji',
    'emoji',
    true,
    1048576, -- 1MB
    ARRAY['image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- STORAGE RLS POLICIES
-- ---------------------------------------------------------------------------

-- Enable RLS on storage.objects
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Public read access for all public buckets
CREATE POLICY "Public read access for avatars"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'avatars');

CREATE POLICY "Public read access for backgrounds"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'backgrounds');

CREATE POLICY "Public read access for server_icons"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'server_icons');

CREATE POLICY "Public read access for server_banners"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'server_banners');

CREATE POLICY "Public read access for user_media"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'user_media');

CREATE POLICY "Public read access for emoji"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'emoji');

-- Authenticated users can upload to avatars (their own folder)
CREATE POLICY "Users can upload their own avatar"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'avatars'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

CREATE POLICY "Users can update their own avatar"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'avatars'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

CREATE POLICY "Users can delete their own avatar"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'avatars'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Authenticated users can upload to backgrounds (their own folder)
CREATE POLICY "Users can upload their own background"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'backgrounds'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

CREATE POLICY "Users can update their own background"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'backgrounds'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

CREATE POLICY "Users can delete their own background"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'backgrounds'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Authenticated users can upload to user_media
CREATE POLICY "Authenticated users can upload user_media"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'user_media'
        AND auth.role() = 'authenticated'
    );

-- Server owners can upload server icons/banners
-- (Uses server_id as folder name)
CREATE POLICY "Server owners can upload server icons"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'server_icons'
        AND auth.role() = 'authenticated'
    );

CREATE POLICY "Server owners can update server icons"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'server_icons'
        AND auth.role() = 'authenticated'
    );

CREATE POLICY "Server owners can upload server banners"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'server_banners'
        AND auth.role() = 'authenticated'
    );

CREATE POLICY "Server owners can update server banners"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'server_banners'
        AND auth.role() = 'authenticated'
    );

-- Emoji upload (server owners or global)
CREATE POLICY "Users can upload emoji"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'emoji'
        AND auth.role() = 'authenticated'
    );

DO $$
BEGIN
    RAISE NOTICE 'Storage buckets and policies created successfully';
END $$;

