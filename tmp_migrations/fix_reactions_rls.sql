-- Fix reactions table RLS policies to support both server messages and DM conversations
-- This ensures reactions work for both channel messages and DM messages

-- Enable RLS for reactions table
ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;

-- Drop any existing policies to start fresh
DROP POLICY IF EXISTS "reactions_select_policy" ON reactions;
DROP POLICY IF EXISTS "reactions_insert_policy" ON reactions;
DROP POLICY IF EXISTS "reactions_update_policy" ON reactions;
DROP POLICY IF EXISTS "reactions_delete_policy" ON reactions;

-- SELECT policy: Users can see reactions on messages they can access
CREATE POLICY "reactions_select_policy" ON reactions
  FOR SELECT
  USING (
    -- Channel message reactions: user has access to the channel via server membership
    (message_id IN (
      SELECT m.id
      FROM messages m
      JOIN channels c ON m.channel_id = c.id
      JOIN user_servers us ON c.server_id = us.server_id
      WHERE us.user_id = auth.uid()
    ))
    OR
    -- DM message reactions: user participates in the conversation
    (message_id IN (
      SELECT m.id
      FROM messages m
      JOIN conversations conv ON m.conversation_id = conv.id
      WHERE conv.user1 = auth.uid() OR conv.user2 = auth.uid()
    ))
  );

-- INSERT policy: Users can add reactions to messages they can access
CREATE POLICY "reactions_insert_policy" ON reactions
  FOR INSERT
  WITH CHECK (
    -- Channel message reactions: user has access to the channel via server membership
    (message_id IN (
      SELECT m.id
      FROM messages m
      JOIN channels c ON m.channel_id = c.id
      JOIN user_servers us ON c.server_id = us.server_id
      WHERE us.user_id = auth.uid()
    ))
    OR
    -- DM message reactions: user participates in the conversation
    (message_id IN (
      SELECT m.id
      FROM messages m
      JOIN conversations conv ON m.conversation_id = conv.id
      WHERE conv.user1 = auth.uid() OR conv.user2 = auth.uid()
    ))
  );

-- UPDATE policy: Users can update their own reactions
CREATE POLICY "reactions_update_policy" ON reactions
  FOR UPDATE
  USING (
    user_id = auth.uid()
    AND
    (
      -- Channel message reactions: user has access to the channel via server membership
      (message_id IN (
        SELECT m.id
        FROM messages m
        JOIN channels c ON m.channel_id = c.id
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE us.user_id = auth.uid()
      ))
      OR
      -- DM message reactions: user participates in the conversation
      (message_id IN (
        SELECT m.id
        FROM messages m
        JOIN conversations conv ON m.conversation_id = conv.id
        WHERE conv.user1 = auth.uid() OR conv.user2 = auth.uid()
      ))
    )
  );

-- DELETE policy: Users can delete their own reactions
CREATE POLICY "reactions_delete_policy" ON reactions
  FOR DELETE
  USING (
    user_id = auth.uid()
    AND
    (
      -- Channel message reactions: user has access to the channel via server membership
      (message_id IN (
        SELECT m.id
        FROM messages m
        JOIN channels c ON m.channel_id = c.id
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE us.user_id = auth.uid()
      ))
      OR
      -- DM message reactions: user participates in the conversation
      (message_id IN (
        SELECT m.id
        FROM messages m
        JOIN conversations conv ON m.conversation_id = conv.id
        WHERE conv.user1 = auth.uid() OR conv.user2 = auth.uid()
      ))
    )
  );

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON reactions TO authenticated;

-- Ensure reactions table is added to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE reactions;

-- Force refresh realtime connections
SELECT pg_notify('pgrst', 'reload schema');

-- Verification queries
SELECT 'Reactions table RLS enabled:' as check_type, 
       CASE WHEN relrowsecurity THEN 'YES' ELSE 'NO' END as status
FROM pg_class WHERE relname = 'reactions';

SELECT 'Reactions policies created:' as check_type, count(*) as policy_count
FROM pg_policies WHERE tablename = 'reactions';