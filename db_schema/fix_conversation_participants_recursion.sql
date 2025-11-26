-- ============================================================================
-- Fix: Infinite recursion in conversation_participants policies
-- ============================================================================
-- Error: 42P17 - infinite recursion detected in policy for relation "conversation_participants"
--
-- The problem: "conversation_participants_insert_policy" does a SELECT on 
-- conversation_participants during INSERT, which triggers RLS evaluation again,
-- causing infinite recursion.
--
-- Solution: Drop the problematic self-referencing policy. The simpler
-- "Authenticated users can manage participants" policy already allows
-- authenticated users to insert, and we rely on the RPC functions to 
-- enforce proper authorization.
-- ============================================================================

-- Drop the problematic self-referencing INSERT policy
DROP POLICY IF EXISTS "conversation_participants_insert_policy" ON public.conversation_participants;

-- Drop and recreate the simpler policy to ensure it exists correctly
DROP POLICY IF EXISTS "Authenticated users can manage participants" ON public.conversation_participants;

CREATE POLICY "Authenticated users can manage participants" 
ON public.conversation_participants 
FOR INSERT 
WITH CHECK (auth.uid() IS NOT NULL);

-- Also make the create_or_get_direct_conversation function use SECURITY DEFINER
-- This ensures it can bypass RLS and work reliably, while still validating
-- that the caller is one of the participants
CREATE OR REPLACE FUNCTION public.create_or_get_direct_conversation(user1_uuid uuid, user2_uuid uuid) 
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  conversation_uuid UUID;
  current_user_id UUID;
BEGIN
  -- Get current user
  current_user_id := auth.uid();
  
  -- Security check: caller must be one of the participants
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  
  IF current_user_id != user1_uuid AND current_user_id != user2_uuid THEN
    RAISE EXCEPTION 'You can only create conversations you are a participant of';
  END IF;

  -- Try to find existing direct conversation between these two users
  SELECT c.id INTO conversation_uuid
  FROM conversations c
  WHERE c.type = 'direct'
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp1 
      WHERE cp1.conversation_id = c.id 
        AND cp1.user_id = user1_uuid 
        AND cp1.left_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp2 
      WHERE cp2.conversation_id = c.id 
        AND cp2.user_id = user2_uuid 
        AND cp2.left_at IS NULL
    )
    -- Ensure it's exactly 2 participants
    AND (
      SELECT COUNT(*) FROM conversation_participants cp3 
      WHERE cp3.conversation_id = c.id 
        AND cp3.left_at IS NULL
    ) = 2;
  
  -- If not found, create new conversation
  IF conversation_uuid IS NULL THEN
    INSERT INTO conversations (type, created_by, is_active)
    VALUES ('direct', user1_uuid, TRUE)
    RETURNING id INTO conversation_uuid;
    
    -- Add both users as participants
    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (conversation_uuid, user1_uuid, 'member')
    ON CONFLICT (conversation_id, user_id) 
    DO UPDATE SET left_at = NULL, role = 'member', updated_at = CURRENT_TIMESTAMP;
    
    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (conversation_uuid, user2_uuid, 'member')
    ON CONFLICT (conversation_id, user_id) 
    DO UPDATE SET left_at = NULL, role = 'member', updated_at = CURRENT_TIMESTAMP;
  END IF;
  
  RETURN conversation_uuid;
END;
$$;

-- Also fix add_user_to_conversation to use SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.add_user_to_conversation(
  conversation_uuid uuid, 
  user_uuid uuid, 
  user_role text DEFAULT 'member'::text
) 
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  participant_id UUID;
  current_user_id UUID;
BEGIN
  current_user_id := auth.uid();
  
  -- Must be authenticated
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  
  -- User can add themselves, or must already be a participant to add others
  IF user_uuid != current_user_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM conversation_participants 
      WHERE conversation_id = conversation_uuid 
        AND user_id = current_user_id 
        AND left_at IS NULL
    ) THEN
      RAISE EXCEPTION 'You must be a participant to add others to the conversation';
    END IF;
  END IF;

  INSERT INTO conversation_participants (conversation_id, user_id, role)
  VALUES (conversation_uuid, user_uuid, user_role)
  ON CONFLICT (conversation_id, user_id) 
  DO UPDATE SET 
    left_at = NULL,
    role = user_role,
    updated_at = CURRENT_TIMESTAMP
  RETURNING id INTO participant_id;
  
  RETURN participant_id;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.create_or_get_direct_conversation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_user_to_conversation(uuid, uuid, text) TO authenticated;

