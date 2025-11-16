# Profile Federation Trigger Conflict - RESOLVED

## The Problem

You had **TWO SYSTEMS** handling profile updates simultaneously:

### 1. Old Database Trigger (BAD)
```sql
CREATE TRIGGER trigger_unified_profile_federation 
AFTER UPDATE ON profiles 
FOR EACH ROW EXECUTE FUNCTION handle_unified_profile_federation();
```

This trigger:
- ❌ Sends **relative paths** directly: `"url": "user-id/avatar.webp"`
- ❌ Writes to `ap_activities` table
- ❌ Causes duplicate events

**What it sent**:
```json
{
  "icon": {
    "type": "Image",
    "url": "bce63d98-6b14-4c7e-b8d5-8776d2c0ee04/poring-ragnarok.gif"
  }
}
```
☠️ **Other instances can't access this!**

### 2. New Realtime Listener (GOOD)
```typescript
.on('postgres_changes', {
  event: 'UPDATE',
  schema: 'public',
  table: 'profiles',
}, handleProfileUpdate)
```

This listener:
- ✅ Converts relative → absolute URLs
- ✅ Direct delivery (no intermediate table)
- ✅ Consistent with other federation events

**What it sends**:
```json
{
  "icon": {
    "type": "Image",
    "url": "https://project.supabase.co/storage/v1/object/public/avatars/bce63d98.../poring.gif"
  }
}
```
✅ **Other instances CAN access this!**

---

## The Conflict

When you updated your banner:

1. **Database trigger fired** → sent update with relative path
2. **Realtime listener fired** → sent update with absolute path (after my fix)
3. **Realtime saw INSERT to ap_activities** → sent another update

Result: **3 updates sent to Mastodon!**

---

## The Fix

**Run this SQL**:
```bash
psql -U postgres -d postgres -f ~/harmony/db_schema/disable_old_profile_federation_trigger.sql
```

This **drops the old trigger** but keeps the function for reference.

---

## After Fix

**One banner update** = **One federation event** with proper URLs ✅

---

## Why Mastodon Didn't Update Immediately

Even with proper URLs, Mastodon:
1. Caches profile data for ~24 hours
2. May ignore rapid-fire updates (rate limiting)
3. Needs time to fetch and cache new images

**To force refresh**:
- Wait 30-60 seconds
- Clear Mastodon cache (if you have access)
- Have someone else view your profile (fresh cache)
- Or just wait ~30 minutes for natural cache expiry

---

## Verification

After disabling the trigger, update your profile again. You should see:

**Before**:
```
📝 Profile update detected
📝 Profile update detected  ← DUPLICATE
📝 Profile update detected  ← DUPLICATE
```

**After**:
```
📝 Profile update detected  ← ONLY ONE!
Changed fields: banner_url: "old/path.webp" → "new/path.webp"
Update activity object: {
  hasImage: true,
  imageUrl: "https://project.supabase.co/storage/..."
}
```

---

## Summary

**Root Cause**: Old database trigger + new realtime listener both running  
**Problem**: Sending relative paths that other instances can't access  
**Solution**: Disable old trigger, use only realtime listener  
**Result**: Proper URLs, no duplicates, happy federation ✅

