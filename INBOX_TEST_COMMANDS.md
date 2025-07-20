# INBOX PROCESSING TEST & FIX

## 🚀 **STEP 0: Apply the Fix Migration**

First, run the migration to add debug functions:

```bash
# Apply the new migrations
supabase db reset
# OR manually run: 
# - db_migrations/042_fix_inbox_processing_trigger.sql
# - db_migrations/043_fix_send_notification_function.sql
```

## 🧪 **STEP 1: Diagnose the Issue**

Run this to check what's happening:

```sql
-- Check inbox health (run in Supabase SQL editor)
SELECT * FROM check_inbox_health();
```

**Expected results:**
- `stuck_in_received` should be **0**
- `processed` should be **> 0** if federation is working

## 🔧 **STEP 2: Fix Stuck Activities**

If you see activities stuck in `received` status:

```sql
-- Process all stuck activities
SELECT * FROM process_stuck_activities();
```

This will return `(processed_count, failed_count)`

## 🚨 **STEP 3: Check for Missing Trigger**

If the above fails, the trigger might be missing:

```sql
-- Verify processing trigger exists
SELECT 
    trigger_name,
    event_manipulation 
FROM information_schema.triggers 
WHERE event_object_table = 'ap_activities'
  AND trigger_name = 'unified_activitypub_processing_trigger';
```

Should return: `unified_activitypub_processing_trigger | UPDATE`

## 🚨 **STEP 3B: Test Notification Function**

Verify the send_notification function works with existing schema:

```sql
-- Test the fixed function
SELECT send_notification(
    'test_notification',
    ARRAY['00000000-0000-0000-0000-000000000001']::uuid[],
    '{"message": "Function test"}'::jsonb,
    NULL::uuid, -- server_id (stored in data JSON)
    NULL::uuid, -- channel_id (stored in data JSON)
    NULL::uuid, -- conversation_id (stored in data JSON)
    NULL::uuid, -- from_user_id (stored in data JSON)
    'normal' -- priority (stored in data JSON)
);

-- Clean up test
DELETE FROM notifications WHERE type = 'test_notification';
```

Should complete without "column does not exist" errors

## 📊 **STEP 4: Monitor Incoming Activities**

Watch for new activities:

```sql
-- Check recent activities (last 10 minutes)
SELECT 
    ap_id,
    ap_type,
    actor_ap_id,
    status,
    created_at,
    updated_at
FROM ap_activities 
WHERE created_at > NOW() - INTERVAL '10 minutes'
  AND is_local = false
ORDER BY created_at DESC;
```

## 🎯 **QUICK MANUAL TEST**

If you want to manually trigger processing of a specific activity:

```sql
-- Replace 'ACTIVITY_ID_HERE' with actual ap_id
UPDATE ap_activities 
SET status = 'processing' 
WHERE ap_id = 'ACTIVITY_ID_HERE'
  AND status = 'received';
```

This should trigger the processing function immediately.

## 📱 **WHAT TO EXPECT**

When working correctly:
1. Remote posts/messages appear in your local timeline/conversations
2. Follow requests are processed automatically  
3. Reactions and interactions sync from remote servers
4. No activities stuck in `received` status for more than a few seconds
5. **No more "column server_id does not exist" errors** ✅

## 🎯 **ROOT CAUSE IDENTIFIED**

The issue was that `send_notification()` function was trying to insert into columns that don't exist in the `notifications` table:
- The function expected: `server_id`, `channel_id`, `conversation_id`, `from_user_id`, `priority` columns
- The actual table has: `id`, `user_id`, `type`, `data`, `is_read`, `is_clicked`, `created_at`, `updated_at`, `expires_at`, `read_at`

When ActivityPub processing tried to create notifications (for mentions, follows, etc.), the notification creation failed with "column does not exist" errors, causing the entire activity processing to fail and activities to get stuck in `received` status.

**Migration 043 fixes this by:**
- Updating `send_notification()` to work with the existing table schema
- Storing contextual data (`server_id`, `channel_id`, etc.) in the JSONB `data` column
- Maintaining all notification preference logic
- Keeping the clean, modern notification architecture