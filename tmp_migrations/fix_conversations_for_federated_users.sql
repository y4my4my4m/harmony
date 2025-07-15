-- Fix conversations table to support federated users
-- Current issue: conversations.user1/user2 reference auth.users(id) but federated users only exist in profiles

BEGIN;

-- Drop existing foreign key constraints
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_user1_fkey;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_user2_fkey;

-- Add new foreign key constraints to profiles table instead
ALTER TABLE conversations 
ADD CONSTRAINT conversations_user1_fkey 
FOREIGN KEY (user1) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE conversations 
ADD CONSTRAINT conversations_user2_fkey 
FOREIGN KEY (user2) REFERENCES profiles(id) ON DELETE CASCADE;

-- Update RLS policies to work with profiles instead of auth.users
DROP POLICY IF EXISTS "Users can view their own conversations" ON conversations;
DROP POLICY IF EXISTS "Users can create conversations with themselves" ON conversations;
DROP POLICY IF EXISTS "Users can update their own conversations" ON conversations;

-- Create new RLS policies that work with profiles
CREATE POLICY "Users can view their own conversations" ON conversations
FOR SELECT USING (
  user1 IN (
    SELECT id FROM profiles WHERE auth_user_id = auth.uid()
  ) OR 
  user2 IN (
    SELECT id FROM profiles WHERE auth_user_id = auth.uid()
  )
);

CREATE POLICY "Users can create conversations" ON conversations
FOR INSERT WITH CHECK (
  -- Allow if current user is one of the participants (for local users)
  user1 IN (
    SELECT id FROM profiles WHERE auth_user_id = auth.uid()
  ) OR 
  user2 IN (
    SELECT id FROM profiles WHERE auth_user_id = auth.uid()
  ) OR
  -- Allow service role to create conversations (for federated DMs)
  auth.role() = 'service_role'
);

CREATE POLICY "Users can update their own conversations" ON conversations
FOR UPDATE USING (
  user1 IN (
    SELECT id FROM profiles WHERE auth_user_id = auth.uid()
  ) OR 
  user2 IN (
    SELECT id FROM profiles WHERE auth_user_id = auth.uid()
  )
);

-- Also update messages table RLS to work with the new conversation structure
DROP POLICY IF EXISTS "Users can view messages in their conversations" ON messages;
DROP POLICY IF EXISTS "Users can create messages in their conversations" ON messages;

CREATE POLICY "Users can view messages in their conversations" ON messages
FOR SELECT USING (
  conversation_id IN (
    SELECT id FROM conversations 
    WHERE user1 IN (
      SELECT id FROM profiles WHERE auth_user_id = auth.uid()
    ) OR user2 IN (
      SELECT id FROM profiles WHERE auth_user_id = auth.uid()
    )
  )
);

CREATE POLICY "Users can create messages in their conversations" ON messages
FOR INSERT WITH CHECK (
  conversation_id IN (
    SELECT id FROM conversations 
    WHERE user1 IN (
      SELECT id FROM profiles WHERE auth_user_id = auth.uid()
    ) OR user2 IN (
      SELECT id FROM profiles WHERE auth_user_id = auth.uid()
    )
  ) OR
  -- Allow service role to create messages (for federated DMs)
  auth.role() = 'service_role'
);

COMMIT;
