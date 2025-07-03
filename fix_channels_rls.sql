-- Fix RLS policies for channels table to allow proper channel reordering
-- This addresses the 403 Forbidden error when updating channel order and category
-- Updated version with simpler, more reliable policies

-- First, drop any existing restrictive policies on channels
DROP POLICY IF EXISTS channels_policy ON channels;
DROP POLICY IF EXISTS channels_select_policy ON channels;
DROP POLICY IF EXISTS channels_insert_policy ON channels;
DROP POLICY IF EXISTS channels_update_policy ON channels;
DROP POLICY IF EXISTS channels_delete_policy ON channels;

-- Enable RLS on channels table
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

-- Policy for SELECT: Users can see channels from servers they belong to
CREATE POLICY channels_select_policy ON channels
FOR SELECT
TO authenticated
USING (
    server_id IN (
        SELECT server_id 
        FROM user_servers 
        WHERE user_id = auth.uid()
    )
);

-- Policy for INSERT: Server owners can create channels
CREATE POLICY channels_insert_policy ON channels
FOR INSERT
TO authenticated
WITH CHECK (
    EXISTS (
        SELECT 1 
        FROM servers s
        WHERE s.id = server_id 
        AND s.owner = auth.uid()
    )
);

-- Policy for UPDATE: Server owners can update channels (including order and category)
-- Simplified to avoid complex JOINs that might cause issues with upsert
CREATE POLICY channels_update_policy ON channels
FOR UPDATE
TO authenticated
USING (
    EXISTS (
        SELECT 1 
        FROM servers s
        WHERE s.id = server_id 
        AND s.owner = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 
        FROM servers s
        WHERE s.id = server_id 
        AND s.owner = auth.uid()
    )
);

-- Policy for DELETE: Server owners can delete channels
CREATE POLICY channels_delete_policy ON channels
FOR DELETE
TO authenticated
USING (
    EXISTS (
        SELECT 1 
        FROM servers s
        WHERE s.id = server_id 
        AND s.owner = auth.uid()
    )
);

-- Grant necessary permissions to authenticated users
GRANT ALL ON channels TO authenticated;

-- Alternative: If the above still causes issues, we can use a single permissive policy
-- Uncomment the following if you prefer a more permissive approach:

/*
-- Drop the specific policies and create one permissive policy
DROP POLICY IF EXISTS channels_select_policy ON channels;
DROP POLICY IF EXISTS channels_insert_policy ON channels;
DROP POLICY IF EXISTS channels_update_policy ON channels;
DROP POLICY IF EXISTS channels_delete_policy ON channels;

-- Single permissive policy for server owners
CREATE POLICY channels_owner_all_policy ON channels
FOR ALL
TO authenticated
USING (
    EXISTS (
        SELECT 1 
        FROM servers s
        WHERE s.id = server_id 
        AND s.owner = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 
        FROM servers s
        WHERE s.id = server_id 
        AND s.owner = auth.uid()
    )
);
*/