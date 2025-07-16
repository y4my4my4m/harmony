# ActivityPub Retry System Implementation

## Issue Identified
The previous implementation marked failed activities as permanently failed without utilizing the retry mechanism built into the `ap_activities` table schema.

## Schema Support for Retries
The `ap_activities` table includes retry fields:
- `attempts` (integer, default 0) - Number of processing attempts
- `last_attempt_at` (timestamp) - When last processing was attempted  
- `next_attempt_at` (timestamp) - When next retry should occur

## Federation Queue vs Activity Retry
- **`federation_delivery_queue`**: For **outgoing** activities to remote instances
- **`ap_activities` retry fields**: For **incoming** activities that failed processing

## Retry System Implementation

### 1. Inbox Validation Failures
- **No Retry**: Validation failures are permanent (malformed data)
- **Status**: `'failed'` with attempt count set to 1

### 2. Trigger Processing Failures  
- **Retry Logic**: Up to 3 attempts with exponential backoff
- **Backoff Schedule**: 
  - Attempt 1 → 2: 5 minutes
  - Attempt 2 → 3: 20 minutes  
  - Attempt 3 → Final: 60 minutes
- **Status Flow**: `'processing'` → `'pending'` (retry) → `'failed'` (permanent)

### 3. Retry Queue Processor
New function `process_failed_activities_retry()`:
- Processes activities ready for retry (`status='pending'` + `next_attempt_at <= NOW()`)
- Updates status to `'processing'` to trigger re-processing
- Abandons activities stuck in queue >24 hours
- Should be called every 5 minutes via cron/scheduler

## Professional Status Flow

```
Incoming Activity
      ↓
  received (inbox stores)
      ↓
  processing (inbox validates)
      ↓
┌─────────────────────────────┐
│     Trigger Processing      │
├─────────────────────────────┤
│ Success → processed ✅      │
│ Failure → pending (retry)   │
│   ↓ 5min delay             │
│ Retry 1 → pending (retry)   │
│   ↓ 20min delay            │
│ Retry 2 → pending (retry)   │
│   ↓ 60min delay            │
│ Final → failed ❌          │
└─────────────────────────────┘
```

## Files Updated

### 1. Inbox (`/supabase/functions/inbox/index.ts`)
- Validation failures set attempt count for tracking
- No retry for validation failures (malformed data)

### 2. Trigger (`/migrations/unified_activitypub_processing_trigger.sql`)
- Enhanced exception handling with retry logic
- Exponential backoff calculation
- Processes both new and retry activities
- Added `process_failed_activities_retry()` function

## Implementation Benefits

### ✅ Resilience
- Transient network/database issues don't cause permanent failures
- Federation remains robust during outages

### ✅ Performance  
- Failed activities don't block new processing
- Exponential backoff prevents thundering herd

### ✅ Observability
- Clear distinction between validation vs processing failures
- Retry attempts tracked for monitoring

### ✅ Professional Standards
- Follows ActivityPub best practices for federation
- Graceful degradation during issues

## Setup Instructions

### 1. Deploy Migration
```sql
-- Apply the updated migration
\i migrations/unified_activitypub_processing_trigger.sql
```

### 2. Setup Retry Processor
```sql
-- Call every 5 minutes via cron or scheduler
SELECT process_failed_activities_retry();
```

### 3. Monitor Activity Status
```sql
-- Check activity processing status
SELECT 
    status, 
    count(*) as count,
    avg(attempts) as avg_attempts
FROM ap_activities 
GROUP BY status 
ORDER BY count DESC;

-- Check retry queue
SELECT 
    ap_type,
    attempts,
    error_message,
    next_attempt_at
FROM ap_activities 
WHERE status = 'pending' 
AND attempts > 0
ORDER BY next_attempt_at;
```

## Error Handling

### Validation Errors (Permanent)
- Malformed ActivityPub data
- Invalid actor URLs
- Missing required fields
- **No Retry**: Mark as failed immediately

### Processing Errors (Retry)
- Database connection issues
- Temporary profile fetch failures  
- Network timeouts
- **Retry**: Up to 3 attempts with backoff

### Monitoring
- Track retry queue size: `SELECT count(*) FROM ap_activities WHERE status='pending' AND attempts > 0`
- Monitor failure patterns: `SELECT error_message, count(*) FROM ap_activities WHERE status='failed' GROUP BY error_message`
- Queue health: Activities stuck >24 hours are auto-abandoned

## Migration Safety
- Backward compatible with existing failed activities
- New retry logic only applies to future failures
- Existing failed activities remain failed (no automatic retry)
