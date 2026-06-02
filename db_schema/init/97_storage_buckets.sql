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
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Banners bucket (profile banners/backgrounds)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'banners',
    'banners',
    true,
    10485760, -- 10MB
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']
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
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']
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
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']
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

-- Emojis bucket (custom emoji)
-- NOTE: SVG is intentionally NOT allowed. User-uploaded SVGs are an XSS vector
-- (they can embed <script>, event handlers, foreignObject, etc.), so emoji are
-- restricted to raster image formats only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'emojis',
    'emojis',
    true,
    1048576, -- 1MB
    ARRAY['image/png', 'image/gif', 'image/webp', 'image/apng', 'image/jpeg']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Group icons bucket (group conversation avatars)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'group-icons',
    'group-icons',
    true,
    5242880, -- 5MB
    ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- STORAGE RLS POLICIES (idempotent: DROP IF EXISTS then CREATE)
-- ---------------------------------------------------------------------------

-- RLS is already enabled by default in newer images; this is a no-op / safety net.
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Public read access for all public buckets
DROP POLICY IF EXISTS "Public read access for avatars" ON storage.objects;
CREATE POLICY "Public read access for avatars"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Public read access for banners" ON storage.objects;
CREATE POLICY "Public read access for banners"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'banners');

DROP POLICY IF EXISTS "Public read access for server_icons" ON storage.objects;
CREATE POLICY "Public read access for server_icons"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'server_icons');

DROP POLICY IF EXISTS "Public read access for server_banners" ON storage.objects;
CREATE POLICY "Public read access for server_banners"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'server_banners');

DROP POLICY IF EXISTS "Public read access for user_media" ON storage.objects;
CREATE POLICY "Public read access for user_media"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'user_media');

DROP POLICY IF EXISTS "Public read access for emojis" ON storage.objects;
CREATE POLICY "Public read access for emojis"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'emojis');

-- Authenticated users can upload to avatars (their own folder)
DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
CREATE POLICY "Users can upload their own avatar"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'avatars'
        AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (
                public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text
            )
        )
    );

DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
CREATE POLICY "Users can update their own avatar"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'avatars'
        AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (
                public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text
            )
        )
    );

DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;
CREATE POLICY "Users can delete their own avatar"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'avatars'
        AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (
                public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text
            )
        )
    );

-- Authenticated users can upload to banners (their own folder)
DROP POLICY IF EXISTS "Users can upload their own banner" ON storage.objects;
CREATE POLICY "Users can upload their own banner"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'banners'
        AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (
                public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text
            )
        )
    );

DROP POLICY IF EXISTS "Users can update their own banner" ON storage.objects;
CREATE POLICY "Users can update their own banner"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'banners'
        AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (
                public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text
            )
        )
    );

DROP POLICY IF EXISTS "Users can delete their own banner" ON storage.objects;
CREATE POLICY "Users can delete their own banner"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'banners'
        AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (
                public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text
            )
        )
    );

-- Authenticated users can upload to user_media, but only under their OWN
-- folder. Upload path is {profileId}/{file} (see fileService.ts), so
-- foldername[1] must match the caller. Previously ANY authenticated user could
-- write anywhere in this public bucket (abuse hosting / quota exhaustion).
DROP POLICY IF EXISTS "Authenticated users can upload user_media" ON storage.objects;
CREATE POLICY "Authenticated users can upload user_media"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'user_media'
        AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (
                public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text
            )
        )
    );

DROP POLICY IF EXISTS "Users can update their own user_media" ON storage.objects;
CREATE POLICY "Users can update their own user_media"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'user_media'
        AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (
                public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text
            )
        )
    );

DROP POLICY IF EXISTS "Users can delete their own user_media" ON storage.objects;
CREATE POLICY "Users can delete their own user_media"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'user_media'
        AND auth.role() = 'authenticated'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR (
                public.get_current_profile_id() IS NOT NULL
                AND (storage.foldername(name))[1] = public.get_current_profile_id()::text
            )
        )
    );

-- Server icons/banners: upload path is {serverId}/... and requires MANAGE_SERVER
-- permission on that server (not merely being logged in). Previously any
-- authenticated user could overwrite any server's icon/banner.
DROP POLICY IF EXISTS "Server owners can upload server icons" ON storage.objects;
CREATE POLICY "Server owners can upload server icons"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'server_icons'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_SERVER')
    );

DROP POLICY IF EXISTS "Server owners can update server icons" ON storage.objects;
CREATE POLICY "Server owners can update server icons"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'server_icons'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_SERVER')
    );

DROP POLICY IF EXISTS "Server owners can upload server banners" ON storage.objects;
CREATE POLICY "Server owners can upload server banners"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'server_banners'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_SERVER')
    );

DROP POLICY IF EXISTS "Server owners can update server banners" ON storage.objects;
CREATE POLICY "Server owners can update server banners"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'server_banners'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_SERVER')
    );

-- Emoji upload: path is {serverId}/{uploaderId}/{file}; requires MANAGE_EMOJIS
-- on that server. Previously any authenticated user could upload to any server.
DROP POLICY IF EXISTS "Users can upload emojis" ON storage.objects;
CREATE POLICY "Users can upload emojis"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'emojis'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_EMOJIS')
    );

DROP POLICY IF EXISTS "Users can delete emojis" ON storage.objects;
CREATE POLICY "Users can delete emojis"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'emojis'
        AND public.has_permission(public.get_current_profile_id(), (storage.foldername(name))[1]::uuid, 'MANAGE_EMOJIS')
    );

-- Group icons: public read access
DROP POLICY IF EXISTS "Public read access for group-icons" ON storage.objects;
CREATE POLICY "Public read access for group-icons"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'group-icons');

-- Group icons: conversation participants can upload
-- Upload path is {conversationId}/{filename}, so foldername[1] = conversationId
DROP POLICY IF EXISTS "Group participants can upload group icons" ON storage.objects;
CREATE POLICY "Group participants can upload group icons"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'group-icons'
        AND auth.role() = 'authenticated'
        AND EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = (storage.foldername(name))[1]::uuid
              AND cp.user_id = public.get_current_profile_id()
              AND cp.left_at IS NULL
        )
    );

-- Group icons: conversation participants can update
DROP POLICY IF EXISTS "Group participants can update group icons" ON storage.objects;
CREATE POLICY "Group participants can update group icons"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'group-icons'
        AND auth.role() = 'authenticated'
        AND EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = (storage.foldername(name))[1]::uuid
              AND cp.user_id = public.get_current_profile_id()
              AND cp.left_at IS NULL
        )
    );

-- Group icons: conversation participants can delete
DROP POLICY IF EXISTS "Group participants can delete group icons" ON storage.objects;
CREATE POLICY "Group participants can delete group icons"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'group-icons'
        AND auth.role() = 'authenticated'
        AND EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = (storage.foldername(name))[1]::uuid
              AND cp.user_id = public.get_current_profile_id()
              AND cp.left_at IS NULL
        )
    );

-- ---------------------------------------------------------------------------
-- BUCKET METADATA READ ACCESS
-- ---------------------------------------------------------------------------
-- The `public = true` flag only makes OBJECTS in a bucket downloadable; it does
-- NOT expose the bucket's own row (file_size_limit / allowed_mime_types), which
-- is RLS-gated separately on storage.buckets. Without this, supabase.storage
-- .getBucket() returns nothing for normal clients, so the frontend can't show
-- accurate per-instance size/type limits in upload validation messages.
--
-- We expose metadata for PUBLIC buckets only (id, public, file_size_limit,
-- allowed_mime_types) - all of which are non-sensitive. No custom RPC needed.
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public buckets metadata is readable" ON storage.buckets;
CREATE POLICY "Public buckets metadata is readable"
    ON storage.buckets FOR SELECT
    USING (public = true);

DO $$
BEGIN
    RAISE NOTICE 'Storage buckets and policies created successfully';
END $$;

