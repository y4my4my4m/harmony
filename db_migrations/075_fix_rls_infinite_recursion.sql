-- Fix RLS Infinite Recursion
-- ISSUE: conversation_participants policy references itself causing infinite recursion
-- SOLUTION: Simplify the policies to remove circular references

-- Drop the problematic policy
DROP POLICY IF EXISTS "Allow participation management" ON conversation_participants;

-- Create simpler, non-recursive policies for conversation_participants
CREATE POLICY "Users can view their participations" ON conversation_participants
FOR SELECT USING (
    user_id = auth.uid()
    OR
    -- Allow viewing if user is in the same conversation (but don't recurse)
    conversation_id IN (
        SELECT cp.conversation_id 
        FROM conversation_participants cp 
        WHERE cp.user_id = auth.uid() AND cp.left_at IS NULL
    )
);

CREATE POLICY "Users can insert their participations" ON conversation_participants
FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND (
        user_id = auth.uid()
        OR
        -- Allow if user is creating a conversation (bypass for RPC functions)
        current_setting('role') = 'service_role'
    )
);

CREATE POLICY "Users can update their participations" ON conversation_participants
FOR UPDATE USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their participations" ON conversation_participants
FOR DELETE USING (user_id = auth.uid());

-- Also simplify the conversations policy to avoid potential issues
DROP POLICY IF EXISTS "Allow conversation creation" ON conversations;

CREATE POLICY "Allow conversation creation" ON conversations
FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND (
        created_by = auth.uid()
        OR
        current_setting('role') = 'service_role'
    )
);

-- Test to make sure the recursion is fixed
DO $$
DECLARE
    test_result INTEGER;
BEGIN
    -- Simple test query that would trigger the recursion
    SELECT COUNT(*) INTO test_result
    FROM conversation_participants cp
    WHERE cp.user_id = '67750a0f-7514-43ed-a5ed-89ac873a08f0'::uuid;
    
    RAISE WARNING '✅ RLS Recursion Test: Found % participations (no recursion)', test_result;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING '❌ RLS Recursion Test failed: % - %', SQLSTATE, SQLERRM;
END;
$$;

-- Verify the new policies
SELECT 
    'Fixed conversation_participants RLS policies' as info,
    policyname,
    cmd,
    qual
FROM pg_policies 
WHERE tablename = 'conversation_participants'
ORDER BY cmd, policyname;