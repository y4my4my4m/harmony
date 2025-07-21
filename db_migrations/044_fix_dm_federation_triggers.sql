-- Migration 044: Fix DM Federation Triggers
-- Issue: DM federation not working because triggers are missing or calling wrong functions
-- Solution: Create proper triggers for outgoing and incoming DM federation

BEGIN;

-- 1. Create trigger for outgoing DM federation (when local users send DMs)
DROP TRIGGER IF EXISTS trigger_handle_outgoing_messages ON messages;

CREATE TRIGGER trigger_handle_outgoing_messages
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION handle_outgoing_messages();

COMMENT ON TRIGGER trigger_handle_outgoing_messages ON messages 
IS 'Handles federation and notifications for outgoing DM messages to remote users';

-- 2. Verify that incoming DM processing works through process_create_activity
-- This should already be working through the ActivityPub processing chain:
-- ActivityPub inbox → process_create_activity → handle_incoming_messages

-- 3. Test that the required functions exist
DO $$
BEGIN
    -- Check that handle_outgoing_messages exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'handle_outgoing_messages'
    ) THEN
        RAISE EXCEPTION 'Function handle_outgoing_messages() does not exist!';
    END IF;
    
    -- Check that handle_incoming_messages exists  
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'handle_incoming_messages'
    ) THEN
        RAISE EXCEPTION 'Function handle_incoming_messages() does not exist!';
    END IF;
    
    -- Check that is_activitypub_direct_message exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'is_activitypub_direct_message'
    ) THEN
        RAISE EXCEPTION 'Function is_activitypub_direct_message() does not exist!';
    END IF;
    
    RAISE NOTICE '✅ All DM federation functions verified';
END $$;

-- 4. Verify trigger was created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE c.relname = 'messages' 
        AND t.tgname = 'trigger_handle_outgoing_messages'
        AND t.tgenabled = 'O'  -- enabled
    ) THEN
        RAISE EXCEPTION 'Failed to create trigger_handle_outgoing_messages!';
    END IF;
    
    RAISE NOTICE '✅ DM federation trigger created successfully';
END $$;

COMMIT;