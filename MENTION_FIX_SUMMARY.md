# Mention Display Fix Summary

## Problem
Mentions in ActivityPub posts were displaying incorrectly:
- Only part of the mention (e.g., "@har") was showing as blue/clickable
- Remote users were showing with domain even when they should show as local
- Inconsistent behavior between chat mentions and ActivityPub mentions

## Root Cause
The database function `convert_ap_to_jsonb` was incorrectly determining if a user is local:
- It only checked if the username contained an `@` symbol
- It didn't compare the domain with the current instance domain
- This meant `@y4my4m@har.mony.lol` was marked as remote instead of local

## Fixes Applied

### 1. Frontend - `useContentRenderer.ts`
**Location:** `/src/composables/useContentRenderer.ts`

**Changes:**
- Improved `formatMentionDisplay` function to properly handle local vs remote users
- Added explicit domain comparison with current instance domain
- Added HTML escaping to prevent display issues
- Now correctly shows:
  - Local users: `@username`
  - Remote users: `@username@domain`

```typescript
// Determine if user is local
// A user is local if:
// 1. isLocal is explicitly true, OR
// 2. domain is not set, OR
// 3. domain matches the current instance domain
const isLocal = mention.isLocal === true || !domain || domain === currentDomain;
```

### 2. Database - `convert_ap_to_jsonb` Function
**Location:** `/db_schema/migrations/fix_mention_islocal_detection.sql`

**Changes:**
- Fixed the function to correctly determine if a mention is local
- Now compares the mention's domain with the current instance domain
- Properly sets the `isLocal` field based on domain comparison

**Before:**
```sql
'isLocal', CASE 
    WHEN position('@' in v_username) > 0 THEN false
    ELSE true
END
```

**After:**
```sql
'isLocal', CASE 
    WHEN v_mention_domain IS NULL OR v_mention_domain = v_current_domain THEN true
    ELSE false
END
```

## How to Apply

### Option 1: Run the migration script
```bash
# Set your Supabase connection URL
export SUPABASE_DB_URL='postgresql://postgres:[PASSWORD]@[PROJECT-REF].supabase.co:5432/postgres'

# Run the script
./APPLY_MENTION_FIX.sh
```

### Option 2: Apply manually
```bash
psql "$SUPABASE_DB_URL" -f db_schema/migrations/fix_mention_islocal_detection.sql
```

## Expected Behavior After Fix

### Local User Mentions
- Input: `@y4my4m` or `@y4my4m@har.mony.lol`
- Display: `@y4my4m` (blue, clickable)
- Entire mention is styled consistently

### Remote User Mentions  
- Input: `@someone@mastodon.social`
- Display: `@someone@mastodon.social` (blue, clickable)
- Full mention including domain is styled

### Consistency
- Chat mentions and ActivityPub mentions now behave identically
- Proper HTML escaping prevents display bugs
- Mention styling applies to the entire mention text

## Testing
After applying the fix:
1. Create a post mentioning a local user: `@y4my4m`
2. Create a post mentioning a remote user: `@someone@mastodon.social`
3. Verify that:
   - Local mentions show without domain
   - Remote mentions show with domain
   - The entire mention is blue/styled
   - Clicking works correctly

## Files Modified
- ✅ `src/composables/useContentRenderer.ts` - Frontend mention display logic
- ✅ `db_schema/migrations/fix_mention_islocal_detection.sql` - Database function fix
- ✅ `APPLY_MENTION_FIX.sh` - Migration application script

## Notes
- The fix is backwards compatible with existing mentions
- No data migration needed - only the parsing logic changes
- Frontend changes take effect immediately after refresh
- Database changes take effect after running the migration

