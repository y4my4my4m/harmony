-- Fix Outgoing DM Trigger - Comprehensive Solution
-- This fixes the issue where outgoing DMs aren't triggering edge functions
-- Apply AFTER running fix_dm_trigger_clean.sql

BEGIN;

-- =====================================================
-- STEP 1: CLEAN SLATE - Remove ALL message triggers
-- =====================================================

-- Drop ALL existing triggers on messages (clean slate approach)
DROP TRIGGER IF EXISTS trg_handle_messages ON messages;
DROP TRIGGER IF EXISTS trg_handle_message_federation ON messages;  
DROP TRIGGER IF EXISTS trg_handle_outgoing_messages ON messages;
DROP TRIGGER IF EXISTS trigger_unified_message_federation ON messages;
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON messages;
DROP TRIGGER IF EXISTS trigger_unified_notification_messages ON messages;

-- Drop the broken dispatcher function (from migration 080)
DROP FUNCTION IF EXISTS handle_messages();


-- =====================================================
-- STEP 2: Create the CORRECT outgoing message trigger
-- =====================================================

-- This trigger should ONLY fire for outgoing local messages
CREATE TRIGGER trg_handle_outgoing_messages
    AFTER INSERT ON messages
    FOR EACH ROW
    WHEN (NEW.metadata->>'federated' IS DISTINCT FROM 'true')
    EXECUTE FUNCTION handle_outgoing_messages();

COMMENT ON TRIGGER trg_handle_outgoing_messages ON messages IS 
'FIXED: Only triggers for outgoing local messages (metadata.federated != true). Prevents federation loops and ensures DM federation works.';


-- =====================================================
-- STEP 3: Create notification trigger (separate from federation)
-- =====================================================

-- Recreate the notification trigger (this was lost in the cleanup)
CREATE TRIGGER trg_handle_message_federation
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION handle_message_federation();

COMMENT ON TRIGGER trg_handle_message_federation ON messages IS 
'Handles local notifications for all messages (both local and federated)';

-- =====================================================
-- STEP 4: Verification and diagnostics
-- =====================================================

-- Check that we have the expected triggers
DO $$
DECLARE
    trigger_count INTEGER;
    outgoing_trigger_exists BOOLEAN;
    notification_trigger_exists BOOLEAN;
BEGIN
    -- Count total triggers on messages
    SELECT COUNT(*) INTO trigger_count
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'messages' AND NOT t.tgisinternal;
    
    -- Check for outgoing trigger with WHEN clause
    SELECT EXISTS(
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE c.relname = 'messages' 
        AND t.tgname = 'trg_handle_outgoing_messages'
        AND pg_get_triggerdef(t.oid) LIKE '%WHEN%'
        AND pg_get_triggerdef(t.oid) LIKE '%federated%'
    ) INTO outgoing_trigger_exists;
    
    -- Check for notification trigger
    SELECT EXISTS(
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE c.relname = 'messages' 
        AND t.tgname = 'trg_handle_message_federation'
    ) INTO notification_trigger_exists;
    
    RAISE NOTICE '📊 Verification Results:';
    RAISE NOTICE '  - Total triggers on messages: %', trigger_count;
    RAISE NOTICE '  - Outgoing trigger with WHEN clause: %', 
        CASE WHEN outgoing_trigger_exists THEN '✅ EXISTS' ELSE '❌ MISSING' END;
    RAISE NOTICE '  - Notification trigger: %', 
        CASE WHEN notification_trigger_exists THEN '✅ EXISTS' ELSE '❌ MISSING' END;
    
    -- Fail if setup is incorrect
    IF NOT outgoing_trigger_exists THEN
        RAISE EXCEPTION 'Failed to create outgoing message trigger with WHEN clause!';
    END IF;
    
    IF NOT notification_trigger_exists THEN
        RAISE EXCEPTION 'Failed to create notification trigger!';
    END IF;
    
END $$;

-- =====================================================
-- STEP 5: Test case examples
-- =====================================================


COMMIT;