# Featured Endpoint Column Fix

## Issue
The featured endpoint was referencing a non-existent `interactions_count` column, causing database errors when accessing the endpoint.

## Root Cause
The previous migration file `/migrations/fix_featured_endpoint_quick.sql` contained references to `interactions_count` which doesn't exist in the posts table schema. The correct engagement columns are:
- `favorites_count` 
- `reblogs_count`
- `replies_count`

## Solution Applied

### 1. Fixed Migration File
- **Removed:** `/migrations/fix_featured_endpoint_quick.sql` (moved to `.old`)
- **Created:** `/migrations/fix_featured_endpoint_column_names.sql`

The new migration:
- Drops incorrect indexes and functions referencing `interactions_count`
- Creates correct indexes using `(favorites_count + reblogs_count + replies_count)`
- Adds `is_pinned` column for proper featured post functionality
- Creates database functions `get_user_featured_posts()` and `get_featured_posts_hybrid()`
- Uses proper engagement calculation throughout

### 2. Updated Featured Endpoint
- **File:** `/supabase/functions/featured/index.ts`
- **Changed:** From direct table query to using `get_user_featured_posts()` function
- **Benefits:** 
  - Correct column references
  - Support for pinned posts
  - Smart hybrid sorting (pinned first, then by engagement)
  - Better performance with proper indexes

### 3. Database Functions Created

#### `get_user_featured_posts(p_author_id, p_limit)`
- Returns featured posts for a user
- Prioritizes pinned posts, then sorts by engagement
- Uses correct engagement calculation: `favorites_count + reblogs_count + replies_count`

#### `get_featured_posts_hybrid(p_author_id, p_limit)`
- Advanced version that fills with popular posts if not enough pinned posts
- More sophisticated logic for mixed content scenarios

## Schema Verification
Confirmed posts table has these engagement columns:
```sql
favorites_count integer DEFAULT 0,
reblogs_count integer DEFAULT 0,
replies_count integer DEFAULT 0,
```

## Next Steps
1. Run the new migration: `/migrations/fix_featured_endpoint_column_names.sql`
2. Test the featured endpoint: `GET /.well-known/nodeinfo/featured`
3. Verify pinned post functionality works when `is_pinned` is set to `true`

## Files Modified
- `/supabase/functions/featured/index.ts` - Updated to use correct database function
- `/migrations/fix_featured_endpoint_column_names.sql` - New corrected migration
- `/migrations/fix_featured_endpoint_quick.sql` - Moved to `.old` (incorrect column refs)

The featured endpoint should now work correctly without column reference errors.
