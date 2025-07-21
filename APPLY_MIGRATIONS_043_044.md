# 🚀 **Apply Migrations 043 & 044 - Fix Notifications & DM Federation**

## 🎯 **The Problems**
1. **ActivityPub notifications failing** with:
   ```
   ERROR: column "server_id" of relation "notifications" does not exist
   ```

2. **Federated DMs not working** (sending or receiving) because:
   - Missing trigger to call DM federation function
   - `handle_outgoing_messages()` function exists but no trigger calls it

## 🔧 **The Solutions**
- **Migration 043**: Fixes `send_notification()` function to work with your existing table schema
- **Migration 044**: Creates missing trigger for DM federation (`trigger_handle_outgoing_messages`)

## 📋 **How to Apply**

### **Option 1: Full Database Reset (Recommended)**
```bash
# This applies ALL migrations including 043 & 044
supabase db reset
```

### **Option 2: Apply Just Migrations 043 & 044**
If you don't want to reset everything, run the migrations manually:

1. **Open Supabase SQL Editor**
2. **Copy and execute** `db_migrations/043_fix_send_notification_function.sql`
3. **Copy and execute** `db_migrations/044_fix_dm_federation_triggers.sql`

### **Option 3: Command Line (if you have psql)**
```bash
# Connect to your database and run the migrations
psql "your-database-connection-string" -f db_migrations/043_fix_send_notification_function.sql
psql "your-database-connection-string" -f db_migrations/044_fix_dm_federation_triggers.sql
```

## ✅ **Verify the Fix**

After applying the migrations, test them:

### **Test Notification Function (043)**
```sql
-- This should complete without errors
SELECT send_notification(
    'test_notification',
    ARRAY['your-user-id-here']::uuid[],
    '{"message": "Test after fix"}'::jsonb,
    NULL::uuid, 
    NULL::uuid, 
    NULL::uuid, 
    NULL::uuid, 
    'normal'
);

-- Clean up
DELETE FROM notifications WHERE type = 'test_notification';
```

### **Test DM Federation Trigger (044)**
```sql
-- Check that the trigger exists
SELECT 
    trigger_name,
    event_manipulation,
    action_statement
FROM information_schema.triggers 
WHERE event_object_table = 'messages'
  AND trigger_name = 'trigger_handle_outgoing_messages';

-- Should return: trigger_handle_outgoing_messages | INSERT | EXECUTE FUNCTION handle_outgoing_messages()
```

## 🎯 **Expected Result**

After applying migrations 043 & 044:
- ✅ **No more "column server_id does not exist" errors** (043)
- ✅ **ActivityPub mentions create notifications properly** (043)
- ✅ **All context data stored in JSONB `data` column** (043)
- ✅ **All notification preferences and logic still work** (043)
- ✅ **Federated DMs start working for sending** (044)
- ✅ **Federated DMs start working for receiving** (044)
- ✅ **DM notifications to remote users work** (044)

## 🚨 **If Still Broken**

If you still see errors after applying the migrations:

### **Check the notification function was updated:**
```sql
-- Check the function source
SELECT pg_get_functiondef(oid) 
FROM pg_proc 
WHERE proname = 'send_notification' 
  AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
```

The function should have this INSERT statement:
```sql
INSERT INTO notifications (type, user_id, data, created_at)  -- ✅ good
```

NOT this:
```sql
INSERT INTO notifications (type, user_id, data, server_id, channel_id, ...)  -- ❌ bad
```

### **Check the DM trigger was created:**
```sql
-- Verify DM federation trigger
SELECT count(*) 
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
WHERE c.relname = 'messages' 
  AND t.tgname = 'trigger_handle_outgoing_messages'
  AND t.tgenabled = 'O';

-- Should return: 1
```

## 🎯 **Test Federated DMs**

1. **Send a DM to a remote user** - should now federate automatically
2. **Have a remote user send you a DM** - should appear in your conversations
3. **Check ActivityPub processing logs** - should see successful DM processing messages