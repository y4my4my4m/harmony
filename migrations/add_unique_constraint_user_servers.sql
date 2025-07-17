-- Migration: Add unique constraint to user_servers table to prevent duplicate user-server relationships
-- This fixes the bug where users can join the same server multiple times

BEGIN;

-- First, remove any duplicate entries that might already exist
-- Keep only the earliest entry for each user-server combination
DELETE FROM user_servers 
WHERE id NOT IN (
    SELECT MIN(id) 
    FROM user_servers 
    GROUP BY user_id, server_id
);

-- Add unique constraint to prevent future duplicates
ALTER TABLE user_servers 
ADD CONSTRAINT user_servers_user_id_server_id_unique 
UNIQUE (user_id, server_id);

-- Add a comment to document the constraint
COMMENT ON CONSTRAINT user_servers_user_id_server_id_unique ON user_servers 
IS 'Ensures a user can only be a member of each server once';

COMMIT;
