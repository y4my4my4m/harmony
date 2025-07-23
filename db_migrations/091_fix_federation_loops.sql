-- Migration 091: CRITICAL - Fix Federation Loop Vulnerability
-- Replaces broken dispatcher with proper WHEN condition triggers

BEGIN;

-- =====================================================
-- PHASE 1: FIX MESSAGES FEDERATION LOOPS
-- =====================================================

-- Drop broken dispatcher approach
DROP TRIGGER IF EXISTS trg_handle_messages ON messages;
DROP TRIGGER IF EXISTS trg_handle_message_federation ON messages;
DROP FUNCTION IF EXISTS handle_messages();

-- Create proper conditional trigger for OUTGOING messages only
CREATE TRIGGER trg_handle_outgoing_messages
    AFTER INSERT ON messages
    FOR EACH ROW
    WHEN (NEW.metadata->>'federated' IS DISTINCT FROM 'true')
    EXECUTE FUNCTION handle_outgoing_messages();

COMMENT ON TRIGGER trg_handle_outgoing_messages ON messages IS 
'SAFE: Only triggers for outgoing local messages (metadata.federated != true). Prevents federation loops.';

-- =====================================================
-- PHASE 2: VERIFY POSTS FEDERATION SAFETY
-- =====================================================

-- Ensure posts trigger has proper WHEN condition
DROP TRIGGER IF EXISTS trg_handle_post_federation ON posts;

CREATE TRIGGER trg_handle_post_federation
    AFTER INSERT ON posts
    FOR EACH ROW
    WHEN (NEW.is_local = true AND NEW.visibility != 'private')
    EXECUTE FUNCTION handle_post_federation();

COMMENT ON TRIGGER trg_handle_post_federation ON posts IS
'SAFE: Only triggers for outgoing local posts (is_local = true). Prevents federation loops.';

-- =====================================================
-- PHASE 3: VERIFICATION CHECKS
-- =====================================================

-- Verify incoming messages are marked properly
DO $$
DECLARE
    sample_incoming_message RECORD;
BEGIN
    -- Check if any incoming messages exist
    SELECT * INTO sample_incoming_message
    FROM messages 
    WHERE metadata->>'federated' = 'true'
    LIMIT 1;
    
    IF FOUND THEN
        RAISE NOTICE '✅ Found incoming messages properly marked: metadata.federated = true';
    ELSE
        RAISE NOTICE '⚠️ No incoming messages found - this is normal if no federation activity yet';
    END IF;
END $$;

-- Verify incoming posts are marked properly  
DO $$
DECLARE
    local_posts_count INTEGER;
    remote_posts_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO local_posts_count FROM posts WHERE is_local = true;
    SELECT COUNT(*) INTO remote_posts_count FROM posts WHERE is_local = false;
    
    RAISE NOTICE '✅ Posts distribution: % local, % remote', local_posts_count, remote_posts_count;
    
    IF local_posts_count = 0 THEN
        RAISE WARNING '⚠️ No local posts found - ensure is_local is being set correctly';
    END IF;
END $$;

-- =====================================================
-- VERIFICATION SUMMARY
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '🎯 FEDERATION LOOP FIX COMPLETE!';
    RAISE NOTICE '';
    RAISE NOTICE '✅ SAFE TRIGGERS CREATED:';
    RAISE NOTICE '  📨 trg_handle_outgoing_messages (WHEN metadata.federated != true)';
    RAISE NOTICE '  📝 trg_handle_post_federation (WHEN is_local = true)';
    RAISE NOTICE '';
    RAISE NOTICE '🔒 FEDERATION LOOPS PREVENTED:';
    RAISE NOTICE '  ❌ Incoming messages (federated=true) will NOT trigger federation';
    RAISE NOTICE '  ❌ Incoming posts (is_local=false) will NOT trigger federation';
    RAISE NOTICE '  ✅ Only outgoing local content will federate';
    RAISE NOTICE '';
    RAISE NOTICE '⚡ PERFORMANCE IMPROVED:';
    RAISE NOTICE '  ✅ PostgreSQL evaluates WHEN clause before function call';
    RAISE NOTICE '  ✅ No unnecessary function executions for incoming content';
    RAISE NOTICE '  ✅ Clean, predictable behavior';
END $$;

COMMIT;