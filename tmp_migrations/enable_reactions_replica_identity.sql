-- Enable full row data in DELETE events for reactions table
-- This will make Supabase include all column values in the DELETE payload

-- Set replica identity to FULL for the reactions table
-- This tells PostgreSQL to include all column values in the WAL (Write-Ahead Log)
-- which Supabase's real-time system uses for change events
ALTER TABLE reactions REPLICA IDENTITY FULL;

-- Note: This will make DELETE events include the full row data in payload.old
-- so we can access message_id, user_id, emoji_id, etc. in the real-time subscription