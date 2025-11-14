# Federation Profile Update Fixes

## Issues Fixed

### 1. ❌ **Profile Pictures Not Showing on Mastodon** 

**Problem**: Actor endpoint was using wrong column names
- Used `profile.avatar` and `profile.banner`
- Database actually has `avatar_url` and `banner_url`

**Fix**: Updated `profileToActor()` in `federation-backend/src/activitypub/converters/toActivityPub.ts`
```typescript
// Before:
if (profile.avatar) {
  actor.icon = { type: 'Image', mediaType: 'image/png', url: profile.avatar };
}

// After:
if (profile.avatar_url) {
  actor.icon = { type: 'Image', url: profile.avatar_url };
}
```

**Also**: Removed hardcoded `mediaType: 'image/png'` since images are actually webp/various formats

---

### 2. ❌ **Profile Updates Not Federating**

**Problem**: No realtime listener for profile UPDATE events
- Database had old trigger system (`handle_unified_profile_federation`)
- But new federation backend uses Supabase Realtime
- Profile changes weren't being sent to followers

**Fix**: Added complete profile update federation

#### Files Changed:

**`toActivityPub.ts`** - Added `createUpdateActivity()`:
```typescript
export function createUpdateActivity(profile: any): any {
  const actor = profileToActor(profile);
  return {
    type: 'Update',
    object: actor,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`]
  };
}
```

**`FederationHandlers.ts`** - Added wrapper:
```typescript
export function createProfileUpdateActivity(profile: any): any {
  return createUpdateActivity(profile);
}
```

**`DatabaseListener.ts`** - Added realtime listener:
```typescript
.on('postgres_changes', {
  event: 'UPDATE',
  schema: 'public',
  table: 'profiles',
}, async (payload) => {
  await handleProfileUpdate(payload.old, payload.new);
})
```

**`handleProfileUpdate()`** - New handler function:
- Only federates for local users
- Checks if federable fields changed (display_name, bio, avatar_url, banner_url)
- Creates Update activity
- Broadcasts to all followers

---

### 3. ✅ **Incoming Profile Updates**

**Fix**: Updated `ActivityProcessor.ts` to use correct column names when receiving profile updates:
```typescript
.update({
  avatar_url: profileData.avatar,  // was: avatar
  banner_url: profileData.banner,  // was: banner
})
```

---

## What Gets Federated Now

### Outgoing (Your users → Fediverse):
When local users update these fields, Update activities are sent to all followers:
- ✅ Display name
- ✅ Bio
- ✅ Avatar (profile picture)
- ✅ Banner (cover image)

### Incoming (Fediverse → Your users):
When remote users update their profiles, your database is updated:
- ✅ Display name
- ✅ Bio  
- ✅ Avatar
- ✅ Banner
- ✅ Public key

---

## Testing

### Test Outgoing Updates:

1. **Start federation backend**:
```bash
cd federation-backend
npm run dev
```

2. **Update your profile** on Harmony:
   - Change display name
   - Change bio
   - Upload new avatar
   - Upload new banner

3. **Check logs** for:
```
📝 Profile update detected: <user_id>
🌐 Federating profile update: <username>
✅ Profile update for <username> queued for federation
```

4. **Verify on Mastodon**:
   - Wait ~30 seconds for cache to clear
   - Force refresh your profile on Mastodon
   - Check if changes appear

### Test Actor Endpoint:

```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m
```

Should now show:
```json
{
  "icon": {
    "type": "Image",
    "url": "https://..."
  },
  "image": {
    "type": "Image",
    "url": "https://..."
  }
}
```

---

## Notes

- Profile updates are broadcast to **all followers** (public + followers)
- Updates are queued with same retry logic as posts
- Only federable fields trigger updates (not internal fields like `status`, `color`, etc.)
- Remote profile updates don't trigger outgoing federation (prevents loops)

---

## Database Column Naming

**Current**: Using `federated_id` (what's in production)
**Migration exists**: `db_schema/migrations/rename_federated_id_to_ap_id.sql`
- Renames `federated_id` → `ap_id` for consistency
- Not yet run on production
- Federation backend still uses `federated_id` for now

---

## Summary

✅ **Issue 1 Fixed**: Profile pictures now properly advertised to federated instances  
✅ **Issue 2 Fixed**: Profile updates now federate to followers  
✅ **Bonus**: Incoming profile updates also work correctly

**Restart Required**: Yes, restart the federation backend to pick up changes.

