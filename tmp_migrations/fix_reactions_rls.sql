-- Fix RLS policies for reactions table to enable proper real-time propagation
-- This addresses the issue where reaction removals aren't propagated to other users

-- Enable RLS on reactions table
ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;

-- Policy for SELECT: Users can see reactions on messages from servers they belong to
CREATE POLICY reactions_select_policy ON reactions
FOR SELECT
TO authenticated
USING (
    message_id IN (
        SELECT m.id 
        FROM messages m
        JOIN channels c ON m.channel_id = c.id
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE us.user_id = auth.uid()
    )
);

-- Policy for INSERT: Users can add reactions to messages from servers they belong to
CREATE POLICY reactions_insert_policy ON reactions
FOR INSERT
TO authenticated
WITH CHECK (
    message_id IN (
        SELECT m.id 
        FROM messages m
        JOIN channels c ON m.channel_id = c.id
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE us.user_id = auth.uid()
    )
);

-- Policy for DELETE: Users can only delete their own reactions
CREATE POLICY reactions_delete_policy ON reactions
FOR DELETE
TO authenticated
USING (
    user_id = auth.uid()
    AND message_id IN (
        SELECT m.id 
        FROM messages m
        JOIN channels c ON m.channel_id = c.id
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE us.user_id = auth.uid()
    )
);

-- Grant necessary permissions
GRANT ALL ON reactions TO authenticated;