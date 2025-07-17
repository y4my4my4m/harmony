# ActivityPub Activity Deduplication Solution

## Problem
The system was experiencing duplicate key constraint violations on the `ap_activities.ap_id` field when remote ActivityPub servers sent the same activity multiple times. This is a common scenario in federation:

- Network retries causing duplicate delivery
- Server-side retry logic 
- Users performing the same action multiple times (follow/unfollow/follow)
- Webhook delivery failures with retries

## Error Details
```
duplicate key value violates unique constraint "ap_activities_ap_id_key"
Key (ap_id)=(https://misskey.io/notes/aaaidmqcpazp0568/activity) already exists.
```

## Solution Overview
Implemented **idempotent activity handling** at both the application and database levels:

### 1. Database-Level Solution (`fix_ap_activity_duplicates.sql`)

Created two PostgreSQL functions:

#### `upsert_ap_activity()`
- **Purpose**: Safely insert or update ActivityPub activities with full idempotent behavior
- **Logic**:
  - If activity doesn't exist → Insert new activity
  - If activity exists and is `completed`/`processed` → Return existing ID (idempotent)
  - If activity exists and is `failed`/`pending` → Update with fresh data for retry
  - If activity exists and is `processing`/`received` → Update data, keep status
- **Returns**: `(activity_id, was_updated)` tuple

#### `insert_ap_activity_safe()`
- **Purpose**: Simplified wrapper that returns just the activity ID
- **Use Case**: Direct replacement for basic INSERT operations

### 2. Application-Level Solution (`inbox/index.ts`)

Updated the ActivityPub inbox endpoint to:
- Use `upsert_ap_activity()` instead of direct INSERT
- Handle idempotent responses properly
- Provide clear logging for different scenarios
- Maintain proper HTTP status codes (202 Accepted)

## ActivityPub Idempotency Standards

According to ActivityPub specification:
- **Activities MUST be idempotent** - receiving the same activity multiple times should have the same effect
- **Activity IDs are globally unique** - same ID = same activity
- **Servers SHOULD handle duplicate delivery gracefully**

## Implementation Details

### Status Flow
```
New Activity → 'received' → 'processing' → 'completed'/'processed'
Failed Activity → 'failed' → (on retry) → 'received' → ...
```

### Conflict Resolution Strategy
1. **Completed Activities**: Return success immediately (true idempotency)
2. **Failed Activities**: Retry with fresh data 
3. **Processing Activities**: Update data but preserve processing state
4. **New Activities**: Insert normally

### Benefits
- ✅ Eliminates duplicate key constraint violations
- ✅ Proper ActivityPub idempotent behavior  
- ✅ Allows legitimate retries for failed activities
- ✅ Maintains data consistency
- ✅ Preserves audit trail with status tracking
- ✅ Database-level safety with minimal application changes

## Usage Examples

### Before (Error-Prone)
```sql
INSERT INTO ap_activities (...) VALUES (...); -- Could fail on duplicates
```

### After (Idempotent)
```sql
SELECT * FROM upsert_ap_activity(...); -- Always succeeds
```

### Edge Function Usage
```typescript
const { data: insertResult, error } = await supabase
  .rpc('upsert_ap_activity', {
    p_ap_id: activity.id,
    p_ap_type: activity.type,
    // ... other parameters
  })
```

## Migration Instructions

1. **Apply the migration**: Run `fix_ap_activity_duplicates.sql`
2. **Update edge functions**: Use `upsert_ap_activity()` instead of direct INSERT
3. **Test with duplicate activities**: Verify idempotent behavior
4. **Monitor logs**: Check for "Updated existing activity" vs "new activity" messages

## Future Considerations

- Consider adding activity expiration for very old failed activities
- Implement rate limiting per actor to prevent abuse
- Add metrics tracking for duplicate activity rates
- Consider batch processing for high-volume scenarios

## Related Files
- `/migrations/fix_ap_activity_duplicates.sql` - Database functions
- `/supabase/functions/inbox/index.ts` - Updated endpoint
- `/db_schema/supabase_schema_backup_latest.sql` - Original constraint definition
