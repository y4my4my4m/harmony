# Quick Federation Testing Guide

After deploying the fixes, run these quick tests to verify everything works:

## 1. Pre-Deployment: Refresh Remote Users (REQUIRED)

```bash
cd ~/harmony/federation-backend
npm run refresh-users
```

This ensures all remote users have proper inbox URLs.

## 2. Verify HTTPS URLs

```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m | grep -E "(\"id\"|inbox|outbox)"
```

All URLs should be `https://` not `http://`.

## 3. Quick Test Sequence

### Test A: Post to Followers
1. Create a public post: "Testing federation fixes"
2. Check federation backend logs for:
   ```
   Enqueued broadcast to X inboxes (Y shared, Z individual)
   ```
3. Ask Mastodon follower: "Did you see the post?"
4. Ask Misskey follower: "Did you see the post?"

**Expected**: Both should see it immediately.

### Test B: Receive from Followed User
1. Ask a Mastodon user you follow to post something
2. Check your Harmony federated timeline
3. Should appear within seconds

### Test C: Direct Message
1. Ask Mastodon user to send you a DM
2. Check Harmony DMs (not timeline)
3. Should appear in DM section, NOT in posts

## 4. Check Logs

```bash
pm2 logs federation-backend --lines 50
```

Look for:
- ✅ "Delivered to https://..." (status 202)
- ✅ "Enqueued broadcast to X inboxes"
- ✅ "shared inbox" mentions
- ❌ No errors or 401/403 responses

## 5. If Something's Wrong

### Misskey not receiving posts?
```bash
# Check if Misskey follower has inbox URLs
cd ~/harmony/federation-backend
npm run diagnose

# Look for Misskey users with "MISSING" inbox URLs
# If found, run: npm run refresh-users
```

### Profile images not showing?
```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m | jq .icon
```
Should show your avatar URL with HTTPS.

### DMs still in timeline?
- Only NEW DMs after the fix will go to messages table
- Old ones will stay in posts (can be cleaned up later)

## Success Indicators

- ✅ Mastodon followers see posts
- ✅ Misskey followers see posts  
- ✅ Logs show "shared inbox" deliveries
- ✅ Direct messages in DM section
- ✅ All URLs use HTTPS
- ✅ Profile images display

## Key Log Messages to Look For

**Good**:
```
✅ Delivered to https://mastodon.social/inbox (202)
Enqueued broadcast to 2 inboxes (1 shared, 1 individual) for 5 remote followers
Created DM in conversation <uuid> from <ap_id>
```

**Bad**:
```
❌ Failed to deliver to ... : 401
⚠️ Follower from misskey.io has no inbox URL configured
```

If you see bad messages, run `node refresh-remote-users.js` again.

