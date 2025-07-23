# **🚨 CRITICAL: Federation Loop Fix Plan**

## **❌ Current Broken Architecture**

### **The Problem**
Current triggers fire on **ALL** inserts without properly distinguishing:
- **🟢 Outgoing** (local user created) → should federate  
- **🔴 Incoming** (from remote ActivityPub) → should NOT federate

**This causes INFINITE FEDERATION LOOPS!**

---

## **✅ Correct Architecture Design**

### **Design Principle: WHEN Condition Triggers**
Instead of complex dispatchers, use **WHEN conditions** on triggers:

```sql
-- ✅ POSTS: Only federate outgoing local posts
CREATE TRIGGER trg_handle_post_federation
    AFTER INSERT ON posts
    FOR EACH ROW
    WHEN (NEW.is_local = true AND NEW.visibility != 'private')
    EXECUTE FUNCTION handle_post_federation();

-- ✅ MESSAGES: Only federate outgoing local messages  
CREATE TRIGGER trg_handle_outgoing_messages
    AFTER INSERT ON messages
    FOR EACH ROW  
    WHEN (NEW.metadata->>'federated' IS DISTINCT FROM 'true')
    EXECUTE FUNCTION handle_outgoing_messages();
```

### **Key Benefits:**
- **No dispatcher complexity**
- **PostgreSQL evaluates WHEN clause BEFORE calling function**
- **Clean separation: trigger only fires for outgoing content**
- **No federation loops possible**

---

## **🔧 Implementation Plan**

### **Phase 1: Fix Messages Trigger** ⏱️ *URGENT*
```sql
-- Drop broken dispatcher
DROP TRIGGER IF EXISTS trg_handle_messages ON messages;
DROP FUNCTION IF EXISTS handle_messages();

-- Create proper conditional trigger
CREATE TRIGGER trg_handle_outgoing_messages
    AFTER INSERT ON messages
    FOR EACH ROW
    WHEN (NEW.metadata->>'federated' IS DISTINCT FROM 'true')
    EXECUTE FUNCTION handle_outgoing_messages();
```

### **Phase 2: Verify Posts Trigger** ⏱️ *HIGH*
```sql
-- Ensure posts trigger has proper WHEN condition
DROP TRIGGER IF EXISTS trg_handle_post_federation ON posts;

CREATE TRIGGER trg_handle_post_federation
    AFTER INSERT ON posts
    FOR EACH ROW
    WHEN (NEW.is_local = true AND NEW.visibility != 'private')
    EXECUTE FUNCTION handle_post_federation();
```

### **Phase 3: Verify Incoming Processing** ⏱️ *HIGH*
Ensure incoming content is properly marked:

**Posts:**
```sql
-- ActivityPub → Posts should set
is_local = false  -- ✅ Prevents federation trigger
```

**Messages:**
```sql
-- ActivityPub → Messages should set
metadata = jsonb_build_object('federated', true)  -- ✅ Prevents federation trigger
```

---

## **📋 Ready-to-Run Fix Migration**

**File**: `db_migrations/091_fix_federation_loops.sql`

```sql
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
```

---

## **🛡️ Safety Verification**

### **Test Federation Loop Prevention:**
```sql
-- Test 1: Incoming message should NOT trigger federation
INSERT INTO messages (conversation_id, user_id, content, metadata)
VALUES (
    'test-conv'::uuid, 
    'test-user'::uuid, 
    '[{"type":"text","text":"test"}]'::jsonb,
    '{"federated": true}'::jsonb  -- ✅ Should NOT trigger federation
);

-- Test 2: Outgoing message should trigger federation  
INSERT INTO messages (conversation_id, user_id, content, metadata)
VALUES (
    'test-conv'::uuid, 
    'test-user'::uuid, 
    '[{"type":"text","text":"test"}]'::jsonb,
    '{}'::jsonb  -- ✅ Should trigger federation
);
```

### **Monitor for Loops:**
```sql
-- Check for suspicious federation queue activity
SELECT 
    target_domain,
    COUNT(*) as delivery_attempts,
    MAX(created_at) as latest_attempt
FROM federation_delivery_queue
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY target_domain
HAVING COUNT(*) > 100  -- Potential loop indicator
ORDER BY delivery_attempts DESC;
```

---

## **🏆 Expected Results**

### **Before Fix:**
- ❌ ALL inserts trigger federation  
- ❌ Incoming content re-federated
- ❌ Infinite loops possible
- ❌ Performance issues

### **After Fix:**
- ✅ Only outgoing content triggers federation
- ✅ Incoming content processed locally only  
- ✅ No federation loops possible
- ✅ Better performance (WHEN clause optimization)

---

## **⚠️ CRITICAL DEPLOYMENT NOTES**

1. **Deploy IMMEDIATELY** - federation loops can cause serious issues
2. **Monitor federation queue** for unusual activity after deployment  
3. **Test both directions**: outgoing federation still works, incoming doesn't re-federate
4. **Verify with ActivityPub test instances** if available

**🚨 This fix prevents a critical vulnerability that could cause infinite federation loops and potential service disruption!**