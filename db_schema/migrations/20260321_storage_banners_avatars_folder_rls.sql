-- Allow banner/avatar uploads when the first path segment is auth.uid() OR
-- public.get_current_profile_id() (profiles.id). Mismatch between the two UUIDs
-- caused 403 "new row violates row-level security policy" on storage INSERT.

BEGIN;

-- storage.foldername(name)[1] = first path segment (folder) under the bucket

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

COMMIT;

NOTIFY pgrst, 'reload schema';
