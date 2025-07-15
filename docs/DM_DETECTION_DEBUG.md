# Federated DM Detection Debug Guide

## The Problem
Private messages/DMs from federated instances (like Mastodon) are being incorrectly processed as **public posts** instead of **direct messages**, causing them to appear in the public feed.

## Root Cause Analysis
The issue is in the ActivityPub inbox handler (`supabase/functions/inbox/index.ts`). When DM detection fails, messages fall through to the public post processing path.

## Enhanced Debugging Added
I've added comprehensive logging to the inbox handler to identify exactly why DM detection is failing:

### Key Log Messages to Watch For:

#### ✅ **Success Path (DM Correctly Detected):**
```
🔍 DM Detection Analysis: { id: "...", visibility: "direct", ... }
✅ DM detected via visibility=direct
✅ PROCESSING AS DIRECT MESSAGE
🔒 Processing direct message: ...
```

#### ❌ **Failure Path (DM Processed as Public):**
```
🔍 DM Detection Analysis: { id: "...", visibility: "public", ... }
❌ Found public indicator: https://www.w3.org/ns/activitystreams#Public
❌ DM rejected - has public audience: [...]
❌ Not detected as DM - will process as public post
📢 PROCESSING AS PUBLIC POST
```

#### ⚠️ **Warning Path (Missed DM):**
```
⚠️ WARNING: This looks like it could be a DM but was not detected as one!
⚠️ Post details: { to: [...], cc: [...], visibility: "...", ... }
```

## Testing Steps

### 1. Send a Test DM
From a Mastodon account, send a **proper direct message**:
1. Open Mastodon
2. Click the **envelope/message icon** (not compose)
3. Start new conversation with `@yourusername@yourdomain.com`
4. Send message: "Test DM"
5. **Make sure it's set to Direct visibility** (lock icon)

### 2. Check Logs
Watch the Supabase Edge Function logs for the patterns above.

### 3. Common Issues & Solutions

#### Issue: `visibility: "public"` in logs
**Problem**: Mastodon is sending DM with public visibility
**Solution**: Check Mastodon DM settings, ensure it's truly a direct message

#### Issue: `hasPublicAudience: true`
**Problem**: Message includes public addressing
**Check**: Look for `to` or `cc` containing public indicators

#### Issue: No local recipients found
**Problem**: Addressing doesn't include your domain properly
**Solution**: Verify domain configuration

## Expected Behavior

### ✅ **Direct Messages Should:**
- NOT appear in public/federated/local feeds
- CREATE a new DM conversation
- Show "direct message" notification (not "mention")
- Appear in DM sidebar with federated indicator

### ❌ **Direct Messages Should NOT:**
- Appear in timeline feeds
- Be stored as `posts` with `visibility='public'`
- Generate "mention" notifications
- Be visible to other users

## Database Check

If DMs are still appearing as public posts, check:

```sql
-- Check for posts that might be DMs
SELECT id, content, visibility, author_id, created_at
FROM posts 
WHERE visibility = 'public' 
AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;

-- Check DM conversations
SELECT * FROM conversations 
WHERE created_at > NOW() - INTERVAL '1 hour';

-- Check messages (actual DMs)
SELECT * FROM messages 
WHERE conversation_id IS NOT NULL 
AND created_at > NOW() - INTERVAL '1 hour';
```

## Next Steps

1. **Send test DM** and share the exact log output
2. **Check the ActivityPub object** structure in logs
3. **Identify why detection is failing** based on log patterns
4. **Adjust detection logic** if needed for your specific federated instances

The enhanced logging will show us exactly what's happening and why DM detection is failing for your specific case.
