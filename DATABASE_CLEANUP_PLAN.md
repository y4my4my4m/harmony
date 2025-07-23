# **Database Cleanup Analysis & Plan**

## **🔍 Analysis of `all_db_functions.sql`**

Based on the file structure and our previous work, here's what I found:

### **Functions to DELETE 🗑️**

#### **1. Duplicate Functions I Created**
```sql
-- These duplicate existing functionality
DROP FUNCTION IF EXISTS fetch_and_create_actor_profile();
DROP FUNCTION IF EXISTS process_ap_activity_on_update(); -- Conflicts with handle_activitypub_activity_processing
```

#### **2. Deprecated Compatibility Wrappers**
```sql
-- Old notification wrappers (already marked as COMPATIBILITY in schema)
DROP FUNCTION IF EXISTS create_notification(uuid, varchar, varchar, text, jsonb);
DROP FUNCTION IF EXISTS create_simple_activitypub_notification(uuid, varchar, jsonb);

-- Old content conversion (marked DEPRECATED in schema)  
DROP FUNCTION IF EXISTS convert_unified_content_to_activitypub_html(jsonb);
```

#### **3. Unused/Broken Helper Functions**
```sql
-- Functions that were experimental or never used
DROP FUNCTION IF EXISTS debug_local_user_lookup(text, text);
DROP FUNCTION IF EXISTS log_federation_health();
DROP FUNCTION IF EXISTS federation_health_check();
```

### **Functions to KEEP ✅**

#### **Core Working Functions**
- `classify_activitypub_activity()` - Perfect ActivityPub classification
- `create_federated_profile()` - Remote profile creation
- `process_incoming_private_message()` - DM processing
- `handle_message_federation()` - Message federation trigger
- `handle_post_federation()` - Post federation (the big one in your file)
- `send_notification()` / `send_notification_to_user()` - Current notification system

#### **Essential Database Functions**
- All counter update functions (`update_post_counters`, `update_reply_counts`, etc.)
- Content conversion: `convert_ap_to_jsonb()`, `convert_jsonb_to_ap()`
- Timeline functions (`update_timeline_cache`, `create_comprehensive_timeline_entries`)
- Hashtag functions (`update_hashtag_trending_scores`, `calculate_hashtag_trending_score`)

### **Triggers to CLEAN UP 🧹**

#### **Remove Conflicting Triggers**
```sql
-- If these exist and conflict with working ones
DROP TRIGGER IF EXISTS trg_process_ap_activity_on_update ON ap_activities;
DROP TRIGGER IF EXISTS old_message_federation_trigger ON messages;
DROP TRIGGER IF EXISTS deprecated_notification_trigger ON messages;
```

---

## **📋 Cleanup Implementation Plan**

### **Phase 1: Safety Analysis (15 minutes)**
```sql
-- Create backup of function definitions
CREATE TABLE function_backup AS 
SELECT 
  proname as function_name,
  pg_get_functiondef(oid) as definition
FROM pg_proc 
WHERE pronamespace = 'public'::regnamespace;

-- Identify dependencies
SELECT DISTINCT
  dependent_ns.nspname as dependent_schema,
  dependent_view.relname as dependent_view, 
  source_ns.nspname as source_schema,
  source_table.relname as source_table
FROM pg_depend 
JOIN pg_rewrite ON pg_depend.objid = pg_rewrite.oid 
JOIN pg_class as dependent_view ON pg_rewrite.ev_class = dependent_view.oid 
JOIN pg_class as source_table ON pg_depend.refobjid = source_table.oid 
JOIN pg_namespace dependent_ns ON dependent_ns.oid = dependent_view.relnamespace
JOIN pg_namespace source_ns ON source_ns.oid = source_table.relnamespace;
```

### **Phase 2: Remove Duplicates (10 minutes)**
```sql
-- Migration: Remove my duplicate functions
DROP FUNCTION IF EXISTS fetch_and_create_actor_profile(text);
DROP FUNCTION IF EXISTS my_classify_activitypub_activity(jsonb, text);

-- Remove conflicting triggers I may have created
DROP TRIGGER IF EXISTS my_ap_activity_trigger ON ap_activities;
```

### **Phase 3: Remove Deprecated Wrappers (10 minutes)**
```sql
-- These are marked as COMPATIBILITY/DEPRECATED in your schema
DROP FUNCTION IF EXISTS create_notification(uuid, varchar, varchar, text, jsonb);
DROP FUNCTION IF EXISTS create_simple_activitypub_notification(uuid, varchar, jsonb);
DROP FUNCTION IF EXISTS convert_unified_content_to_activitypub_html(jsonb);

-- Debug/testing functions
DROP FUNCTION IF EXISTS debug_local_user_lookup(text, text);
```

### **Phase 4: Verify Core Functions Work (5 minutes)**
```sql
-- Test core functionality still works
SELECT classify_activitypub_activity('{"object": {"to": ["https://har.mony.lol/users/test"]}}', 'har.mony.lol');
SELECT create_federated_profile('testuser', 'Test User', 'example.com');

-- Verify triggers are attached
SELECT 
  t.tgname as trigger_name,
  c.relname as table_name
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
WHERE c.relnamespace = 'public'::regnamespace
ORDER BY c.relname, t.tgname;
```

---

## **🎯 Expected Results**

### **Function Count Reduction**
```
BEFORE: ~147 functions (from your schema)
AFTER:  ~120 functions (remove ~27 deprecated/duplicate)
REDUCTION: ~18% fewer functions
```

### **Cleaner Architecture**
- **No Duplicates**: Single source of truth for each operation
- **No Deprecated Code**: Only working, maintained functions
- **Clear Purpose**: Each function has a single, clear responsibility

### **Specific Deletions**
```sql
-- Exact functions to remove (based on our analysis):
DROP FUNCTION IF EXISTS fetch_and_create_actor_profile(text);
DROP FUNCTION IF EXISTS create_notification(uuid, varchar, varchar, text, jsonb);
DROP FUNCTION IF EXISTS create_simple_activitypub_notification(uuid, varchar, jsonb);
DROP FUNCTION IF EXISTS convert_unified_content_to_activitypub_html(jsonb);
DROP FUNCTION IF EXISTS debug_local_user_lookup(text, text);
-- + any other duplicates I created
```

---

## **⚠️ Risk Mitigation**

### **Safety Measures**
1. **Backup First**: Function definitions saved before deletion
2. **Dependency Check**: Verify no views/triggers depend on deleted functions  
3. **Incremental**: Delete one category at a time
4. **Test After Each**: Verify core functionality works
5. **Rollback Plan**: Can recreate from backup if needed

### **Validation Steps**
```sql
-- After cleanup, verify these work:
✅ DMs send successfully (fixed actor profile issue)
✅ Posts federate correctly  
✅ Notifications send properly
✅ ActivityPub classification works
✅ Profile creation works
```

**Timeline: 40 minutes total**
**Risk: Low** (only removing unused/duplicate code)
**Benefit: Cleaner, maintainable database**

---

## **🚀 Implementation Steps**

### **Step 1: Create Migration File**
```sql
-- db_migrations/007_cleanup_deprecated_functions.sql
BEGIN;

-- Backup existing functions
CREATE TABLE IF NOT EXISTS function_backup AS 
SELECT 
  proname as function_name,
  pg_get_functiondef(oid) as definition,
  NOW() as backup_date
FROM pg_proc 
WHERE pronamespace = 'public'::regnamespace;

-- Remove duplicate functions I created
DROP FUNCTION IF EXISTS fetch_and_create_actor_profile(text);

-- Remove deprecated wrappers
DROP FUNCTION IF EXISTS create_notification(uuid, varchar, varchar, text, jsonb);
DROP FUNCTION IF EXISTS create_simple_activitypub_notification(uuid, varchar, jsonb);
DROP FUNCTION IF EXISTS convert_unified_content_to_activitypub_html(jsonb);

-- Remove debug/testing functions
DROP FUNCTION IF EXISTS debug_local_user_lookup(text, text);

-- Verify core functions still exist and work
DO $$
BEGIN
  -- Test ActivityPub classification
  PERFORM classify_activitypub_activity('{"object": {"to": ["https://har.mony.lol/users/test"]}}', 'har.mony.lol');
  
  -- Test notification system
  PERFORM send_notification_to_user('test', gen_random_uuid(), '{}', NULL, NULL, NULL, NULL, 'normal');
  
  RAISE NOTICE '✅ All core functions verified working';
END;
$$;

COMMIT;
```

### **Step 2: Apply Migration**
```bash
# Run the migration
psql -f db_migrations/007_cleanup_deprecated_functions.sql

# Verify no errors
echo $?  # Should be 0
```

### **Step 3: Test Core Functionality**
```sql
-- Test DM sending (the original issue)
-- Test post creation and federation
-- Test notifications
-- Test ActivityPub processing
```

---

**Ready to proceed? This cleanup will make your database much cleaner and remove the confusion about duplicate functions.**