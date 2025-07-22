# 🎯 TEST: Migration 079 - Revert to Working Version

## What This Does
Reverts `handle_outgoing_messages()` trigger to the **exact version that was working** before my changes.

## Key Differences from Broken Version
1. ✅ **Uses `federation_delivery_queue`** (not `ap_activities`)
2. ✅ **Uses old column names** (`activity_uuid`, `sender_profile_id`, etc.)
3. ✅ **Uses working federation format** (the old system that was actually working)

## Test Checklist

### Test 1: Local Message Display ✅
- [ ] Send a DM to the remote user
- [ ] **IMMEDIATELY**: Can you see the message in the conversation?
- [ ] **AFTER PAGE RELOAD**: Can you still see the message?

### Test 2: Remote Federation ✅  
- [ ] Send a DM to the remote user
- [ ] **CHECK**: Does the remote user receive it?
- [ ] **CHECK**: No errors in console about `ap_activities` columns?

### Test 3: Database Check ✅
```sql
-- Check federation queue (should have entries)
SELECT activity_uuid, target_inbox, delivery_type, created_at 
FROM federation_delivery_queue 
ORDER BY created_at DESC LIMIT 5;

-- Check messages (should be saved)
SELECT id, conversation_id, content, created_at 
FROM messages 
WHERE conversation_id = 'YOUR_CONVERSATION_ID'
ORDER BY created_at DESC LIMIT 5;
```

## Expected Results
- ✅ **Local Display**: Messages appear immediately AND after reload
- ✅ **Remote Federation**: Remote user receives DMs  
- ✅ **No SQL Errors**: No more `ap_activities` column errors

## If This Fixes Everything
This means my migration 074 was using the wrong federation system entirely. The working system was using `federation_delivery_queue`, not `ap_activities`.

## Run Migration
```bash
# Apply the revert
psql your_database -f db_migrations/079_revert_to_working_trigger.sql
```