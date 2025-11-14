# Final Deployment Steps

All code is fixed. Just need to apply to database and restart services.

---

## Step 1: Apply Database Updates

```bash
cd ~/harmony

# Update all functions (includes timeline fixes)
psql <your-connection> -f db_schema/essential_functions.sql

# Create triggers (reply counter, timeline backfill, etc.)
psql <your-connection> -f db_schema/create_essential_triggers.sql
```

**What this does**:
- ✅ Updates `create_comprehensive_timeline_entries` to handle federated posts
- ✅ Creates `update_post_counters` trigger → Increments `replies_count`
- ✅ Creates `backfill_timeline_on_follow` trigger → Adds posts when following
- ✅ Creates `remove_timeline_on_unfollow` trigger → Removes posts when unfollowing
- ✅ Updates old posts to have `ap_id` set

---

## Step 2: Restart Federation Backend

```bash
cd ~/harmony/federation-backend
pm2 restart federation-backend
```

**What this includes**:
- ✅ Shared inbox delivery (efficient)
- ✅ HTTPS URLs (consistent)
- ✅ Signature verification (working)
- ✅ Reply threading (proper `inReplyTo` URLs)
- ✅ Direct messages (uses existing conversations)

---

## Step 3: Deploy Frontend

```bash
cd ~/harmony
npm run build
# Deploy dist/ to production
```

**What this includes**:
- ✅ Follow state loads on social routes
- ✅ No more duplicate posts (removed optimistic updates)

---

## What Will Be Fixed

### ✅ Timeline Issues:
- [x] Federated posts in home timeline
- [x] Follow backfills recent posts
- [x] Unfollow removes posts

### ✅ Reply Issues:
- [x] Reply count increments
- [x] Replies show as threaded on Mastodon
- [x] Reply context appears in Harmony UI
- [x] No more duplicate posts

### ✅ DM Issues:
- [x] Direct messages in DM section
- [x] Uses existing conversations

### ✅ Federation Issues:
- [x] Shared inbox delivery
- [x] Signature verification
- [x] HTTPS URLs
- [x] ap_id set for local posts

---

## Expected Behavior After Deploy

1. **Create a reply to Mastodon post**:
   - ✅ Shows once (not twice) in timeline
   - ✅ Shows reply indicator/context
   - ✅ Parent post reply count increments
   - ✅ Mastodon sees it threaded

2. **Follow someone new**:
   - ✅ Their last 20 posts appear in home timeline immediately
   - ✅ Follow button shows "Following" on reload

3. **Unfollow someone**:
   - ✅ Their posts disappear from home timeline
   - ✅ Still visible in public timeline

4. **Receive DM**:
   - ✅ Goes to DM section (not timeline)
   - ✅ Uses existing conversation if one exists

---

## Verify It Works

### Test 1: Reply Threading
```
1. Reply to a Mastodon post
2. Check Harmony: Should show reply indicator
3. Check Harmony: Parent post replies_count should increment
4. Check Mastodon: Should appear as threaded reply
5. Reload page: Should only appear once
```

### Test 2: Timeline
```
1. Have followed user post on Mastodon
2. Check Harmony home timeline (not just public)
3. Should appear there
```

### Test 3: Follow/Unfollow
```
1. Follow new Mastodon user
2. Their recent posts should appear
3. Unfollow them
4. Posts should disappear from home (stay in public)
```

### Test 4: Check Logs
```bash
pm2 logs federation-backend --lines 50
```

Should see:
- `✅ Signature verified` (not failed)
- `Enqueued broadcast to X inboxes (Y shared, Z individual)`
- `✅ Delivered to https://mastodon.social/inbox (202)`

---

**All fixes use proper patterns: Database triggers, existing functions, no workarounds!**


