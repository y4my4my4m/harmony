# **Database Function Cleanup Analysis**

## **🔍 Analysis Overview**

**Total Functions Found**: ~160 functions in `all_db_functions.sql`
**Estimated Removals**: ~25-30 deprecated functions
**Cleanup Priority**: High (reduces maintenance burden)

---

## **📋 DEPRECATED FUNCTIONS TO REMOVE**

### **1. Content Conversion Functions (Post-Refactor)**
```sql
-- ❌ DEPRECATED: Marked with DEPRECATED comments
DROP FUNCTION IF EXISTS parse_activitypub_content_to_jsonb(text, jsonb);
DROP FUNCTION IF EXISTS convert_unified_content_to_activitypub_html(jsonb);
DROP FUNCTION IF EXISTS parse_activitypub_dm_content_to_jsonb(text, jsonb, text);
DROP FUNCTION IF EXISTS convert_ap_dm_to_jsonb(text, jsonb, text);

-- ✅ KEEP: Modern replacements
-- convert_ap_to_jsonb() ✅
-- convert_jsonb_to_ap() ✅
```

### **2. Old Notification Functions (Pre-Unification)**
```sql
-- ❌ DEPRECATED: Replaced by send_notification()
DROP FUNCTION IF EXISTS create_notification(uuid, varchar, varchar, text, jsonb);
DROP FUNCTION IF EXISTS create_notification_structured(uuid, varchar, jsonb, uuid, uuid, uuid, uuid, varchar);
DROP FUNCTION IF EXISTS create_simple_activitypub_notification(uuid, varchar, jsonb);
DROP FUNCTION IF EXISTS handle_chat_mention_notifications();
DROP FUNCTION IF EXISTS handle_mention_notifications();
DROP FUNCTION IF EXISTS handle_reaction_notifications();

-- ✅ KEEP: Modern unified system
-- send_notification() ✅
-- send_notification_to_user() ✅
-- send_notification_to_followers() ✅
-- send_notification_to_server_members() ✅
```

### **3. HTTP Signature Functions (Moved to Edge Functions)**
```sql
-- ❌ DEPRECATED: Moved to Supabase Edge Functions
DROP FUNCTION IF EXISTS create_http_signature(text, text, text, text);
DROP FUNCTION IF EXISTS sign_http_request(text, text, text);
DROP FUNCTION IF EXISTS validate_http_signature(text, text, text);

-- ✅ REPLACEMENT: HTTP signing now in supabase/functions/
```

### **4. Old Federation Handlers (Pre-Consolidation)**
```sql
-- ❌ DEPRECATED: Replaced by unified handlers
DROP FUNCTION IF EXISTS handle_unified_content_federation() CASCADE;
DROP FUNCTION IF EXISTS handle_old_post_federation() CASCADE;
DROP FUNCTION IF EXISTS process_activitypub_dm() CASCADE;

-- ✅ KEEP: Modern consolidated handlers
-- handle_post_federation() ✅
-- handle_message_federation() ✅
-- process_incoming_private_message() ✅
```

### **5. User1/User2 Legacy Functions (Post-Participants Migration)**
```sql
-- ❌ DEPRECATED: Old conversation system
DROP FUNCTION IF EXISTS get_conversation_by_users(uuid, uuid);
DROP FUNCTION IF EXISTS create_conversation_old(uuid, uuid);
DROP FUNCTION IF EXISTS find_dm_conversation_old(uuid, uuid);

-- ✅ KEEP: Modern participant-based system
-- get_or_create_dm_conversation() ✅
-- conversation_participants table ✅
```

### **6. Debug/Testing Functions**
```sql
-- ❌ REMOVE: Testing artifacts
DROP FUNCTION IF EXISTS debug_federation_test();
DROP FUNCTION IF EXISTS test_activitypub_parsing();
DROP FUNCTION IF EXISTS validate_migration_state();
```

### **7. Broken/Incomplete Functions**
```sql
-- ❌ REMOVE: Functions that were created but never finished
DROP FUNCTION IF EXISTS fetch_and_create_actor_profile(); -- My mistake
DROP FUNCTION IF EXISTS process_ap_activity_on_update(); -- Conflicts with working version
```

---

## **🔥 DEPRECATED TRIGGERS TO REMOVE**

### **1. Duplicate Federation Triggers (Post-Consolidation)**
```sql
-- ❌ DEPRECATED: Multiple triggers causing double federation
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;
DROP TRIGGER IF EXISTS handle_post_federation_trigger ON posts;
DROP TRIGGER IF EXISTS trigger_unified_message_federation ON messages;
DROP TRIGGER IF EXISTS trigger_handle_outgoing_messages ON messages;

-- ✅ KEEP: Modern specific triggers
-- trg_handle_post_federation ✅
-- trg_handle_message_federation ✅
```

### **2. Old Interaction Federation Triggers**
```sql
-- ❌ DEPRECATED: Old unified approach
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_reactions ON reactions;
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_follows ON follows;
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_post_interactions ON post_interactions;
DROP TRIGGER IF EXISTS handle_post_reactions_federation_trigger ON post_interactions;

-- ✅ KEEP: Working specific triggers (if any exist)
```

### **3. Duplicate Notification Triggers**
```sql
-- ❌ DEPRECATED: Multiple notification triggers
DROP TRIGGER IF EXISTS trigger_unified_notification_reactions ON reactions;
DROP TRIGGER IF EXISTS trigger_unified_notification_processing_reactions ON reactions;
DROP TRIGGER IF EXISTS handle_chat_mention_notifications_trigger ON messages;
DROP TRIGGER IF EXISTS handle_local_post_mention_notifications_trigger ON posts;
DROP TRIGGER IF EXISTS trigger_reaction_notifications ON reactions;

-- ✅ KEEP: Single unified notification system
```

### **4. Broken/Test Triggers (My Mistakes)**
```sql
-- ❌ REMOVE: Broken triggers I created
DROP TRIGGER IF EXISTS trg_handle_messages ON messages;
DROP TRIGGER IF EXISTS trg_handle_outgoing_messages ON messages;
DROP TRIGGER IF EXISTS trigger_reactions_federation ON reactions;
DROP TRIGGER IF EXISTS handle_reactions_federation_trigger ON reactions;
```

### **5. Old Legacy Triggers (Pre-Refactor)**
```sql
-- ❌ DEPRECATED: Old scattered approach
DROP TRIGGER IF EXISTS follows_federation_trigger ON follows;
DROP TRIGGER IF EXISTS unified_activitypub_interaction_processing ON post_interactions;
DROP TRIGGER IF EXISTS unified_activitypub_reply_processing ON posts;
DROP TRIGGER IF EXISTS profile_update_federation_trigger ON profiles;
```

---

## **✅ FUNCTIONS TO KEEP** 

### **Core ActivityPub Processing**
- `classify_activitypub_activity()` ✅ **PERFECT - Don't touch**
- `upsert_ap_activity()` ✅ **Working great**
- `process_incoming_private_message()` ✅ **Professional implementation**

### **Federation Handlers**
- `handle_post_federation()` ✅ **Consolidated & working**
- `handle_message_federation()` ✅ **Fixed & working**
- `queue_activity_for_federation()` ✅ **Core delivery system**

### **Profile Management**
- `create_federated_profile()` ✅ **Complete profile creation**
- `update_profile_metadata()` ✅ **Metadata handling**

### **Content Conversion**
- `convert_ap_to_jsonb()` ✅ **Universal converter**
- `convert_jsonb_to_ap()` ✅ **Universal converter**

### **Notification System**
- `send_notification()` ✅ **Modern unified system**
- `send_notification_to_user()` ✅ **Single user wrapper**

### **Message/Conversation System**
- `get_or_create_dm_conversation()` ✅ **Modern participant-based**
- `determine_message_federation_type()` ✅ **Clean classification**

---

## **🚀 CLEANUP EXECUTION PLAN**

### **Phase 1: Safe Function Removal** ⏱️ *5 minutes*
```sql
-- Drop deprecated wrapper functions (safe - have replacements)
DROP FUNCTION IF EXISTS parse_activitypub_content_to_jsonb(text, jsonb);
DROP FUNCTION IF EXISTS convert_unified_content_to_activitypub_html(jsonb);
DROP FUNCTION IF EXISTS parse_activitypub_dm_content_to_jsonb(text, jsonb, text);
```

### **Phase 2: Notification Cleanup** ⏱️ *3 minutes*
```sql
-- Drop old notification functions (replaced by send_notification)
DROP FUNCTION IF EXISTS create_notification(uuid, varchar, varchar, text, jsonb);
DROP FUNCTION IF EXISTS create_notification_structured(uuid, varchar, jsonb, uuid, uuid, uuid, uuid, varchar);
DROP FUNCTION IF EXISTS create_simple_activitypub_notification(uuid, varchar, jsonb);
```

### **Phase 3: Federation Cleanup** ⏱️ *5 minutes*
```sql
-- Drop HTTP signature functions (moved to edge functions)
DROP FUNCTION IF EXISTS create_http_signature(text, text, text, text);

-- Drop my broken functions
DROP FUNCTION IF EXISTS fetch_and_create_actor_profile();
DROP FUNCTION IF EXISTS process_ap_activity_on_update();
```

### **Phase 4: Legacy System Cleanup** ⏱️ *2 minutes*
```sql
-- Drop user1/user2 legacy functions
DROP FUNCTION IF EXISTS get_conversation_by_users(uuid, uuid);
DROP FUNCTION IF EXISTS create_conversation_old(uuid, uuid);
```

### **Phase 5: Trigger Cleanup** ⏱️ *5 minutes*
```sql
-- Drop duplicate federation triggers
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;
DROP TRIGGER IF EXISTS handle_post_federation_trigger ON posts;
DROP TRIGGER IF EXISTS trigger_unified_message_federation ON messages;

-- Drop broken/test triggers  
DROP TRIGGER IF EXISTS trg_handle_messages ON messages;
DROP TRIGGER IF EXISTS trg_handle_outgoing_messages ON messages;
DROP TRIGGER IF EXISTS trigger_reactions_federation ON reactions;

-- Drop old interaction triggers
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_reactions ON reactions;
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_follows ON follows;
```

---

## **📊 EXPECTED RESULTS**

### **Before Cleanup**
- **Total Functions**: ~160
- **Total Triggers**: ~32 (from migrations analysis)
- **Deprecated Functions**: ~25-30
- **Deprecated Triggers**: ~15-20
- **Maintenance Burden**: High

### **After Cleanup**
- **Total Functions**: ~130-135
- **Total Triggers**: ~10-15 (working triggers only)
- **Deprecated Functions**: 0
- **Deprecated Triggers**: 0
- **Maintenance Burden**: Low
- **Code Quality**: Professional & DRY

### **Performance Benefits**
- **Faster Schema Dumps**: Less metadata to process
- **Cleaner Function Lists**: Easier debugging
- **Reduced Confusion**: No deprecated alternatives

---

## **⚠️ SAFETY MEASURES**

### **Pre-Cleanup Verification**
```sql
-- Verify no active usage of deprecated functions
SELECT schemaname, viewname, definition
FROM pg_views 
WHERE definition LIKE '%parse_activitypub_content_to_jsonb%'
   OR definition LIKE '%convert_unified_content_to_activitypub_html%';
```

### **Backup Strategy**
```bash
# Backup current schema
pg_dump --schema-only harmony_db > schema_backup_pre_cleanup.sql

# Create function export
pg_dump --schema-only --section=pre-data harmony_db | grep "CREATE.*FUNCTION" > functions_backup.sql
```

### **Rollback Plan**
```sql
-- If issues arise, restore from backup
\i schema_backup_pre_cleanup.sql
```

---

## **🎯 READY-TO-RUN CLEANUP MIGRATION**

**File**: `db_migrations/090_deprecated_function_cleanup.sql`

```sql
-- Migration 090: Comprehensive Deprecated Function Cleanup
-- Removes all deprecated functions identified in DATABASE_CLEANUP_ANALYSIS.md

BEGIN;

-- =====================================================
-- PHASE 1: DEPRECATED CONTENT CONVERSION FUNCTIONS
-- =====================================================

DROP FUNCTION IF EXISTS parse_activitypub_content_to_jsonb(text, jsonb);
DROP FUNCTION IF EXISTS convert_unified_content_to_activitypub_html(jsonb);
DROP FUNCTION IF EXISTS parse_activitypub_dm_content_to_jsonb(text, jsonb, text);
DROP FUNCTION IF EXISTS convert_ap_dm_to_jsonb(text, jsonb, text);

-- =====================================================
-- PHASE 2: OLD NOTIFICATION FUNCTIONS
-- =====================================================

DROP FUNCTION IF EXISTS create_notification(uuid, varchar, varchar, text, jsonb);
DROP FUNCTION IF EXISTS create_notification_structured(uuid, varchar, jsonb, uuid, uuid, uuid, uuid, varchar);
DROP FUNCTION IF EXISTS create_simple_activitypub_notification(uuid, varchar, jsonb);
DROP FUNCTION IF EXISTS handle_chat_mention_notifications();
DROP FUNCTION IF EXISTS handle_mention_notifications();
DROP FUNCTION IF EXISTS handle_reaction_notifications();

-- =====================================================
-- PHASE 3: HTTP SIGNATURE FUNCTIONS (Moved to Edge Functions)
-- =====================================================

DROP FUNCTION IF EXISTS create_http_signature(text, text, text, text);
DROP FUNCTION IF EXISTS sign_http_request(text, text, text);
DROP FUNCTION IF EXISTS validate_http_signature(text, text, text);

-- =====================================================
-- PHASE 4: BROKEN/DUPLICATE FUNCTIONS (My Mistakes)
-- =====================================================

DROP FUNCTION IF EXISTS fetch_and_create_actor_profile(text);
DROP FUNCTION IF EXISTS process_ap_activity_on_update();

-- =====================================================
-- PHASE 5: USER1/USER2 LEGACY FUNCTIONS
-- =====================================================

DROP FUNCTION IF EXISTS get_conversation_by_users(uuid, uuid);
DROP FUNCTION IF EXISTS create_conversation_old(uuid, uuid);
DROP FUNCTION IF EXISTS find_dm_conversation_old(uuid, uuid);

-- =====================================================
-- PHASE 6: DEBUG/TESTING FUNCTIONS
-- =====================================================

DROP FUNCTION IF EXISTS debug_federation_test();
DROP FUNCTION IF EXISTS test_activitypub_parsing();
DROP FUNCTION IF EXISTS validate_migration_state();

-- =====================================================
-- PHASE 7: DUPLICATE FEDERATION TRIGGERS
-- =====================================================

DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;
DROP TRIGGER IF EXISTS handle_post_federation_trigger ON posts;
DROP TRIGGER IF EXISTS trigger_unified_message_federation ON messages;
DROP TRIGGER IF EXISTS trigger_handle_outgoing_messages ON messages;

-- =====================================================
-- PHASE 8: OLD INTERACTION FEDERATION TRIGGERS
-- =====================================================

DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_reactions ON reactions;
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_follows ON follows;
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_post_interactions ON post_interactions;
DROP TRIGGER IF EXISTS handle_post_reactions_federation_trigger ON post_interactions;

-- =====================================================
-- PHASE 9: DUPLICATE NOTIFICATION TRIGGERS
-- =====================================================

DROP TRIGGER IF EXISTS trigger_unified_notification_reactions ON reactions;
DROP TRIGGER IF EXISTS trigger_unified_notification_processing_reactions ON reactions;
DROP TRIGGER IF EXISTS handle_chat_mention_notifications_trigger ON messages;
DROP TRIGGER IF EXISTS handle_local_post_mention_notifications_trigger ON posts;
DROP TRIGGER IF EXISTS trigger_reaction_notifications ON reactions;

-- =====================================================
-- PHASE 10: BROKEN/TEST TRIGGERS (My Mistakes)
-- =====================================================

DROP TRIGGER IF EXISTS trg_handle_messages ON messages;
DROP TRIGGER IF EXISTS trg_handle_outgoing_messages ON messages;
DROP TRIGGER IF EXISTS trigger_reactions_federation ON reactions;
DROP TRIGGER IF EXISTS handle_reactions_federation_trigger ON reactions;

-- =====================================================
-- PHASE 11: OLD LEGACY TRIGGERS (Pre-Refactor)
-- =====================================================

DROP TRIGGER IF EXISTS follows_federation_trigger ON follows;
DROP TRIGGER IF EXISTS unified_activitypub_interaction_processing ON post_interactions;
DROP TRIGGER IF EXISTS unified_activitypub_reply_processing ON posts;
DROP TRIGGER IF EXISTS profile_update_federation_trigger ON profiles;

-- =====================================================
-- VERIFICATION
-- =====================================================

DO $$
DECLARE
    total_functions INTEGER;
    total_triggers INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_functions
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
    AND p.prokind = 'f';
    
    SELECT COUNT(*) INTO total_triggers
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
    AND NOT t.tgisinternal;
    
    RAISE NOTICE '✅ Cleanup Complete!';
    RAISE NOTICE 'Total functions remaining: %', total_functions;
    RAISE NOTICE 'Total triggers remaining: %', total_triggers;
    RAISE NOTICE 'Estimated reduction: ~25 functions + ~15 triggers removed';
    RAISE NOTICE '';
    RAISE NOTICE '🎯 KEPT ALL WORKING FUNCTIONS:';
    RAISE NOTICE '  ✅ classify_activitypub_activity()';
    RAISE NOTICE '  ✅ handle_post_federation()';
    RAISE NOTICE '  ✅ handle_message_federation()';
    RAISE NOTICE '  ✅ send_notification()';
    RAISE NOTICE '  ✅ convert_ap_to_jsonb()';
    RAISE NOTICE '  ✅ convert_jsonb_to_ap()';
    RAISE NOTICE '';
    RAISE NOTICE '🎯 KEPT WORKING TRIGGERS:';
    RAISE NOTICE '  ✅ trg_handle_post_federation';
    RAISE NOTICE '  ✅ trg_handle_message_federation';
    RAISE NOTICE '  ✅ Working notification triggers';
    RAISE NOTICE '';
    RAISE NOTICE '🗑️ REMOVED ALL DEPRECATED:';
    RAISE NOTICE '  ❌ parse_activitypub_content_to_jsonb()';
    RAISE NOTICE '  ❌ create_notification_structured()';
    RAISE NOTICE '  ❌ create_http_signature()';
    RAISE NOTICE '  ❌ fetch_and_create_actor_profile()';
    RAISE NOTICE '  ❌ trigger_unified_content_federation';
    RAISE NOTICE '  ❌ trigger_unified_interaction_federation_*';
    RAISE NOTICE '  ❌ handle_post_federation_trigger';
    RAISE NOTICE '';
    RAISE NOTICE '💪 Database is now cleaner and more maintainable!';
END $$;

COMMIT;
```

---

## **✅ POST-CLEANUP VERIFICATION**

### **Function Count Check**
```sql
-- Should show ~130-135 functions (down from ~160)
SELECT COUNT(*) as total_functions
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.prokind = 'f';
```

### **Trigger Count Check**
```sql
-- Should show ~10-15 triggers (down from ~32)
SELECT COUNT(*) as total_triggers
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public' AND NOT t.tgisinternal;
```

### **Core Function Verification**
```sql
-- Verify all critical functions still exist
SELECT proname FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' 
AND proname IN (
    'classify_activitypub_activity',
    'handle_post_federation',
    'handle_message_federation',
    'send_notification',
    'convert_ap_to_jsonb',
    'convert_jsonb_to_ap'
);
```

### **Core Trigger Verification**
```sql
-- Verify critical triggers still exist
SELECT t.tgname, c.relname as table_name
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public' 
AND NOT t.tgisinternal
AND t.tgname IN (
    'trg_handle_post_federation',
    'trg_handle_message_federation'
);
```

### **No References Check**
```sql
-- Verify no views reference deleted functions
SELECT schemaname, viewname 
FROM pg_views 
WHERE definition LIKE '%parse_activitypub_content_to_jsonb%'
   OR definition LIKE '%create_notification_structured%';

-- Verify no old triggers remain
SELECT t.tgname, c.relname as table_name
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public' 
AND NOT t.tgisinternal
AND (t.tgname LIKE '%unified%' OR t.tgname LIKE '%old%' OR t.tgname LIKE '%deprecated%');
```

---

## **🏆 SUCCESS CRITERIA**

- ✅ **~25 deprecated functions removed**
- ✅ **~15 deprecated triggers removed**
- ✅ **All working functions preserved**
- ✅ **All working triggers preserved**
- ✅ **No broken references**
- ✅ **Database size reduced**
- ✅ **Maintenance burden decreased**
- ✅ **Professional, DRY codebase**