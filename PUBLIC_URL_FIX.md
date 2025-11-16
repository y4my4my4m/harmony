# Fix: localhost URLs in Federation

## Problem

When using local Supabase (`http://localhost:8000`), the federation backend was sending localhost URLs to other instances:

```json
{
  "icon": {
    "url": "http://localhost:8000/storage/v1/object/public/avatars/..."
  }
}
```

**Other instances can't access `localhost:8000`!** ❌

## Solution

Added **separate public URL** for federation while keeping internal calls efficient.

### 1. Update `.env` File

Add this to `federation-backend/.env`:

```bash
# Internal URL - for backend API calls (fast local connection)
SUPABASE_URL=http://localhost:8000

# Public URL - for federation media URLs (accessible to other instances)
PUBLIC_SUPABASE_URL=https://db.mony.lol
```

### 2. How It Works

**Internal API Calls** (database queries, auth, etc.):
- Use `SUPABASE_URL` → `http://localhost:8000`
- Fast, direct connection to your local Supabase

**Public URLs** (avatars, banners sent to federated instances):
- Use `PUBLIC_SUPABASE_URL` → `https://db.mony.lol`
- Other instances can fetch your media

### 3. Code Changes

**`config/index.ts`**:
```typescript
PUBLIC_SUPABASE_URL: z.string().url().optional()
// Defaults to SUPABASE_URL if not set
```

**`utils/urlUtils.ts`**:
```typescript
function makeUrlPublic(url: string): string {
  return url.replace(
    config.SUPABASE_URL,      // http://localhost:8000
    config.PUBLIC_SUPABASE_URL // https://db.mony.lol
  );
}
```

**Before**:
```
http://localhost:8000/storage/v1/object/public/avatars/user-id/avatar.webp
```

**After**:
```
https://db.mony.lol/storage/v1/object/public/avatars/user-id/avatar.webp
```

### 4. Test

**Restart backend**:
```bash
cd ~/harmony/federation-backend
npm run dev
```

**Check Actor endpoint**:
```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m | jq
```

Should now show:
```json
{
  "icon": {
    "type": "Image",
    "url": "https://db.mony.lol/storage/v1/object/public/avatars/..."
  },
  "image": {
    "type": "Image",
    "url": "https://db.mony.lol/storage/v1/object/public/banners/..."
  }
}
```

✅ **Other instances can now access your media!**

---

## Benefits

- ✅ **Fast internal calls**: Backend → Supabase uses localhost (no network latency)
- ✅ **Public federation**: Other instances get proper public URLs
- ✅ **Flexible deployment**: Works with any Supabase setup (local, cloud, self-hosted)
- ✅ **Backwards compatible**: If `PUBLIC_SUPABASE_URL` not set, falls back to `SUPABASE_URL`

---

## Production Deployment

If deploying to production where Supabase is remote:

**Both the same**:
```bash
SUPABASE_URL=https://yourproject.supabase.co
PUBLIC_SUPABASE_URL=https://yourproject.supabase.co
# Or just omit PUBLIC_SUPABASE_URL (auto-uses SUPABASE_URL)
```

**Custom domain**:
```bash
SUPABASE_URL=https://yourproject.supabase.co
PUBLIC_SUPABASE_URL=https://media.yourdomain.com
```

---

## Summary

**Root Cause**: `getPublicUrl()` returned localhost URLs because `SUPABASE_URL` was `localhost:8000`  
**Solution**: Added `PUBLIC_SUPABASE_URL` config for federation-specific URLs  
**Result**: Fast internal calls + publicly accessible media URLs ✅

