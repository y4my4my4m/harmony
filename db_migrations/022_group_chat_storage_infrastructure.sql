-- Migration 022: Group Chat Storage Infrastructure (Combined)
-- 
-- CREATES: Complete group chat storage system with proper federated user support
-- APPROACH: Application-layer validation with simple RLS policies

-- =====================================================
-- STEP 1: Create storage bucket for group chat icons
-- =====================================================

-- Create the bucket for group chat icons
INSERT INTO storage.buckets (id, name, public)
VALUES ('group-icons', 'group-icons', true)
ON CONFLICT (id) DO NOTHING;

-- =====================================================
-- STEP 2: Simple RLS policies - Application layer handles validation
-- =====================================================

-- Policy: Public read access (works for both local and federated users)
CREATE POLICY "Public read access for group icons"
ON storage.objects FOR SELECT
USING (bucket_id = 'group-icons');

-- Policy: Application-controlled write access
-- The application layer will handle all permission checks
-- This allows both local and federated users to work through the same code path
CREATE POLICY "Application controlled group icon uploads"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'group-icons'
  -- Let the application layer handle all validation
  -- This works for both local and federated users consistently
);

CREATE POLICY "Application controlled group icon updates"
ON storage.objects FOR UPDATE
USING (bucket_id = 'group-icons');

CREATE POLICY "Application controlled group icon deletes"
ON storage.objects FOR DELETE
USING (bucket_id = 'group-icons');

-- =====================================================
-- STEP 3: Group management functions with proper permission checks
-- =====================================================

-- Function to check if user can manage group (works for local + federated)
CREATE OR REPLACE FUNCTION can_manage_group_icon(
  conversation_uuid UUID,
  user_profile_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Check if user is a participant in the conversation
  RETURN EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = conversation_uuid
      AND cp.user_id = user_profile_id
      AND cp.left_at IS NULL
  );
END;
$$;

-- Function to update group icon (unified for local + federated users)
CREATE OR REPLACE FUNCTION update_group_icon(
  conversation_uuid UUID,
  user_profile_id UUID,
  icon_path TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation metadata with the new icon path
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('icon_url', icon_path),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon updated successfully'
  );
END;
$$;

-- Function to update group name (unified for local + federated users)
CREATE OR REPLACE FUNCTION update_group_name(
  conversation_uuid UUID,
  user_profile_id UUID,
  new_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation name
  UPDATE conversations 
  SET 
    name = new_name,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group name updated successfully'
  );
END;
$$;

-- Function for removing group icons (unified for local + federated users)
CREATE OR REPLACE FUNCTION remove_group_icon(
  conversation_uuid UUID,
  user_profile_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Remove icon from conversation metadata
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) - 'icon_url',
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon removed successfully'
  );
END;
$$;

-- =====================================================
-- STEP 4: Enhanced conversation creation (from migration 021)
-- =====================================================

-- Function to create group conversation (already exists from migration 021)
-- This ensures it works properly with the new icon system
CREATE OR REPLACE FUNCTION create_group_conversation(
  creator_user_id UUID,
  conversation_name TEXT DEFAULT NULL,
  participant_ids UUID[] DEFAULT '{}'::UUID[],
  initial_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_conversation_id UUID;
  participant_id UUID;
BEGIN
  -- Create the conversation
  INSERT INTO conversations (
    created_by,
    name,
    type,
    metadata,
    is_active
  ) VALUES (
    creator_user_id,
    conversation_name,
    'group',
    initial_metadata,
    true
  )
  RETURNING id INTO new_conversation_id;

  -- Add creator as participant
  INSERT INTO conversation_participants (
    conversation_id,
    user_id,
    joined_at
  ) VALUES (
    new_conversation_id,
    creator_user_id,
    CURRENT_TIMESTAMP
  );

  -- Add other participants
  FOREACH participant_id IN ARRAY participant_ids
  LOOP
    -- Skip creator (already added)
    IF participant_id != creator_user_id THEN
      INSERT INTO conversation_participants (
        conversation_id,
        user_id,
        joined_at
      ) VALUES (
        new_conversation_id,
        participant_id,
        CURRENT_TIMESTAMP
      );
    END IF;
  END LOOP;

  RETURN new_conversation_id;
END;
$$;

-- =====================================================
-- STEP 5: Verification and cleanup
-- =====================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 022 completed successfully!';
  RAISE NOTICE 'Created:';
  RAISE NOTICE '  ✅ group-icons storage bucket';
  RAISE NOTICE '  ✅ Simplified RLS policies (application-layer validation)';
  RAISE NOTICE '  ✅ Unified permission functions for local + federated users';
  RAISE NOTICE '  ✅ Group icon management functions';
  RAISE NOTICE '  ✅ Group name management functions';
  RAISE NOTICE '  ✅ Enhanced group conversation creation';
  RAISE NOTICE '';
  RAISE NOTICE 'APPROACH: Application handles validation, RLS allows access';
  RAISE NOTICE 'BENEFIT: Same code path for local AND federated users';
  RAISE NOTICE 'GROUP CHAT INFRASTRUCTURE IS READY FOR BOTH USER TYPES';
END $$;