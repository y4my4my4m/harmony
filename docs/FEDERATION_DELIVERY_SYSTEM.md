# ActivityPub Federation System

## Overview

The Harmony federation system enables ActivityPub post interactions (favorites/likes and reblogs/announces) to federate to remote users. This means when you favorite or reblog a post from a remote user (e.g., from Mastodon), they will receive a notification about your interaction.

## Architecture

### Components

1. **FederationService** (`src/services/FederationService.ts`)
   - Handles activity creation and queuing
   - Manages HTTP delivery to remote inboxes
   - Implements retry logic with exponential backoff

2. **Delivery Worker** (`supabase/functions/delivery-worker/index.ts`)
   - Supabase Edge Function that processes the delivery queue
   - Sends HTTP POST requests to remote ActivityPub inboxes
   - Handles failures and retry scheduling

3. **Database Tables**
   - `ap_activities`: Stores ActivityPub activities (Like, Announce, etc.)
   - `federation_delivery_queue`: Queues activities for delivery to remote servers
   - `federation_delivery_stats`: Optional statistics tracking

4. **Cron Jobs** (`migrations/setup_federation_cron.sql`)
   - Automatically processes delivery queue every 2 minutes
   - Daily cleanup of old delivery records
   - Federation health monitoring

## How It Works

### For Favorites (Likes)

1. User clicks favorite on a remote post
2. `activityPubService.toggleFavorite()` is called
3. Local `post_interactions` table is updated
4. `federationService.federateLike()` creates a Like activity
5. Activity is stored in `ap_activities` table
6. Delivery is queued in `federation_delivery_queue` for the post author's inbox
7. Delivery worker processes the queue and sends HTTP POST to remote inbox
8. Remote server (e.g., Mastodon) receives the Like and notifies the user

### For Reblogs (Announces)

1. User clicks reblog on a remote post
2. `activityPubService.toggleReblog()` is called  
3. Local `post_interactions` table is updated
4. A reblog post is created in the local `posts` table
5. `federationService.federateAnnounce()` creates an Announce activity
6. Same delivery process as favorites

### For Bookmarks

Bookmarks are **intentionally local-only** and do not federate. This follows ActivityPub best practices where bookmarks are private to the user.

## Setup

### 1. Database Setup

Run the federation cron job setup:

```sql
-- Execute the migration
\i migrations/setup_federation_cron.sql
```

### 2. Deploy Edge Function

Deploy the delivery worker:

```bash
supabase functions deploy delivery-worker
```

### 3. Environment Variables

Ensure these are set in your Supabase project:

- `DOMAIN`: Your instance domain (e.g., `har.mony.lol`)
- `SUPABASE_SERVICE_ROLE_KEY`: For the cron job to call the worker

## Testing

Use the built-in testing utilities:

```typescript
import { testFederation, testFavorite, checkQueue } from '@/utils/federationTesting';

// Run full test suite
await testFederation();

// Test specific functionality
await testFavorite('some-post-id');
await checkQueue();
```

## Monitoring

### Queue Status

Check delivery queue health:

```sql
SELECT 
  status,
  COUNT(*) as count,
  AVG(attempt_count) as avg_attempts
FROM federation_delivery_queue 
GROUP BY status;
```

### Recent Activity

Monitor recent federation activity:

```sql
SELECT 
  ap_type,
  status,
  COUNT(*) as count
FROM ap_activities 
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY ap_type, status;
```

### Delivery Performance

Check delivery success rates:

```sql
SELECT 
  target_domain,
  COUNT(*) as total_deliveries,
  COUNT(*) FILTER (WHERE status = 'delivered') as successful,
  COUNT(*) FILTER (WHERE status = 'failed') as failed,
  AVG(delivery_duration_ms) as avg_time_ms
FROM federation_delivery_queue
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY target_domain
ORDER BY total_deliveries DESC;
```

## Troubleshooting

### Common Issues

1. **Activities queued but not delivered**
   - Check if delivery worker is running: `supabase functions logs delivery-worker`
   - Verify cron job is active: `SELECT * FROM cron.job WHERE jobname LIKE 'federation%';`

2. **HTTP delivery failures**
   - Check remote server logs for rejected requests
   - Verify ActivityPub payload format
   - Ensure proper Content-Type headers

3. **Authentication errors**
   - HTTP signatures not yet implemented (TODO)
   - Some servers may reject unsigned requests

### Debug Commands

```sql
-- Check pending deliveries
SELECT * FROM federation_delivery_queue WHERE status = 'pending' LIMIT 10;

-- Check failed deliveries
SELECT target_domain, last_error, COUNT(*) 
FROM federation_delivery_queue 
WHERE status = 'failed' 
GROUP BY target_domain, last_error;

-- Manual delivery trigger
SELECT net.http_post('https://har.mony.lol/functions/v1/delivery-worker', '{}');
```

## Future Improvements

1. **HTTP Signatures**: Add cryptographic signing for security
2. **Rate Limiting**: Implement per-domain rate limits
3. **Delivery Analytics**: Enhanced monitoring and alerting
4. **Batch Delivery**: Optimize for high-volume instances
5. **Webhook Support**: Allow manual delivery triggers via API

## Notes

- Bookmarks remain local-only by design
- Delivery worker uses exponential backoff (1min → 5min → 30min → 2hr → 8hr)
- Failed deliveries after 5 attempts are marked as permanently failed
- Old delivery records are automatically cleaned up after 7 days
