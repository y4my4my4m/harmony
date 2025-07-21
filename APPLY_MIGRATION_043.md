# 🚀 **Apply Migration 043 - Fix Notification Function**

## 🎯 **The Problem**
Your ActivityPub processing is failing with:
```
ERROR: column "server_id" of relation "notifications" does not exist
```

## 🔧 **The Solution**
Migration `043_fix_send_notification_function.sql` fixes the `send_notification()` function to work with your existing table schema.

## 📋 **How to Apply**

### **Option 1: Full Database Reset (Recommended)**
```bash
# This applies ALL migrations including 043
supabase db reset
```

### **Option 2: Apply Just Migration 043**
If you don't want to reset everything, run the migration manually:

1. **Open Supabase SQL Editor**
2. **Copy the entire contents** of `db_migrations/043_fix_send_notification_function.sql`
3. **Paste and execute** in the SQL editor

### **Option 3: Command Line (if you have psql)**
```bash
# Connect to your database and run the migration
psql "your-database-connection-string" -f db_migrations/043_fix_send_notification_function.sql
```

## ✅ **Verify the Fix**

After applying the migration, test it:

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

## 🎯 **Expected Result**

After applying migration 043:
- ✅ No more "column server_id does not exist" errors
- ✅ ActivityPub mentions create notifications properly  
- ✅ All context data stored in JSONB `data` column
- ✅ All notification preferences and logic still work

## 🚨 **If Still Broken**

If you still see the error after applying the migration, check that the function was actually updated:

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