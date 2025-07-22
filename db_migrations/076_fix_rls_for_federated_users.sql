-- Fix RLS for Federated Users
-- ISSUE: RLS policies assume all users have auth.uid(), but federated users don't
-- SOLUTION: Only apply auth.uid() restrictions to authenticated operations, allow data visibility for federated users

-- Drop all the broken policies
DROP POLICY IF EXISTS "Users can view their participations" ON conversation_participants;
DROP POLICY IF EXISTS "Users can insert their participations" ON conversation_participants;
DROP POLICY IF EXISTS "Users can update their participations" ON conversation_participants;
DROP POLICY IF EXISTS "Users can delete their participations" ON conversation_participants;
DROP POLICY IF EXISTS "Allow conversation creation" ON conversations;

-- For conversation_participants: Keep it simple and permissive for reads
-- Only restrict writes to authenticated users
CREATE POLICY "Anyone can view conversation participants" ON conversation_participants
FOR SELECT USING (true);

CREATE POLICY "Authenticated users can manage participants" ON conversation_participants
FOR INSERT WITH CHECK (
    -- Only authenticated users can add participants
    -- This covers local user operations and RPC functions
    auth.uid() IS NOT NULL
);

CREATE POLICY "Users can update their own participation" ON conversation_participants
FOR UPDATE USING (
    auth.uid() IS NOT NULL AND user_id = auth.uid()
) WITH CHECK (
    auth.uid() IS NOT NULL AND user_id = auth.uid()
);

CREATE POLICY "Users can leave conversations" ON conversation_participants
FOR DELETE USING (
    auth.uid() IS NOT NULL AND user_id = auth.uid()
);

-- For conversations: Simple policies that don't break federated data
CREATE POLICY "Anyone can view conversations" ON conversations
FOR SELECT USING (true);

CREATE POLICY "Authenticated users can create conversations" ON conversations
FOR INSERT WITH CHECK (
    -- Only authenticated users (or RPC functions) can create conversations
    auth.uid() IS NOT NULL
);

CREATE POLICY "Conversation participants can update conversations" ON conversations
FOR UPDATE USING (
    auth.uid() IS NOT NULL 
    AND EXISTS (
        SELECT 1 FROM conversation_participants cp
        WHERE cp.conversation_id = conversations.id
          AND cp.user_id = auth.uid()
          AND cp.left_at IS NULL
    )
) WITH CHECK (
    auth.uid() IS NOT NULL
);

-- Test with your actual user ID (local authenticated user)
DO $$
DECLARE
    test_count INTEGER;
    test_conversation_id UUID;
BEGIN
    -- Set your user context
    PERFORM set_config('request.jwt.claims', 
        '{"sub": "67750a0f-7514-43ed-a5ed-89ac873a08f0"}', true);
    
    -- Test viewing conversation participants (should work)
    SELECT COUNT(*) INTO test_count
    FROM conversation_participants cp
    WHERE cp.conversation_id = '18f369e8-db2c-47c6-967e-149108f52aa0';
    
    RAISE WARNING '✅ RLS Test: Can view % participants in conversation', test_count;
    
    -- Test conversation creation
    SELECT create_or_get_direct_conversation(
        '67750a0f-7514-43ed-a5ed-89ac873a08f0'::uuid,
        'e33e2b83-922a-40cc-9629-b83ca1922011'::uuid
    ) INTO test_conversation_id;
    
    RAISE WARNING '✅ RLS Test: create_or_get_direct_conversation returned: %', test_conversation_id;
    
    -- Reset
    PERFORM set_config('request.jwt.claims', null, true);
    
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING '❌ RLS Test failed: % - %', SQLSTATE, SQLERRM;
        PERFORM set_config('request.jwt.claims', null, true);
END;
$$;

-- Verify the new policies
SELECT 
    'Fixed RLS policies (federated-friendly)' as info,
    tablename,
    policyname,
    cmd,
    permissive
FROM pg_policies 
WHERE tablename IN ('conversations', 'conversation_participants')
ORDER BY tablename, cmd, policyname;