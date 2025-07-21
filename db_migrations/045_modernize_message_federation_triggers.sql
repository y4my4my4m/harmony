-- Migration 045: Modernize Message Federation Triggers
-- Issue: Using old "unified" triggers instead of modern specific triggers
-- Solution: Replace old unified approach with modern specific triggers (like posts)

BEGIN;

-- 1. Drop ALL old unified triggers on messages (deprecated scattered approach)
DROP TRIGGER IF EXISTS trigger_unified_message_federation ON messages;
DROP TRIGGER IF EXISTS trigger_unified_notification_messages ON messages;
DROP TRIGGER IF EXISTS trigger_handle_outgoing_messages ON messages; -- My mistake from 044

-- 2. Create modern message federation trigger (following posts pattern exactly)
DROP TRIGGER IF EXISTS trg_handle_message_federation ON messages;

CREATE TRIGGER trg_handle_message_federation
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION handle_outgoing_messages();

COMMENT ON TRIGGER trg_handle_message_federation ON messages IS 
'Modern message federation trigger using handle_outgoing_messages() (not deprecated unified approach)';

-- 3. Verify the modern trigger was created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE c.relname = 'messages' 
        AND t.tgname = 'trg_handle_message_federation'
        AND t.tgenabled = 'O'  -- enabled
    ) THEN
        RAISE EXCEPTION 'Failed to create modern message federation trigger!';
    END IF;
    
    RAISE NOTICE '✅ Modern message federation trigger created successfully';
END $$;

-- 4. Verify old unified triggers are gone
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE c.relname = 'messages' 
        AND t.tgname IN ('trigger_unified_message_federation', 'trigger_unified_notification_messages')
        AND t.tgenabled = 'O'
    ) THEN
        RAISE WARNING 'Old unified triggers still exist on messages table!';
    ELSE
        RAISE NOTICE '✅ Old unified triggers successfully removed from messages table';
    END IF;
END $$;

-- 5. Summary of the modern approach
DO $$
BEGIN
    RAISE NOTICE '🎯 MODERN APPROACH NOW ACTIVE:';
    RAISE NOTICE '  Posts:    trg_handle_post_federation -> handle_post_federation()';
    RAISE NOTICE '  Messages: trg_handle_message_federation -> handle_outgoing_messages()';
    RAISE NOTICE '  ✅ No more scattered "unified" triggers!';
END $$;

COMMIT;