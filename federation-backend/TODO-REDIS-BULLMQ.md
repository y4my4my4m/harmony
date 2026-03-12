# Redis + BullMQ: Future Migration Path

## Current Stack

- **Job queue**: pg-boss (PostgreSQL-backed)
- **Instant pickup**: PostgreSQL LISTEN/NOTIFY -> NotificationListener
- **Polling fallback**: pg-boss workers at 10-second intervals
- **Delivery retries**: federation_delivery_queue table + 30-second processor
- **Caching**: In-memory NodeCache + BlockedInstancesCache

This setup works well for small-to-medium federation traffic. Consider
migrating to Redis + BullMQ when you hit the bottlenecks described below.

## Why BullMQ

| Feature | pg-boss (current) | BullMQ (future) |
|---|---|---|
| Job pickup | LISTEN/NOTIFY + polling fallback | Redis pub/sub (fully event-driven) |
| Dashboard | None | [Bull Board](https://github.com/felixmosh/bull-board) -- web UI for queue monitoring, job inspection, retry/remove |
| Rate limiting | Manual implementation | Built-in per-queue and per-group rate limiting |
| Priority queues | Basic integer priority | Fine-grained priority with dedicated workers |
| Horizontal scaling | Works (atomic claims via SQL) | Native -- named workers across machines, auto-balancing |
| Concurrency control | Per-queue worker count | Per-worker, per-queue, global concurrency settings |
| Job dependencies | Not supported | Job flows, parent-child, and dependency chains |
| Repeatable jobs | pg-boss cron scheduling | Built-in cron + every-N patterns |
| DB load | ~10 polling queries/second (with 10s interval) | Zero DB polling -- Redis is the queue |

## When to Consider

- pg-boss polling becomes a measurable PostgreSQL bottleneck (check `pg_stat_activity`)
- You need per-domain rate limiting to avoid getting blocked by remote instances
- You want a web dashboard for queue monitoring and debugging
- You need to run N worker processes across multiple machines
- You need job dependency chains (e.g., "send Accept after processing Follow")

## Migration Path

1. **Add Redis**: Already in docker-compose (redis:7-alpine, unused by federation backend)
2. **Install BullMQ**: `npm install bullmq` (no pg dependency needed for queue)
3. **Replace pg-boss with BullMQ**:
   - QueueManager creates BullMQ `Queue` and `Worker` instances instead of pg-boss
   - NotificationListener stays -- it just calls `queue.add()` instead of `boss.fetch()`
   - Same handler functions, just different job lifecycle management
4. **DB triggers**: Keep `queue_federation_job()` with pg_notify -- NotificationListener
   bridges the notification into BullMQ instead of pg-boss fetch
5. **Dashboard**: Add Bull Board as an Express route (protected by admin auth)
6. **federation_delivery_queue**: Keep as audit log / persistent fallback -- BullMQ
   handles retries in Redis, this table records delivery history
7. **Caching**: Optionally move NodeCache to Redis for shared state across processes

## Bull Board Dashboard

One of the biggest wins. Gives you:
- Real-time view of all queues (pending, active, completed, failed, delayed)
- Individual job inspection (data, logs, stack traces on failure)
- Manual retry / remove / promote from UI
- Metrics and throughput charts

```typescript
// Example setup (future)
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

const serverAdapter = new ExpressAdapter();
createBullBoard({
  queues: federationQueues.map(q => new BullMQAdapter(q)),
  serverAdapter,
});
app.use('/admin/queues', authMiddleware, serverAdapter.getRouter());
```

## Estimated Effort

- Small: 2-3 days for core migration (pg-boss -> BullMQ)
- Medium: +1 day for Bull Board dashboard
- Optional: +1 day for per-domain rate limiting
- Optional: +1 day for Redis-backed caching (replace NodeCache)

## Links

- [BullMQ docs](https://docs.bullmq.io/)
- [Bull Board](https://github.com/felixmosh/bull-board)
- [BullMQ patterns](https://docs.bullmq.io/patterns/producer-consumer)
