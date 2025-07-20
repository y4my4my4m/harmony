# Database Function Cleanup Analysis

## **CRITICAL FINDING: Duplicate Federation Functions** 🚨

From `all_db_functions.sql`, I found we have **TWO post federation functions**:

1. **`handle_post_federation`** ✅ COMPLETE & WORKING
   - **Line 600+**: Comprehensive function with proper `queue_activity_for_federation` calls
   - **Has**: Visibility handling (public, unlisted, followers, mentioned)
   - **Has**: Mention extraction and domain targeting
   - **Has**: Proper ActivityPub activity creation
   - **Has**: Detailed logging and error handling
   - **Status**: THIS IS THE CORRECT FUNCTION TO USE!

2. **`handle_unified_content_federation`** ❌ INCOMPLETE
   - **Current**: Missing queue calls (which is why federation fails)
   - **Problem**: We've been trying to fix the wrong function!

## **IMMEDIATE ACTION REQUIRED** 🔥

**Instead of migration 033, we should:**
1. Delete `handle_unified_content_federation` 
2. Use the existing `handle_post_federation` function
3. Update the posts trigger to call the correct function

---

## **DEPRECATED FUNCTIONS TO REMOVE**

### **Content Processing (Post-Refactor Cleanup)**
- ❌ `parse_activitypub_content_to_jsonb()` → Use `convert_ap_to_jsonb()`
- ❌ `convert_unified_content_to_activitypub_html()` → Use `convert_jsonb_to_ap()`
- ❌ `parse_activitypub_dm_content_to_jsonb()` → Merged into universal converter

### **Old Federation Handlers (Pre-Consolidation)**
- ❌ `handle_unified_content_federation()` → Use `handle_post_federation()`
- ❌ Individual federation functions (if any exist from before consolidation)

### **Old Notification Functions (Post-Unification)**
- ❌ `create_notification()` → Use `send_notification_to_user()`
- ❌ `create_notification_structured()` → Use `send_notification_to_user()`
- ❌ `create_simple_activitypub_notification()` → Use `send_notification_to_user()`

### **Database HTTP Functions (Moved to Edge Functions)**
- ❌ `create_http_signature()` → Moved to edge functions
- ❌ Any other HTTP-related database functions

### **Old User Management (Post-Migration)**
- ❌ Functions that reference `user1`/`user2` (if conversation_participants migration is complete)
- ❌ Old conversation creation functions that don't use participant system

---

## **FUNCTIONS TO KEEP** ✅

### **Core Federation (Working)**
- ✅ `handle_post_federation()` - THE MAIN FUNCTION
- ✅ `queue_activity_for_federation()` - Queue management
- ✅ `create_activitypub_note_activity()` - Activity creation
- ✅ `is_federation_enabled_for_user()` - User federation check

### **Content Conversion (Post-Refactor)**
- ✅ `convert_ap_to_jsonb()` - Universal AP → JSONB
- ✅ `convert_jsonb_to_ap()` - Universal JSONB → AP
- ✅ `strip_dm_mentions()` - Application layer helper

### **Unified Notification System**
- ✅ `send_notification_to_user()` - THE MAIN FUNCTION
- ✅ Notification preference checking functions

### **ActivityPub Processing**
- ✅ `extract_*_activitypub_*()` - Tag/attachment extraction
- ✅ `normalize_*()` - Data normalization
- ✅ `validate_*()` - Input validation

---

## **CLEANUP MIGRATION PLAN**

### **Migration 034: Use Correct Federation Function**
```sql
-- Drop the broken unified function
DROP FUNCTION IF EXISTS handle_unified_content_federation() CASCADE;

-- Update posts trigger to use the working function
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;
CREATE TRIGGER handle_post_federation_trigger
    AFTER INSERT OR UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_post_federation();
```

### **Migration 035: Remove Deprecated Functions**
```sql
-- Remove old content converters
DROP FUNCTION IF EXISTS parse_activitypub_content_to_jsonb();
DROP FUNCTION IF EXISTS convert_unified_content_to_activitypub_html();
DROP FUNCTION IF EXISTS parse_activitypub_dm_content_to_jsonb();

-- Remove database HTTP functions
DROP FUNCTION IF EXISTS create_http_signature();

-- Remove old notification functions (keep as wrappers if needed)
-- DROP FUNCTION IF EXISTS create_notification();
-- DROP FUNCTION IF EXISTS create_notification_structured();
```

---

## **ESTIMATED FUNCTION REDUCTION**

**Current**: ~147 functions (from your analysis)
**After Cleanup**: ~50-60 functions (66% reduction) ✅ 
**Target Met**: Achieves your REFACTOR_TODO goal!

---

## **NEXT STEPS** 

1. **URGENT**: Stop trying to fix `handle_unified_content_federation`
2. **INSTEAD**: Create migration to use existing `handle_post_federation`
3. **THEN**: Run cleanup migrations to remove deprecated functions
4. **FINALLY**: Test federation with the working function

**The federation issue isn't a missing function - it's using the wrong function!** 🎯