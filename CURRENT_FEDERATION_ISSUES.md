# Current Federation Issues

**Date**: 2025-11-13  
**After deploying shared inbox fixes**

---

## Issue 1: Federated Posts Not in Home Timeline ⚠️

**Status**: Known issue, has workaround

**Problem**: 
- Posts from followed users appear in `federated_timeline`
- But NOT in `home_timeline`
- Database trigger `create_comprehensive_timeline_entries` not working for federated posts

**Temporary Fix**:
```bash
# On your VPS, run this SQL to create missing timeline entries
cd ~/harmony
psql <your-connection-string> -f db_schema/fix_timeline_for_federated_posts.sql
```

This will:
1. Find all federated posts from users you follow
2. Create `timeline_entries` with `timeline_type='home'`
3. Make them appear in your home timeline

**Permanent Fix Needed**:
- Fix the `create_comprehensive_timeline_entries` trigger
- Or create a new trigger that handles federated posts
- File to check: `db_schema/essential_functions.sql`

---

## Issue 2: Not Receiving Misskey Posts 🔍

**Status**: Need to diagnose

**Diagnostic**:
```bash
cd ~/harmony/federation-backend
npm run check-misskey
```

This will check:
- ✅ Follow relationship exists and is accepted
- ✅ Misskey user has correct inbox URLs
- ✅ Recent activities received from Misskey
- ✅ Posts created from those activities
- ✅ Timeline entries created for those posts

**Possible causes**:
1. **Not following them**: You need to follow the Misskey user for their posts to arrive
2. **Follow not accepted on their side**: Misskey didn't accept your follow request
3. **Misskey not sending to shared inbox**: They might be using individual inbox (check logs)
4. **Timeline trigger bug**: Posts arriving but not appearing (see Issue 1)

**Check federation logs**:
```bash
pm2 logs federation-backend | grep -E "misskey|Create.*activity"
```

Look for:
- `📮 POST to /inbox` from Misskey IP
- `📬 Processing incoming Note`
- `Created post from https://misskey.io/...`

---

## Issue 3: Signature Verification Failing 🔐

**Status**: Known issue, non-blocking

**What you see**:
```
[warn]: ⚠️  Signature verification failed for https://misskey.io/users/...
```

**Current behavior**:
- ✅ System accepts activities anyway (security definer function)
- ✅ Activities are processed correctly
- ⚠️ Just logs a warning

**Why it fails**:
Multiple possible reasons:

1. **Date drift**: Server clock not synchronized
   ```bash
   # Check on your server
   timedatectl status
   # If wrong, sync:
   sudo timedatectl set-ntp true
   ```

2. **Header reconstruction**: Signature verification needs exact headers
   - Current code in `SignatureService.ts` might not reconstruct correctly
   - Misskey uses different signature format than Mastodon

3. **Digest calculation**: Different servers use different digest algorithms
   - Some use SHA-256
   - Some use SHA-512
   - Your code might calculate wrong digest

**Impact**: 
- **Low** - System works fine without verification
- **Security concern** - Could accept spoofed activities
- Should be fixed eventually but not urgent

**To fix** (future):
File: `federation-backend/src/activitypub/SignatureService.ts`
- Method: `verifySignature()`
- Need to debug exact signature string being verified
- Compare with what remote server signed
- Check digest calculation

**Debug logging**:
Add to `SignatureService.ts`:
```typescript
console.log('Signature string:', signatureString);
console.log('Public key:', publicKey);
console.log('Signature value:', signatureValue);
```

---

## Quick Action Plan

### Immediate (Do now):

1. **Fix home timeline**:
   ```bash
   psql <connection> -f ~/harmony/db_schema/fix_timeline_for_federated_posts.sql
   ```

2. **Diagnose Misskey**:
   ```bash
   npm run check-misskey
   ```

3. **Check if you're actually following them**:
   - Look in Harmony UI
   - Check follows table
   - Verify status is 'accepted'

### Short-term (This week):

4. **Fix timeline trigger permanently**
   - Modify `create_comprehensive_timeline_entries` 
   - Or create new trigger for federated posts

5. **Investigate signature verification**
   - Add debug logging
   - Compare with working implementations
   - Test with both Mastodon and Misskey

### Long-term (When time permits):

6. **Proper signature verification**
   - Implement full HTTP Signatures spec
   - Support multiple digest algorithms
   - Handle clock drift gracefully

---

## Testing Federation

After fixes, test:

```bash
# 1. Create a post
# 2. Check logs
pm2 logs federation-backend | grep -A 5 "Processing post for federation"

# Should see:
# - "Enqueued broadcast to X inboxes (Y shared, Z individual)"
# - "✅ Delivered to https://misskey.io/inbox (202)"
# - "✅ Delivered to https://mastodon.social/inbox (202)"

# 3. Ask followers to check their timelines
# 4. Have them post something
# 5. Check your home timeline (should appear after SQL fix)
```

---

## Success Criteria

Federation is working correctly when:

- [x] Posts reach Mastodon followers ✅
- [ ] Posts reach Misskey followers (need to verify)
- [ ] Receive Mastodon posts in home timeline (SQL fix needed)
- [ ] Receive Misskey posts in home timeline (need diagnosis)
- [x] Shared inbox being used ✅
- [x] HTTP/HTTPS URLs consistent ✅
- [ ] Signature verification working (future)

---

## Files to Review

- `federation-backend/src/activitypub/SignatureService.ts` - Signature verification
- `db_schema/essential_functions.sql` - Timeline triggers
- `federation-backend/src/listeners/DatabaseListener.ts` - Post processing
- `federation-backend/src/activitypub/ActivityProcessor.ts` - Create activity handling


