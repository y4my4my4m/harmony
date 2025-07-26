# Outgoing Emoji Reaction Federation Fix

## Problem
Outgoing emoji reactions were not federating properly to remote instances, while incoming reactions were working correctly.

## Root Cause
The `handle_post_interaction_federation()` function in `emoji_reaction_federation_complete.sql` was using incorrect column names when inserting into the `federation_delivery_queue` table.

## Issues Found

### 1. Wrong Column Names in INSERT Statement
The function was trying to insert into columns that don't exist:
- `activity_type` → should be inserted individually per domain
- `target_domains` → should be `target_domain` (singular)
- `actor_id` → should be `actor_username` and `actor_domain`
- `object_id`, `object_type` → not needed
- `metadata` → not used by delivery system

### 2. Array vs Individual Records
The old code was trying to insert an array of target domains into `target_domains`, but the delivery queue expects one record per domain with individual `target_domain` values.

## Fix Applied

Updated the INSERT logic in `handle_post_interaction_federation()` to:

1. **Use correct column names** that match the `federation_delivery_queue` table schema:
   - `activity_id` (uuid)
   - `activity_data` (jsonb) - the complete ActivityPub activity
   - `target_domain` (text) - individual domain
   - `target_inbox_url` (text) - constructed inbox URL
   - `actor_username` (text) - from sender profile
   - `actor_domain` (text) - local instance domain
   - `status` (text) - 'pending'
   - `priority` (integer) - 5
   - `attempts` (integer) - 0
   - `next_attempt_at` (timestamp) - NOW()

2. **Create one record per target domain** using a loop instead of trying to insert an array

3. **Properly populate actor fields** using the sender profile data

## Code Changes

```sql
-- OLD (broken):
INSERT INTO federation_delivery_queue (
    activity_id,
    activity_type,
    activity_data,
    target_domains,  -- WRONG: array column doesn't exist
    actor_id,        -- WRONG: should be actor_username/actor_domain
    -- ... other wrong columns
) VALUES (
    v_activity_id,
    CASE WHEN v_is_undo THEN 'Undo' ELSE 'EmojiReact' END,
    v_activity,
    v_target_domains,  -- WRONG: trying to insert array
    v_interaction_record.user_id,  -- WRONG: should be username
    -- ...
);

-- NEW (fixed):
FOREACH v_target_domain IN ARRAY v_target_domains LOOP
    v_domain_inbox := 'https://' || v_target_domain || '/inbox';
    
    INSERT INTO federation_delivery_queue (
        activity_id,
        activity_data,
        target_domain,      -- CORRECT: individual domain
        target_inbox_url,   -- CORRECT: constructed inbox URL
        actor_username,     -- CORRECT: from profile
        actor_domain,       -- CORRECT: instance domain
        status,
        priority,
        attempts,
        next_attempt_at
    ) VALUES (
        v_activity_id,
        v_activity,
        v_target_domain,           -- CORRECT: individual value
        v_domain_inbox,            -- CORRECT: inbox URL
        v_sender_profile.username, -- CORRECT: username from profile
        v_instance_domain,         -- CORRECT: local domain
        'pending',
        5,
        0,
        NOW()
    );
END LOOP;
```

## Verification

The delivery system in `supabase/functions/outbox/delivery.ts` was already correct and properly handles:
1. Reading from `federation_delivery_queue` table
2. Using `activity_data` when present (for emoji reactions)
3. Falling back to `ap_activities` table when needed (for posts)
4. HTTP signature generation using `actor_username` and `actor_domain`
5. Proper error handling and retry logic

## Expected Result

After applying this fix by running the updated `emoji_reaction_federation_complete.sql` migration:

1. ✅ Emoji reactions will be properly queued for federation with correct field values
2. ✅ The delivery system will find pending reactions in the queue
3. ✅ Each reaction will be delivered to remote instances with proper ActivityPub format
4. ✅ Remote instances will receive properly signed EmojiReact/Undo activities
5. ✅ Reactions will appear on remote timelines and be attributed correctly

## Testing

To test the fix:
1. Apply the SQL migration
2. Add an emoji reaction to a local post
3. Check the `federation_delivery_queue` table for pending deliveries
4. Monitor edge function logs for delivery attempts
5. Verify reactions appear on remote instances

The incoming federation was already working correctly, so this fix should complete the full bidirectional emoji reaction federation.
