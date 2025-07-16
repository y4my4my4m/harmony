-- Storage Bucket RLS Policies
-- This file sets up Row Level Security policies for all storage buckets

-- ============================================================================
-- DROP ALL EXISTING POLICIES FOR STORAGE.OBJECTS TABLE
-- ============================================================================

-- Drop ALL existing policies on storage.objects table (clean slate approach)
DO $$
DECLARE
    policy_record RECORD;
BEGIN
    FOR policy_record IN 
        SELECT policyname 
        FROM pg_policies 
        WHERE tablename = 'objects' 
        AND schemaname = 'storage'
    LOOP
        EXECUTE 'DROP POLICY IF EXISTS "' || policy_record.policyname || '" ON storage.objects';
    END LOOP;
END $$;

-- ============================================================================
-- SERVER_ICONS BUCKET POLICIES
-- ============================================================================

-- Policy 1: Anon and authenticated users can SELECT (view/download) server icons
CREATE POLICY "Anyone can view server icons" ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'server_icons');

-- Policy 2: Only admins and server owners can INSERT server icons
CREATE POLICY "Admins and server owners can upload server icons" ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'server_icons' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns a server (for uploading server icons)
    -- This assumes the path format is: server_id/filename.ext
    EXISTS (
      SELECT 1 FROM servers s
      JOIN profiles p ON s.owner = p.id
      WHERE p.auth_user_id = auth.uid()
      AND s.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- Policy 3: Only admins and server owners can UPDATE server icons
CREATE POLICY "Admins and server owners can update server icons" ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'server_icons' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns the server for this icon
    EXISTS (
      SELECT 1 FROM servers s
      JOIN profiles p ON s.owner = p.id
      WHERE p.auth_user_id = auth.uid()
      AND s.id::text = (storage.foldername(objects.name))[1]
    )
  )
)
WITH CHECK (
  bucket_id = 'server_icons' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns the server for this icon
    EXISTS (
      SELECT 1 FROM servers s
      JOIN profiles p ON s.owner = p.id
      WHERE p.auth_user_id = auth.uid()
      AND s.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- Policy 4: Only admins and server owners can DELETE server icons
CREATE POLICY "Admins and server owners can delete server icons" ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'server_icons' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns the server for this icon
    EXISTS (
      SELECT 1 FROM servers s
      JOIN profiles p ON s.owner = p.id
      WHERE p.auth_user_id = auth.uid()
      AND s.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- ============================================================================
-- EMOJIS BUCKET POLICIES
-- ============================================================================

-- Policy 1: Anon and authenticated users can SELECT (view/download) emojis
CREATE POLICY "Anyone can view emojis" ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'emojis');

-- Policy 2: Only admins and server owners can INSERT emojis
CREATE POLICY "Admins and server owners can upload emojis" ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'emojis' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns a server (for uploading emojis)
    -- This assumes the path format is: server_id/filename.ext
    EXISTS (
      SELECT 1 FROM servers s
      JOIN profiles p ON s.owner = p.id
      WHERE p.auth_user_id = auth.uid()
      AND s.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- Policy 3: Only admins and server owners can UPDATE emojis
CREATE POLICY "Admins and server owners can update emojis" ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'emojis' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns the server for this emoji
    EXISTS (
      SELECT 1 FROM servers s
      JOIN profiles p ON s.owner = p.id
      WHERE p.auth_user_id = auth.uid()
      AND s.id::text = (storage.foldername(objects.name))[1]
    )
  )
)
WITH CHECK (
  bucket_id = 'emojis' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns the server for this emoji
    EXISTS (
      SELECT 1 FROM servers s
      JOIN profiles p ON s.owner = p.id
      WHERE p.auth_user_id = auth.uid()
      AND s.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- Policy 4: Only admins and server owners can DELETE emojis
CREATE POLICY "Admins and server owners can delete emojis" ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'emojis' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns the server for this emoji
    EXISTS (
      SELECT 1 FROM servers s
      JOIN profiles p ON s.owner = p.id
      WHERE p.auth_user_id = auth.uid()
      AND s.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- ============================================================================
-- AVATARS BUCKET POLICIES
-- ============================================================================

-- Policy 1: Anon and authenticated users can SELECT (view/download) avatars
CREATE POLICY "Anyone can view avatars" ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'avatars');

-- Policy 2: Users can INSERT their own avatars, admins can insert any
CREATE POLICY "Users can upload their own avatars" ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'avatars' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user is uploading to their own folder
    -- This assumes the path format is: user_id/filename.ext
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.auth_user_id = auth.uid()
      AND p.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- Policy 3: Users can UPDATE their own avatars, admins can update any
CREATE POLICY "Users can update their own avatars" ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'avatars' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns this avatar
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.auth_user_id = auth.uid()
      AND p.id::text = (storage.foldername(objects.name))[1]
    )
  )
)
WITH CHECK (
  bucket_id = 'avatars' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns this avatar
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.auth_user_id = auth.uid()
      AND p.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- Policy 4: Users can DELETE their own avatars, admins can delete any
CREATE POLICY "Users can delete their own avatars" ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'avatars' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns this avatar
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.auth_user_id = auth.uid()
      AND p.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- ============================================================================
-- USER_MEDIA BUCKET POLICIES
-- ============================================================================

-- Policy 1: Anon and authenticated users can SELECT (view/download) user media
CREATE POLICY "Anyone can view user media" ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'user_media');

-- Policy 2: Users can INSERT their own media, admins can insert any
CREATE POLICY "Users can upload their own media" ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'user_media' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user is uploading to their own folder
    -- This assumes the path format is: user_id/filename.ext
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.auth_user_id = auth.uid()
      AND p.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- Policy 3: Users can UPDATE their own media, admins can update any
CREATE POLICY "Users can update their own media" ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'user_media' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns this media
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.auth_user_id = auth.uid()
      AND p.id::text = (storage.foldername(objects.name))[1]
    )
  )
)
WITH CHECK (
  bucket_id = 'user_media' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns this media
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.auth_user_id = auth.uid()
      AND p.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- Policy 4: Users can DELETE their own media, admins can delete any
CREATE POLICY "Users can delete their own media" ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'user_media' AND (
    -- Check if user is admin
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.auth_user_id = auth.uid() 
      AND profiles.is_admin = true
    )
    OR
    -- Check if user owns this media
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.auth_user_id = auth.uid()
      AND p.id::text = (storage.foldername(objects.name))[1]
    )
  )
);

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- You can run this to verify the policies were created:
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual 
-- FROM pg_policies 
-- WHERE tablename = 'objects' 
-- ORDER BY policyname;
