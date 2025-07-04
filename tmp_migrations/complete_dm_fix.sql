-- First, let's check the current state and fix DM realtime completely
-- This script will diagnose and fix all DM-related database issues

-- 1. Check if messages table exists and has correct structure
\d messages;

-- 2. Check current RLS policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual 
FROM pg_policies 
WHERE tablename IN ('messages', 'conversations');

-- 3. Check if realtime is enabled
SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';

-- 4. Drop ALL existing policies to start fresh
DROP POLICY IF EXISTS "messages_select_policy" ON messages;
DROP POLICY IF EXISTS "messages_insert_policy" ON messages;  
DROP POLICY IF EXISTS "messages_update_policy" ON messages;
DROP POLICY IF EXISTS "messages_delete_policy" ON messages;
DROP POLICY IF EXISTS "Enable read access for authenticated users" ON messages;
DROP POLICY IF EXISTS "Enable insert for authenticated users" ON messages;
DROP POLICY IF EXISTS "Enable update for own messages" ON messages;
DROP POLICY IF EXISTS "Enable delete for own messages" ON messages;

-- 5. Ensure RLS is enabled
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- 6. Create comprehensive policies for messages table
-- SELECT policy: Users can read messages from channels they have access to OR conversations they participate in
CREATE POLICY "messages_read_policy" ON messages
  FOR SELECT
  USING (
    -- Channel messages: user has access via server membership
    (channel_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM channels c
      JOIN user_servers us ON c.server_id = us.server_id
      WHERE c.id = messages.channel_id AND us.user_id = auth.uid()
    ))
    OR
    -- DM messages: user participates in the conversation
    (conversation_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM conversations conv
      WHERE conv.id = messages.conversation_id
        AND (conv.user1 = auth.uid() OR conv.user2 = auth.uid())
    ))
  );

-- INSERT policy: Users can insert messages into channels/conversations they have access to
CREATE POLICY "messages_create_policy" ON messages
  FOR INSERT
  WITH CHECK (
    -- User must be authenticated
    auth.uid() IS NOT NULL
    AND
    (
      -- Channel messages: user has access via server membership
      (channel_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM channels c
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE c.id = messages.channel_id AND us.user_id = auth.uid()
      ))
      OR
      -- DM messages: user participates in the conversation AND is the message sender
      (conversation_id IS NOT NULL 
        AND user_id = auth.uid()
        AND EXISTS (
          SELECT 1 FROM conversations conv
          WHERE conv.id = messages.conversation_id
            AND (conv.user1 = auth.uid() OR conv.user2 = auth.uid())
        ))
    )
  );

-- UPDATE policy: Users can update their own messages
CREATE POLICY "messages_modify_policy" ON messages
  FOR UPDATE
  USING (
    user_id = auth.uid()
    OR
    -- Server owners can modify messages in their servers (for channel messages only)
    (channel_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM channels c
      JOIN servers s ON c.server_id = s.id
      WHERE c.id = messages.channel_id AND s.owner = auth.uid()
    ))
  );

-- DELETE policy: Users can delete their own messages
CREATE POLICY "messages_remove_policy" ON messages
  FOR DELETE
  USING (
    user_id = auth.uid()
    OR
    -- Server owners can delete messages in their servers (for channel messages only)
    (channel_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM channels c
      JOIN servers s ON c.server_id = s.id
      WHERE c.id = messages.channel_id AND s.owner = auth.uid()
    ))
  );

-- 7. Fix conversations table policies
DROP POLICY IF EXISTS "conversations_select_policy" ON conversations;
DROP POLICY IF EXISTS "conversations_insert_policy" ON conversations;
DROP POLICY IF EXISTS "conversations_update_policy" ON conversations;
DROP POLICY IF EXISTS "conversations_delete_policy" ON conversations;

-- Conversations policies
CREATE POLICY "conversations_read_policy" ON conversations
  FOR SELECT
  USING (user1 = auth.uid() OR user2 = auth.uid());

CREATE POLICY "conversations_create_policy" ON conversations
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL 
    AND (user1 = auth.uid() OR user2 = auth.uid())
    AND user1 != user2  -- Prevent self-conversations
  );

CREATE POLICY "conversations_modify_policy" ON conversations
  FOR UPDATE
  USING (user1 = auth.uid() OR user2 = auth.uid());

-- 8. Ensure realtime is properly configured
-- Remove and re-add tables to realtime publication
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS messages;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;

-- 9. Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO authenticated;
GRANT SELECT, INSERT, UPDATE ON conversations TO authenticated;

-- 10. Test the setup with a simple query (replace with actual user IDs)
-- This should return conversations for the authenticated user
-- SELECT * FROM conversations WHERE user1 = auth.uid() OR user2 = auth.uid();

-- 11. Force refresh realtime connections
SELECT pg_notify('pgrst', 'reload schema');

-- Final verification queries
SELECT 'Messages table RLS enabled:' as check_type, 
       CASE WHEN relrowsecurity THEN 'YES' ELSE 'NO' END as status
FROM pg_class WHERE relname = 'messages';

SELECT 'Conversations table RLS enabled:' as check_type,
       CASE WHEN relrowsecurity THEN 'YES' ELSE 'NO' END as status  
FROM pg_class WHERE relname = 'conversations';

SELECT 'Realtime publications:' as check_type, string_agg(tablename, ', ') as status
FROM pg_publication_tables WHERE pubname = 'supabase_realtime' 
  AND tablename IN ('messages', 'conversations');

-- Show final policies
SELECT tablename, policyname, cmd, permissive
FROM pg_policies 
WHERE tablename IN ('messages', 'conversations')
ORDER BY tablename, cmd;