BEGIN;

-- Create the group-icons storage bucket
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

-- Public read
DROP POLICY IF EXISTS "Public read access for group-icons" ON storage.objects;
CREATE POLICY "Public read access for group-icons"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'group-icons');

-- Participants can upload (path = {conversationId}/{filename})
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

-- Participants can update
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

-- Participants can delete
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

NOTIFY pgrst, 'reload schema';

COMMIT;
