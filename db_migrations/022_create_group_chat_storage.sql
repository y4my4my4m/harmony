-- Migration 022: Create Group Chat Storage Infrastructure
-- 
-- SETUP: Storage bucket and policies for group chat icons
-- FOLLOWS: Same pattern as server icons for consistency

-- =====================================================
-- STEP 1: Create storage bucket for group chat icons
-- =====================================================

-- Create the bucket for group chat icons
INSERT INTO storage.buckets (id, name, public)
VALUES ('group-icons', 'group-icons', true)
ON CONFLICT (id) DO NOTHING;

-- =====================================================
-- STEP 2: Create storage policies for group chat icons
-- =====================================================

-- Policy: Allow authenticated users to view group icons
CREATE POLICY "Allow public read access to group icons"
ON storage.objects FOR SELECT
USING (bucket_id = 'group-icons');

-- Policy: Allow conversation participants to upload group icons
CREATE POLICY "Allow conversation participants to upload group icons"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'group-icons'
  AND auth.uid() IS NOT NULL
  AND (
    -- Check if user is a participant in the conversation
    -- The object name should be in format: {conversation_id}/{filename}
    EXISTS (
      SELECT 1 FROM conversation_participants cp
      WHERE cp.conversation_id = (split_part(name, '/', 1))::uuid
        AND cp.user_id IN (
          SELECT id FROM profiles WHERE auth_user_id = auth.uid() --TODO: federated users wont be able to update it 
        )
        AND cp.left_at IS NULL
    )
  )
);

-- Policy: Allow conversation participants to update group icons
CREATE POLICY "Allow conversation participants to update group icons"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'group-icons'
  AND auth.uid() IS NOT NULL
  AND (
    -- Check if user is a participant in the conversation
    EXISTS (
      SELECT 1 FROM conversation_participants cp
      WHERE cp.conversation_id = (split_part(name, '/', 1))::uuid
        AND cp.user_id IN (
          SELECT id FROM profiles WHERE auth_user_id = auth.uid() --TODO: federated users wont be able to upload it 
        )
        AND cp.left_at IS NULL
    )
  )
);

-- Policy: Allow conversation participants to delete group icons
CREATE POLICY "Allow conversation participants to delete group icons"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'group-icons'
  AND auth.uid() IS NOT NULL
  AND (
    -- Check if user is a participant in the conversation
    EXISTS (
      SELECT 1 FROM conversation_participants cp
      WHERE cp.conversation_id = (split_part(name, '/', 1))::uuid
        AND cp.user_id IN (
          SELECT id FROM profiles WHERE auth_user_id = auth.uid() --TODO: federated users wont be able to delete it 
        )
        AND cp.left_at IS NULL
    )
  )
);

-- =====================================================
-- STEP 3: Create helper function for group icon management
-- =====================================================

-- Function to update group icon in conversation metadata
CREATE OR REPLACE FUNCTION update_group_icon(
  conversation_uuid UUID,
  icon_path TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Update the conversation metadata with the new icon path
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('icon_url', icon_path),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  -- Return true if update was successful
  RETURN FOUND;
END;
$$;

-- Function to update group name
CREATE OR REPLACE FUNCTION update_group_name(
  conversation_uuid UUID,
  new_name TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Update the conversation name
  UPDATE conversations 
  SET 
    name = new_name,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  -- Return true if update was successful
  RETURN FOUND;
END;
$$;

-- =====================================================
-- STEP 4: Verification
-- =====================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 022 completed successfully!';
  RAISE NOTICE 'Created:';
  RAISE NOTICE '  ✅ group-icons storage bucket';
  RAISE NOTICE '  ✅ Storage policies for group icon management';
  RAISE NOTICE '  ✅ Helper functions for updating group icons and names';
  RAISE NOTICE '';
  RAISE NOTICE 'GROUP CHAT STORAGE INFRASTRUCTURE IS READY';
END $$;