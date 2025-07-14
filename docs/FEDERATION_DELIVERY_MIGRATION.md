# Migration Guide: Edge Function to Database Function

This document outlines the migration from Edge Function-based delivery to Database Function-based delivery for better performance and reliability.

## What Changed

### Before: Edge Function Approach
- HTTP-based delivery worker (`supabase/functions/delivery-worker/index.ts`)
- Cron jobs calling Edge Function via HTTP
- Higher latency, cold starts, HTTP overhead

### After: Database Function Approach  
- Database functions for delivery processing
- Direct cron job calls to database functions
- Better performance, no cold starts, direct database access

## Migration Steps

### 1. Deploy New Database Functions

Run the new migration to create the database functions:

```sql
-- Apply the new database function migration
\i migrations/federation_delivery_worker_function.sql
```

This creates:
- `process_federation_delivery_queue()` - Main delivery processor
- `cleanup_federation_delivery_queue()` - Cleanup old records
- `collect_federation_stats()` - Statistics collection

### 2. Update Cron Jobs

Run the updated cron job setup:

```sql
-- Apply the updated cron job configuration
\i migrations/setup_federation_cron.sql
```

This updates the cron jobs to call database functions directly instead of HTTP endpoints.

### 3. Clean Up Edge Function (Optional)

You can safely remove the Edge Function files:

```bash
# Remove the Edge Function directory
rm -rf supabase/functions/delivery-worker/
```

### 4. Test the New System

```typescript
// Test manual delivery processing
import { federationService } from '@/services/FederationService';

const result = await federationService.manualTriggerDelivery();
console.log('Delivery result:', result);
```

## Benefits of Database Functions

### Performance Improvements
- **No Cold Starts**: Database functions are always warm
- **Direct Database Access**: No HTTP overhead for database operations
- **Better Resource Utilization**: More efficient for background processing

### Reliability Improvements
- **Simpler Architecture**: Fewer moving parts and failure points
- **Better Error Handling**: Native PostgreSQL error handling
- **Atomic Operations**: Database transactions ensure consistency

### Cost Efficiency
- **Lower Costs**: Database functions are cheaper than Edge Functions for background tasks
- **Resource Efficiency**: Better CPU and memory utilization

## Configuration

### Database Function Settings

The delivery function processes up to 50 deliveries per run to avoid long-running transactions:

```sql
-- Configurable batch size
LIMIT 50  -- Process in batches
```

### Cron Job Frequency

Current schedule:
- **Delivery Processing**: Every 2 minutes
- **Cleanup**: Daily at 2 AM  
- **Stats Collection**: Every 6 hours

### Retry Logic

Exponential backoff with max 5 attempts:
- Attempt 1: Immediate
- Attempt 2: 2 minutes later
- Attempt 3: 4 minutes later
- Attempt 4: 8 minutes later
- Attempt 5: 16 minutes later

## Monitoring

### Database Queries

Check delivery queue status:

```sql
-- Overall queue health
SELECT 
    status,
    COUNT(*) as count,
    AVG(attempt_count) as avg_attempts
FROM federation_delivery_queue 
GROUP BY status;

-- Recent delivery performance  
SELECT 
    DATE_TRUNC('hour', created_at) as hour,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
    COUNT(*) FILTER (WHERE status = 'failed') as failed,
    AVG(delivery_duration_ms) as avg_duration_ms
FROM federation_delivery_queue
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

### Federation Stats

View collected statistics:

```sql
SELECT * FROM federation_delivery_stats 
ORDER BY period_start DESC 
LIMIT 10;
```

## Troubleshooting

### Manual Delivery Trigger

```typescript
// Manually process the queue
const result = await supabase.rpc('process_federation_delivery_queue');
console.log('Processing result:', result);
```

### Check Cron Jobs

```sql
-- View active cron jobs
SELECT * FROM cron.job WHERE jobname LIKE 'federation%';

-- Check cron job history
SELECT * FROM cron.job_run_details 
WHERE jobid IN (
    SELECT jobid FROM cron.job WHERE jobname LIKE 'federation%'
)
ORDER BY start_time DESC;
```

### Debug Failed Deliveries

```sql
-- Find failed deliveries with error details
SELECT 
    id,
    activity_id,
    target_domain,
    target_inbox,
    attempt_count,
    last_error,
    last_response
FROM federation_delivery_queue
WHERE status = 'failed'
ORDER BY created_at DESC;
```

## Rollback Plan

If you need to rollback to Edge Functions:

1. Redeploy the Edge Function:
   ```bash
   supabase functions deploy delivery-worker
   ```

2. Update cron jobs to call HTTP endpoint:
   ```sql
   -- Revert to HTTP calls
   SELECT cron.alter_job(
       'federation-delivery-worker',
       schedule => '*/2 * * * *',
       command => $$
       SELECT net.http_post(
           'https://har.mony.lol/functions/v1/delivery-worker',
           '{}',
           headers => '{"Content-Type": "application/json"}'::jsonb
       );
       $$
   );
   ```

3. Update `FederationService.ts` to use HTTP triggers again

## Conclusion

The migration to database functions provides:
- ✅ Better performance (no cold starts)
- ✅ Lower costs (more efficient resource usage)
- ✅ Simpler architecture (fewer HTTP calls)
- ✅ Better reliability (direct database access)
- ✅ Easier monitoring (database-native logging)

This approach is more suitable for background processing tasks like federation delivery.
