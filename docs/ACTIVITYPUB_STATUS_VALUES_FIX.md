# ActivityPub Status Values Schema Compliance Fix

## Issue Identified
The inbox function and trigger were using status values (`'validated'`, `'invalid'`) that are not valid according to the `ap_activities` table schema constraints.

## Schema Constraints
The `ap_activities.status` column has a CHECK constraint that only allows these values:
- `'pending'`
- `'processing'` 
- `'completed'`
- `'failed'`
- `'received'`
- `'processed'`

## Invalid Values Used Before Fix
- ❌ `'validated'` - Not in schema constraint
- ❌ `'invalid'` - Not in schema constraint

## Status Flow After Fix

### Inbox Function (`/supabase/functions/inbox/index.ts`)
1. **Initial Storage**: `'received'` ✅
   - Activity is stored with this status when first received
2. **After Validation Success**: `'processing'` ✅
   - Activity passes validation and is ready for trigger processing
3. **After Validation Failure**: `'failed'` ✅
   - Activity fails validation

### Trigger (`/migrations/unified_activitypub_processing_trigger.sql`)
1. **Processes Activities With**: `'processing'` ✅
   - Only processes activities that passed inbox validation
2. **After Successful Processing**: `'processed'` ✅
   - Activity business logic completed successfully
3. **After Processing Failure**: `'failed'` ✅
   - Activity processing encountered an error

## Professional Status Flow
```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  received   │───▶│ processing  │───▶│ processed   │    │   SUCCESS   │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
      │                     │
      ▼                     ▼
┌─────────────┐    ┌─────────────┐
│   failed    │    │   failed    │
│(validation) │    │(processing) │
└─────────────┘    └─────────────┘
```

## Files Updated
1. **`/supabase/functions/inbox/index.ts`**
   - Changed `'validated'` → `'processing'`
   - Changed `'invalid'` → `'failed'`

2. **`/migrations/unified_activitypub_processing_trigger.sql`**
   - Changed trigger condition from `'validated'` → `'processing'`
   - Updated comments and documentation

## Benefits
- ✅ Schema compliance - no constraint violations
- ✅ Clear status progression flow
- ✅ Professional separation of concerns
- ✅ Better error handling and debugging
- ✅ Consistent with database design

## Testing Required
- Verify inbox accepts activities and sets `'received'` status
- Verify inbox validation updates to `'processing'` or `'failed'` 
- Verify trigger processes `'processing'` activities
- Verify trigger updates to `'processed'` or `'failed'`
- Test error handling at both levels

## Migration Safety
These changes are backward compatible as they only affect new activity processing. Existing activities in the database will retain their current status values.
