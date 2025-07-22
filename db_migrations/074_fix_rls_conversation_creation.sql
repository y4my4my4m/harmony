-- Fix RLS Policy for Conversation Creation
-- ISSUE: create_or_get_direct_conversation RPC fails with RLS policy violation
-- SOLUTION: Update conversation INSERT policy to allow RPC function to create conversations

-- Check current RLS policies
SELECT 
    'Current conversation RLS policies' as info,
    schemaname,
    tablename,
    policyname,
    permissive,
    cmd,
    qual
FROM pg_policies 
WHERE tablename = 'conversations';

-- Drop existing INSERT policy if restrictive
DROP POLICY IF EXISTS "Users can create conversations" ON conversations;
DROP POLICY IF EXISTS "Users can insert conversations" ON conversations;
DROP POLICY IF EXISTS "Authenticated users can create conversations" ON conversations;

-- Create a proper INSERT policy that allows:
-- 1. Users to create conversations where they are a participant
-- 2. RPC functions to create conversations (SECURITY DEFINER functions bypass RLS)
CREATE POLICY "Allow conversation creation" ON conversations
FOR INSERT WITH CHECK (
    -- Allow if user is authenticated
    auth.uid() IS NOT NULL
    AND (
        -- Allow if the user will be a participant (checked via created_by)
        created_by = auth.uid()
        OR
        -- Allow if this is being called from a SECURITY DEFINER function
        -- (RPC functions like create_or_get_direct_conversation)
        current_setting('role') = 'service_role'
        OR
        -- Allow if user is in the participants list (for group conversations)
        EXISTS (
            SELECT 1 FROM conversation_participants cp
            WHERE cp.conversation_id = conversations.id
              AND cp.user_id = auth.uid()
              AND cp.left_at IS NULL
        )
    )
);

-- Ensure the conversation_participants table also has proper policies
DROP POLICY IF EXISTS "Users can manage their participations" ON conversation_participants;

CREATE POLICY "Allow participation management" ON conversation_participants
FOR ALL USING (
    -- Users can see/manage participations where they are involved
    user_id = auth.uid()
    OR
    -- Or if they're a participant in the same conversation
    EXISTS (
        SELECT 1 FROM conversation_participants cp2
        WHERE cp2.conversation_id = conversation_participants.conversation_id
          AND cp2.user_id = auth.uid()
          AND cp2.left_at IS NULL
    )
) WITH CHECK (
    -- Users can add themselves or others to conversations they're part of
    auth.uid() IS NOT NULL
    AND (
        user_id = auth.uid()
        OR
        EXISTS (
            SELECT 1 FROM conversation_participants cp2
            WHERE cp2.conversation_id = conversation_participants.conversation_id
              AND cp2.user_id = auth.uid()
              AND cp2.left_at IS NULL
        )
    )
);

-- Test the fix
DO $$
DECLARE
    test_conversation_id UUID;
    test_user1_id UUID := '67750a0f-7514-43ed-a5ed-89ac873a08f0';  -- Your user ID
    test_user2_id UUID := 'e33e2b83-922a-40cc-9629-b83ca1922011';  -- tester004's user ID
BEGIN
    -- Set user context for testing
    PERFORM set_config('request.jwt.claims', 
        '{"sub": "' || test_user1_id || '"}', true);
    
    -- Test the RPC function
    SELECT create_or_get_direct_conversation(test_user1_id, test_user2_id) 
    INTO test_conversation_id;
    
    RAISE WARNING '✅ RLS Test: create_or_get_direct_conversation returned: %', test_conversation_id;
    
    -- Reset
    PERFORM set_config('request.jwt.claims', null, true);
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING '❌ RLS Test failed: % - %', SQLSTATE, SQLERRM;
        -- Reset
        PERFORM set_config('request.jwt.claims', null, true);
END;
$$;

-- Verify the policies are active
SELECT 
    'Updated conversation RLS policies' as info,
    schemaname,
    tablename,
    policyname,
    permissive,
    cmd,
    qual
FROM pg_policies 
WHERE tablename IN ('conversations', 'conversation_participants');

COMMENT ON POLICY "Allow conversation creation" ON conversations IS 
'Allows authenticated users to create conversations where they will be participants. Supports both direct conversation creation and RPC function calls.';