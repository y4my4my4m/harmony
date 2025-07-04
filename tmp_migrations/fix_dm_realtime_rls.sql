-- Verify and fix RLS policies for DM messages
-- This script ensures that DM messages work with proper Row Level Security

-- First, let's check if the messages table has RLS enabled
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to recreate them properly
DROP POLICY IF EXISTS "messages_select_policy" ON messages;
DROP POLICY IF EXISTS "messages_insert_policy" ON messages;
DROP POLICY IF EXISTS "messages_update_policy" ON messages;
DROP POLICY IF EXISTS "messages_delete_policy" ON messages;

-- Policy 1: SELECT - Users can read messages from channels they have access to OR conversations they participate in
CREATE POLICY "messages_select_policy" ON messages
  FOR SELECT
  USING (
    -- Channel messages: user has access to the channel
    (channel_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM channels
      JOIN user_servers ON channels.server_id = user_servers.server_id
      WHERE channels.id = messages.channel_id
        AND user_servers.user_id = auth.uid()
    ))
    OR
    -- DM messages: user participates in the conversation
    (conversation_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM conversations
      WHERE conversations.id = messages.conversation_id
        AND (conversations.user1 = auth.uid() OR conversations.user2 = auth.uid())
    ))
  );

-- Policy 2: INSERT - Users can insert messages into channels they have access to OR conversations they participate in
CREATE POLICY "messages_insert_policy" ON messages
  FOR INSERT
  WITH CHECK (
    -- Channel messages: user has access to the channel
    (channel_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM channels
      JOIN user_servers ON channels.server_id = user_servers.server_id
      WHERE channels.id = messages.channel_id
        AND user_servers.user_id = auth.uid()
    ))
    OR
    -- DM messages: user participates in the conversation
    (conversation_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM conversations
      WHERE conversations.id = messages.conversation_id
        AND (conversations.user1 = auth.uid() OR conversations.user2 = auth.uid())
    ))
  );

-- Policy 3: UPDATE - Users can update their own messages OR server owners can update any message in their server
CREATE POLICY "messages_update_policy" ON messages
  FOR UPDATE
  USING (
    -- User owns the message
    user_id = auth.uid()
    OR
    -- Server owner can update any message in their server (for channel messages)
    (channel_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM channels
      JOIN servers ON channels.server_id = servers.id
      WHERE channels.id = messages.channel_id
        AND servers.owner = auth.uid()
    ))
    OR
    -- User participates in the conversation (for DM messages)
    (conversation_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM conversations
      WHERE conversations.id = messages.conversation_id
        AND (conversations.user1 = auth.uid() OR conversations.user2 = auth.uid())
    ))
  );

-- Policy 4: DELETE - Users can delete their own messages OR server owners can delete any message in their server
CREATE POLICY "messages_delete_policy" ON messages
  FOR DELETE
  USING (
    -- User owns the message
    user_id = auth.uid()
    OR
    -- Server owner can delete any message in their server (for channel messages)
    (channel_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM channels
      JOIN servers ON channels.server_id = servers.id
      WHERE channels.id = messages.channel_id
        AND servers.owner = auth.uid()
    ))
    OR
    -- User participates in the conversation (for DM messages)
    (conversation_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM conversations
      WHERE conversations.id = messages.conversation_id
        AND (conversations.user1 = auth.uid() OR conversations.user2 = auth.uid())
    ))
  );

-- Also ensure conversations table has proper RLS
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Drop and recreate conversation policies
DROP POLICY IF EXISTS "conversations_select_policy" ON conversations;
DROP POLICY IF EXISTS "conversations_insert_policy" ON conversations;
DROP POLICY IF EXISTS "conversations_update_policy" ON conversations;

-- Conversations SELECT policy - users can see conversations they participate in
CREATE POLICY "conversations_select_policy" ON conversations
  FOR SELECT
  USING (user1 = auth.uid() OR user2 = auth.uid());

-- Conversations INSERT policy - users can create conversations where they are a participant
CREATE POLICY "conversations_insert_policy" ON conversations
  FOR INSERT
  WITH CHECK (user1 = auth.uid() OR user2 = auth.uid());

-- Conversations UPDATE policy - users can update conversations they participate in
CREATE POLICY "conversations_update_policy" ON conversations
  FOR UPDATE
  USING (user1 = auth.uid() OR user2 = auth.uid());

-- Enable realtime for messages table if not already enabled
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;