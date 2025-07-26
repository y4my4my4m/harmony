# Debug Emoji Reaction Federation

## Current Status Analysis

Based on the delivery queue data:

### ✅ What's Working
- **Emoji reactions are being queued correctly** with `activity_type: "EmojiReact"`
- **Misskey.io delivery succeeded** - shows `status: "delivered"`
- **Activity data is being stored** - emoji content `:alien:` is captured

### ❌ Issues Found

1. **Missing `actor_domain`**: Emoji reaction entries have `null` instead of `"har.mony.lol"`
2. **Mastodon.social delivery pending**: One entry shows failed delivery attempt

### ✅ Fix Applied
Updated the SQL migration to add fallback for `actor_domain`:

```sql
-- Get instance domain
SELECT config_value->>'domain' INTO v_instance_domain
FROM instance_config 
WHERE config_key = 'federation_settings';

-- Fallback if not configured
IF v_instance_domain IS NULL OR v_instance_domain = '' THEN
    v_instance_domain := 'har.mony.lol';  -- Use your actual domain
END IF;
```

## Next Steps

### 1. Apply the Fixed Migration
Run the updated `emoji_reaction_federation_complete.sql` to fix the `actor_domain` issue.

### 2. Check Edge Function Logs
Look for delivery attempts in your Supabase edge function logs to see why Mastodon.social delivery failed.

### 3. Manual Delivery Test
You can manually trigger delivery processing by calling your outbox edge function or checking if it's running on schedule.

### 4. Check HTTP Signature Issues
The `null` `actor_domain` would cause HTTP signature generation to fail, which explains delivery failures.

## Verification Queries

```sql
-- Check recent delivery queue entries
SELECT 
    id, created_at, target_domain, status, attempts, 
    actor_username, actor_domain, activity_type, emoji_content
FROM federation_delivery_queue 
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;

-- Check for pending deliveries
SELECT COUNT(*) as pending_count 
FROM federation_delivery_queue 
WHERE status = 'pending';

-- Check instance config
SELECT config_key, config_value 
FROM instance_config 
WHERE config_key = 'federation_settings';
```

## Expected Result

After applying the fix:
1. **New emoji reactions will have proper `actor_domain`**
2. **HTTP signatures will generate correctly**
3. **Deliveries to all instances should succeed**
4. **Emoji reactions will appear on remote timelines**

The fact that Misskey.io delivery succeeded suggests the overall system is working, just needs the `actor_domain` fix for reliable delivery.
