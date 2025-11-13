# Federation Endpoint Status Check

## ✅ What's Already Set Up

### 1. Actor Advertising (Backend) ✅
**File**: `federation-backend/src/activitypub/converters/toActivityPub.ts`

Your actor objects correctly advertise shared inbox/outbox:
```typescript
endpoints: {
  sharedInbox: `https://${domain}/inbox`,      // ✅ Correct
  sharedOutbox: `https://${domain}/outbox`,    // ✅ Correct
}
```

**Test it**:
```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m | jq .endpoints
```

Should show:
```json
{
  "sharedInbox": "https://har.mony.lol/inbox",
  "sharedOutbox": "https://har.mony.lol/outbox"
}
```

### 2. Shared Inbox Handler (Backend) ✅
**File**: `federation-backend/src/activitypub/InboxHandler.ts`

Routes implemented:
- ✅ `POST /inbox` - Shared inbox (receives activities for all users)
- ✅ `POST /users/:username/inbox` - Individual user inbox

### 3. Outbox Handler (Backend) ⚠️ PARTIAL
**File**: `federation-backend/src/activitypub/OutboxHandler.ts`

Routes implemented:
- ✅ `GET /users/:username/outbox` - Individual user outbox
- ❌ `GET /outbox` - **MISSING** shared outbox

**Issue**: OutboxHandler doesn't have a `/outbox` route, only `/users/:username/outbox`

### 4. Nginx Configuration ✅
**File**: `nginx-harmony-updated.conf`

Nginx routes are ready:
- ✅ Line 114-132: `POST /inbox` → `http://localhost:3001/inbox`
- ✅ Line 135-148: `GET /outbox` → `http://localhost:3001/outbox`
- ✅ Line 71-90: `GET /users/:username/outbox` → works

---

## ⚠️ Issues Found

### Issue 1: Missing Shared Outbox Route
**Problem**: Nginx expects `GET /outbox` but OutboxHandler doesn't have this route.

**Impact**: 
- Remote servers might try to fetch `https://har.mony.lol/outbox`
- They'll get a 404 instead of combined outbox
- **Not critical** - individual user outboxes work fine

**Should we fix it?**
Probably not urgent because:
1. Remote servers mostly use individual user outboxes (`/users/:username/outbox`)
2. Shared outbox is rarely used in practice
3. It would just aggregate all local users' posts (heavy query)

### Issue 2: Nginx Config Not Deployed
**Problem**: You have `nginx-harmony-updated.conf` but it might not be active.

**Check on your server**:
```bash
# Check which config is active
ls -la /etc/nginx/sites-enabled/

# Compare with the updated config
diff /etc/nginx/sites-available/harmony ~/harmony/nginx-harmony-updated.conf
```

---

## Action Required

### 1. Deploy Updated Nginx Config (if not already done)

```bash
# Backup current config
sudo cp /etc/nginx/sites-available/harmony /etc/nginx/sites-available/harmony.backup

# Copy updated config
sudo cp ~/harmony/nginx-harmony-updated.conf /etc/nginx/sites-available/harmony

# Test config
sudo nginx -t

# If test passes, reload
sudo systemctl reload nginx

# Verify
curl -I https://har.mony.lol/inbox
# Should return 405 Method Not Allowed (it's POST only, not GET)
```

### 2. Verify Actor Endpoints

```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m | jq .endpoints
```

Should show:
```json
{
  "sharedInbox": "https://har.mony.lol/inbox",
  "sharedOutbox": "https://har.mony.lol/outbox"
}
```

### 3. Test Shared Inbox (optional)

After deployment, you can test if the shared inbox is accessible:

```bash
# This will fail (no valid activity) but should show it's routed correctly
curl -X POST https://har.mony.lol/inbox \
  -H "Content-Type: application/activity+json" \
  -d '{"type":"test"}' -v

# Should see logs in federation backend showing the POST was received
pm2 logs federation-backend | grep "POST to /inbox"
```

---

## Summary

| Component | Status | Notes |
|-----------|--------|-------|
| Actor advertising sharedInbox | ✅ Working | Correctly advertises `/inbox` |
| Actor advertising sharedOutbox | ✅ Working | Correctly advertises `/outbox` |
| Shared inbox route (backend) | ✅ Working | `POST /inbox` implemented |
| User inbox route (backend) | ✅ Working | `POST /users/:username/inbox` |
| User outbox route (backend) | ✅ Working | `GET /users/:username/outbox` |
| Shared outbox route (backend) | ❌ Missing | `GET /outbox` not implemented |
| Nginx proxy for /inbox | ✅ Ready | In updated config |
| Nginx proxy for /outbox | ✅ Ready | In updated config |
| Nginx config deployed | ❓ Unknown | Need to check server |

---

## What Matters Most

For federation to work, you **need**:
1. ✅ Shared inbox receiving (you have this)
2. ✅ Individual user outboxes (you have this)
3. ✅ Nginx routing (you have the config, just needs deployment)

You **don't need** (nice to have):
- ❌ Shared outbox route (rarely used)

---

## Next Steps

1. Check if nginx config is deployed
2. If not, deploy it
3. Verify actor endpoints are accessible
4. **Test federation by creating a post!**

