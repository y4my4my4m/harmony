# Quick Fix Summary - Profile Federation Issues

## Problems Found & Fixed

### 1. ❌ Profile Pictures Not Showing on Mastodon
**Cause**: Used wrong database column names (`avatar` vs `avatar_url`)  
**Fix**: Updated `profileToActor()` to use correct columns  
**Result**: ✅ Mastodon now sees your profile pictures

### 2. ❌ Profile Updates Not Federating
**Cause**: No realtime listener for profile UPDATE events  
**Fix**: Added UPDATE listener + `handleProfileUpdate()` handler  
**Result**: ✅ When you change display name/bio/avatar/banner, followers get notified

### 3. ❌ **CRITICAL**: Sending Relative Paths Instead of URLs
**Cause**: Database stores relative paths for local users (`user-id/avatar.webp`)  
**Fix**: Created `urlUtils.ts` to convert to full URLs before federation  
**Result**: ✅ Other instances can now actually access your images

---

## What Was Changed

**New File:**
- `federation-backend/src/utils/urlUtils.ts` - URL normalization utilities

**Modified Files:**
- `toActivityPub.ts` - Fixed column names + URL conversion
- `FederationHandlers.ts` - Added profile update activity creator
- `DatabaseListener.ts` - Added profile UPDATE listener
- `ActivityProcessor.ts` - Fixed incoming profile updates

---

## How to Test

### 1. Restart Federation Backend
```bash
cd ~/harmony/federation-backend
npm run dev
```

### 2. Check Actor Endpoint
```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m | jq
```

Should now show:
```json
{
  "icon": {
    "type": "Image",
    "url": "https://yourproject.supabase.co/storage/v1/object/public/avatars/..."
  },
  "image": {
    "type": "Image", 
    "url": "https://yourproject.supabase.co/storage/v1/object/public/banners/..."
  }
}
```

### 3. Update Your Profile
- Change display name
- Change bio
- Upload new avatar
- Upload new banner

### 4. Check Logs
You should see:
```
📝 Profile update detected: <user-id>
🌐 Federating profile update: <username>
Changed fields: { display_name: true, ... }
✅ Profile update for <username> queued for federation
```

### 5. Verify on Mastodon
- Wait ~30 seconds (cache timeout)
- View your profile from Mastodon
- Should see updated info + images

---

## What Gets Federated Now

**Outgoing (You → Fediverse):**
- ✅ Display name changes
- ✅ Bio changes
- ✅ Avatar uploads
- ✅ Banner uploads

**Incoming (Fediverse → You):**
- ✅ Remote user profile updates are received and stored

---

## Notes

- Profile updates are broadcast to ALL followers
- Uses same retry queue as posts
- Only local users trigger federation (prevents loops)
- Remote users' existing absolute URLs are preserved

---

**Before this fix**: Mastodon couldn't see your avatar because we sent `user-id/avatar.webp`  
**After this fix**: Mastodon gets `https://project.supabase.co/storage/v1/object/public/avatars/user-id/avatar.webp`

Much better! 🎉

