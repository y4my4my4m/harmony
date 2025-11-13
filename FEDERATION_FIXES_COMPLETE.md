# Federation Fixes - Complete Implementation

> **Date**: 2025-11-13  
> **Session**: Federation debugging and optimization  
> **Status**: Ready for deployment and testing

---

## Issues Fixed

### 1. HTTP/HTTPS Protocol Inconsistency ✅

**Problem**: Outbox and actor endpoints were returning `http://` URLs instead of `https://` when accessed behind nginx reverse proxy.

**Cause**: `req.protocol` returns "http" when behind nginx proxy, even though external connections use HTTPS.

**Files Modified**:
- `federation-backend/src/activitypub/OutboxHandler.ts`
- `federation-backend/src/activitypub/ActorService.ts`

**Solution**: 
- Changed from `req.protocol://${req.get('host')}` to `https://${config.INSTANCE_DOMAIN}`
- All URLs now consistently use HTTPS
- Fixes profile image display issues on Mastodon

**Example**:
```typescript
// Before:
const baseUrl = `${req.protocol}://${req.get('host')}`; // http://har.mony.lol

// After:
const baseUrl = `https://${config.INSTANCE_DOMAIN}`; // https://har.mony.lol
```

---

### 2. Shared Inbox Delivery Optimization ✅

**Problem**: Only sending to individual user inboxes, not using shared inboxes. This is inefficient and may cause issues with some platforms (like Misskey).

**Cause**: Delivery queue only checked `inbox_url`, ignored `shared_inbox_url`.

**File Modified**:
- `federation-backend/src/activitypub/DeliveryQueue.ts`

**Solution**:
- Modified `broadcastToFollowers()` to group followers by their preferred inbox
- Prefers `shared_inbox_url` when available, falls back to `inbox_url`
- Sends one copy per server instead of one per user
- Significantly reduces network requests for popular posts

**Benefits**:
- More efficient (1 request per server vs 1 per follower)
- Standard ActivityPub best practice
- May fix Misskey delivery issues (Misskey prefers shared inbox)

**Example**:
```
Before: 
  - Post to 5 followers on mastodon.social = 5 requests
  
After:
  - Post to 5 followers on mastodon.social = 1 request to shared inbox
```

**Logs now show**:
```
Enqueued broadcast to 2 inboxes (1 shared, 1 individual) for 5 remote followers
```

---

### 3. Direct Message Routing ✅

**Problem**: Private mentions (direct messages) were being stored in `posts` table with `visibility='direct'` instead of the `messages` table where DMs belong.

**Cause**: No routing logic to differentiate between posts and messages.

**File Modified**:
- `federation-backend/src/activitypub/ActivityProcessor.ts`

**Solution**:
- Added `handleDirectMessage()` method
- Routes incoming Notes with `visibility='direct'` to `messages` table
- Finds or creates DM conversation between sender and recipient
- Stores AP metadata (ap_id, domain, etc.) in message metadata field
- Everything else still goes to `posts` table

**Flow**:
```
Incoming Note
  ↓
Determine visibility
  ↓
If visibility === 'direct':
  → Create/find DM conversation
  → Store in messages table
  → Appears in user's DMs
  
Else (public/unlisted/followers):
  → Store in posts table
  → Appears in timeline
```

**Database structure**:
```sql
INSERT INTO messages (
  user_id,           -- sender
  conversation_id,   -- DM conversation
  content,           -- MessagePart[] array
  metadata,          -- {ap_id, from_domain, original_url, published}
  created_at
)
```

---

### 4. Remote User Profile Refresh Utility ✅

**Problem**: Some remote users missing `inbox_url`, `shared_inbox_url`, or `outbox_url` in database.

**Cause**: Initial follow or incomplete profile fetches.

**File Created**:
- `federation-backend/refresh-remote-users.js`

**Solution**:
- Utility script to re-fetch actor data from remote servers
- Updates all inbox/outbox URLs and public keys
- Can be run manually or scheduled

**Usage**:
```bash
cd federation-backend
node refresh-remote-users.js
```

**What it does**:
1. Fetches all remote users from database
2. For each user, fetches their Actor object from their federated_id URL
3. Extracts inbox_url, shared_inbox_url, outbox_url, public_key
4. Updates profile in database
5. Reports success/failure for each user

**Output**:
```
🔄 Refreshing all remote user profiles...
Found 3 remote users

Fetching actor data for: https://mastodon.social/users/tester004
✅ Updated profile for https://mastodon.social/users/tester004
  Inbox: https://mastodon.social/users/tester004/inbox
  Shared Inbox: https://mastodon.social/inbox
  Outbox: https://mastodon.social/users/tester004/outbox

📊 Results:
  ✅ Updated: 3
  ❌ Failed: 0
```

---

## Deployment Steps

### 1. Deploy Code Changes

```bash
cd ~/harmony/federation-backend

# Pull latest changes
git pull

# Install dependencies (if needed)
npm install

# Restart federation backend
pm2 restart federation-backend
# or
npm run dev  # for development
```

### 2. Refresh Remote User Profiles

**Important**: Run this to ensure all remote users have proper inbox URLs.

```bash
cd ~/harmony/federation-backend
node refresh-remote-users.js
```

This will:
- Update all Mastodon follower inbox URLs
- Update all Misskey follower inbox URLs
- Add missing shared inbox URLs
- Fix any incomplete profiles

### 3. Verify HTTPS URLs

Test that actor endpoints now return HTTPS URLs:

```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m
```

Check that all URLs in the response use `https://` (not `http://`):
- `id`: https://har.mony.lol/users/y4my4m
- `inbox`: https://har.mony.lol/users/y4my4m/inbox
- `outbox`: https://har.mony.lol/users/y4my4m/outbox
- `endpoints.sharedInbox`: https://har.mony.lol/inbox

### 4. Test Outbox

```bash
curl -H "Accept: application/activity+json" "https://har.mony.lol/users/y4my4m/outbox?page=1"
```

Verify all activity and object URLs use HTTPS.

---

## Testing Checklist

### Federation Delivery (Outgoing)

- [ ] **Test 1: Post without mentions to Mastodon follower**
  - Create a public post with no mentions
  - Check Mastodon follower's timeline
  - Expected: Post appears immediately
  
- [ ] **Test 2: Post without mentions to Misskey follower**
  - Create a public post with no mentions
  - Check Misskey follower's timeline
  - Expected: Post appears immediately
  
- [ ] **Test 3: Post with mentions**
  - Create a post mentioning a Mastodon user
  - Expected: Delivered to both followers AND mentioned user
  
- [ ] **Test 4: Check delivery logs**
  - Create a post
  - Check federation backend logs
  - Expected: See "Enqueued broadcast to X inboxes (Y shared, Z individual)"

### Federation Reception (Incoming)

- [ ] **Test 5: Receive public post from followed Mastodon user**
  - Have followed Mastodon user create a post
  - Check your Harmony timeline
  - Expected: Post appears in federated timeline
  
- [ ] **Test 6: Receive public post from followed Misskey user**
  - Have followed Misskey user create a post
  - Check your Harmony timeline
  - Expected: Post appears in federated timeline
  
- [ ] **Test 7: Receive direct message**
  - Have Mastodon user send you a DM
  - Check your Harmony DMs section (not timeline)
  - Expected: Message appears in DMs, NOT in posts timeline
  
- [ ] **Test 8: Receive public mention**
  - Have Mastodon user mention you in a public post
  - Expected: Appears in timeline AND notifications

### Profile Images

- [ ] **Test 9: Profile images on Mastodon**
  - View your Harmony profile from Mastodon
  - Expected: Avatar and banner display correctly
  
- [ ] **Test 10: Profile images on Misskey**
  - View your Harmony profile from Misskey
  - Expected: Avatar and banner display correctly

### Shared Inbox Efficiency

- [ ] **Test 11: Multiple followers on same server**
  - Have 2+ Mastodon followers on mastodon.social
  - Create a post
  - Check federation logs
  - Expected: Only 1 delivery to mastodon.social/inbox (not 2+ individual inboxes)

---

## Troubleshooting

### Posts not reaching Misskey

1. Check if Misskey follower has shared_inbox_url:
   ```sql
   SELECT username, domain, inbox_url, shared_inbox_url 
   FROM profiles 
   WHERE domain LIKE '%misskey%';
   ```

2. If shared_inbox_url is NULL, run refresh script:
   ```bash
   node refresh-remote-users.js
   ```

3. Check delivery logs for errors:
   ```bash
   pm2 logs federation-backend | grep misskey
   ```

### Posts not appearing in local timeline

This is a separate issue (timeline triggers). The posts ARE being federated, they just don't appear in your home timeline. This will be fixed separately.

### Direct messages still in posts table

- This fix only applies to NEW incoming messages
- Old direct messages in posts table will remain there
- To clean up: Could write a migration to move them (optional)

### Profile images not showing

1. Verify URLs are HTTPS:
   ```bash
   curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m | jq .icon.url
   ```

2. Check avatar/banner URLs in database:
   ```sql
   SELECT username, avatar, banner FROM profiles WHERE is_local = true;
   ```

3. Ensure avatar/banner are accessible:
   ```bash
   curl -I <avatar_url>
   ```

---

## Database Queries for Verification

### Check remote followers with inbox URLs

```sql
SELECT 
  p.username || '@' || p.domain as user,
  p.inbox_url,
  p.shared_inbox_url,
  CASE 
    WHEN p.shared_inbox_url IS NOT NULL THEN 'Has shared inbox'
    WHEN p.inbox_url IS NOT NULL THEN 'Individual inbox only'
    ELSE 'MISSING INBOX'
  END as status
FROM follows f
JOIN profiles p ON f.follower_id = p.id
WHERE f.following_id = '<YOUR_USER_ID>'
  AND f.status = 'accepted'
  AND p.is_local = false
ORDER BY p.domain;
```

### Check recent direct messages

```sql
SELECT 
  m.id,
  m.created_at,
  p.username || '@' || p.domain as sender,
  m.content::text as content_preview,
  m.metadata->>'ap_id' as ap_id
FROM messages m
JOIN profiles p ON m.user_id = p.id
WHERE m.conversation_id IS NOT NULL
ORDER BY m.created_at DESC
LIMIT 10;
```

### Check delivery queue status

```sql
SELECT 
  status,
  target_domain,
  COUNT(*) as count,
  MAX(created_at) as latest
FROM federation_delivery_queue
GROUP BY status, target_domain
ORDER BY status, target_domain;
```

---

## Performance Improvements

### Before Shared Inbox Fix

- 5 followers on mastodon.social
- 3 followers on misskey.io
- 1 follower on pixelfed.social
- **Total deliveries per post: 9 requests**

### After Shared Inbox Fix

- mastodon.social: 1 request to shared inbox (covers 5 followers)
- misskey.io: 1 request to shared inbox (covers 3 followers)
- pixelfed.social: 1 request to individual inbox (1 follower)
- **Total deliveries per post: 3 requests**

**Reduction: 66% fewer HTTP requests!**

This also:
- Reduces server load
- Faster delivery
- Less likely to hit rate limits
- More respectful to remote servers

---

## Next Steps (Not in this session)

These issues still need to be addressed separately:

1. **Timeline trigger bug**: Federated posts don't appear in home timeline
2. **Signature verification**: Incoming signatures fail verification (we accept anyway)
3. **Follow request UI**: No UI to approve/reject follows (currently auto-accepts)
4. **Outgoing reactions**: Not federating when you react to remote posts
5. **Announce/Reblog**: Sending not implemented
6. **Delete/Update activities**: Post edits and deletions don't federate
7. **Undo activities**: Un-react, unfollow, etc.

---

## Files Modified Summary

### Modified Files
1. `federation-backend/src/activitypub/OutboxHandler.ts` - HTTPS fix
2. `federation-backend/src/activitypub/ActorService.ts` - HTTPS fix
3. `federation-backend/src/activitypub/DeliveryQueue.ts` - Shared inbox optimization
4. `federation-backend/src/activitypub/ActivityProcessor.ts` - Direct message routing

### New Files
1. `federation-backend/refresh-remote-users.js` - Profile refresh utility
2. `federation-backend/diagnose-federation.js` - Diagnostic utility

### No Database Changes
- All fixes work with existing schema
- No migrations required
- Backward compatible

---

## Success Criteria

All fixes are complete when:

✅ All URLs use HTTPS (not HTTP)  
✅ Posts reach ALL followers (Mastodon AND Misskey)  
✅ Shared inbox used when available  
✅ Direct messages appear in DMs (not timeline)  
✅ Profile images display on all platforms  
✅ Federation logs show efficient delivery  

---

**End of Document**

