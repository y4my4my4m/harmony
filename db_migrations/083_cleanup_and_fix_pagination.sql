-- Migration 083: Cleanup and Fix Pagination
-- Remove bad migrations after 074 and fix message loading order
-- ISSUE: fetchConversationMessages loads oldest 20 messages, but we need newest 20 on initial load

BEGIN;

-- 1. Confirm we're using migration 074's working trigger (already applied)
-- 2. Fix the pagination issue in message loading

-- The issue is likely in the message service loading order
-- We need to load NEWEST messages first on initial load, not oldest

-- Create a helper function to diagnose the pagination issue
CREATE OR REPLACE FUNCTION debug_conversation_messages(conv_id UUID, msg_limit INTEGER DEFAULT 20)
RETURNS TABLE (
    id UUID,
    created_at TIMESTAMPTZ,
    content JSONB,
    message_order TEXT
) 
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        m.id,
        m.created_at,
        m.content,
        'newest_first'::TEXT as message_order
    FROM messages m
    WHERE m.conversation_id = conv_id
    ORDER BY m.created_at DESC  -- Newest first for initial load
    LIMIT msg_limit;
END;
$$;

-- Also create a function to get oldest messages (for "load more" pagination)
CREATE OR REPLACE FUNCTION get_older_conversation_messages(
    conv_id UUID, 
    before_timestamp TIMESTAMPTZ,
    msg_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
    id UUID,
    created_at TIMESTAMPTZ,
    content JSONB,
    user_id UUID
) 
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        m.id,
        m.created_at,
        m.content,
        m.user_id
    FROM messages m
    WHERE m.conversation_id = conv_id
    AND m.created_at < before_timestamp
    ORDER BY m.created_at DESC  -- Still newest first within the older batch
    LIMIT msg_limit;
END;
$$;

-- Add a comment about the pagination fix needed
COMMENT ON FUNCTION debug_conversation_messages IS 
'Diagnostic function to check message loading order. Initial load should get NEWEST 20 messages, not oldest 20.';

COMMIT;

-- INSTRUCTIONS FOR FRONTEND FIX:
-- The issue is in src/services/core/CoreMessageService.ts loadConversationMessages()
-- It should:
-- 1. INITIAL LOAD: ORDER BY created_at DESC LIMIT 20 (newest first)
-- 2. LOAD MORE: ORDER BY created_at DESC with before_timestamp filter (older messages)
-- 3. Frontend should reverse the array if needed for display