/**
 * Federation Queue Worker
 *
 * Runs BullMQ queue workers, LISTEN/NOTIFY instant job bridging,
 * and the DeliveryQueue retry processor.  No HTTP server.
 *
 * Usage:
 *   FEDERATION_MODE=worker npm start
 *   npm run start:worker
 */

import config from './config/index.js';
import { logger } from './utils/logger.js';
import { bullmqManager } from './queue/BullMQManager.js';
import { NotificationListener } from './queue/NotificationListener.js';
import { startDatabaseListener } from './listeners/DatabaseListener.js';
import { startPushNotificationListener } from './listeners/PushNotificationHandler.js';
import { DeliveryQueue } from './activitypub/DeliveryQueue.js';
import { BlockedInstancesCache } from './services/BlockedInstancesCache.js';
import { redis } from './services/RedisService.js';

let deliveryRetryIntervalId: ReturnType<typeof setInterval> | null = null;
let notificationListener: NotificationListener | null = null;

export async function startWorker(): Promise<void> {
  logger.info('Harmony Federation Worker starting...');
  logger.info(`Environment: ${config.NODE_ENV}`);
  logger.info(`Instance: ${config.INSTANCE_NAME} (${config.INSTANCE_DOMAIN})`);

  await redis.connect();
  logger.info(`Redis: ${redis.ready ? 'connected' : 'unavailable (fallback mode)'}`);

  await BlockedInstancesCache.initialize().catch((error) => {
    logger.error('Failed to initialize blocked instances cache:', error);
  });

  if (config.USE_BULLMQ_QUEUE) {
    logger.info('Starting BullMQ workers...');
    await bullmqManager.start();

    // LISTEN/NOTIFY bridge for instant (sub-second) job pickup. This needs a
    // direct, session-mode Postgres connection (LISTEN cannot go through
    // PostgREST/poolers). It is an OPTIMIZATION, not a hard requirement:
    // FEDERATION_LISTENER_URL is preferred (a dedicated least-privilege
    // `harmony_listener` role - see 20260607_federation_listener_role.sql),
    // with DATABASE_URL accepted for backward compatibility.
    //
    // When no listener connection is available we degrade gracefully: the
    // 60s periodic sweep + 30s delivery-queue retry below still pick jobs up,
    // just at higher latency. We do NOT crash - federation keeps working.
    const connectionString =
      process.env.FEDERATION_LISTENER_URL || process.env.DATABASE_URL;

    if (connectionString) {
      notificationListener = new NotificationListener(
        connectionString,
        (jobName) => bullmqManager.getQueue(jobName),
      );
      await notificationListener.start();
      logger.info('NotificationListener bridging pg_notify -> BullMQ (instant pickup)');
    } else {
      logger.warn(
        'No listener DB connection set (FEDERATION_LISTENER_URL/DATABASE_URL). ' +
        'Federation jobs will be processed by the periodic sweep (60s) and ' +
        'delivery retry (30s) instead of instantly. Configure a least-privilege ' +
        'listener connection for low-latency federation.',
      );
    }

    bullmqManager.startPeriodicSweep();

    try {
      const { PushNotificationService } = await import('./services/PushNotificationService.js');
      if (PushNotificationService.initialize()) {
        logger.info('Push notification service initialized');
      } else {
        logger.warn('Push notifications not available (VAPID not configured)');
      }
    } catch (error) {
      logger.error('Failed to initialize push notification service:', error);
    }
  } else {
    logger.info('Starting legacy DatabaseListener...');
    await startDatabaseListener();
    await startPushNotificationListener();
  }

  deliveryRetryIntervalId = setInterval(async () => {
    try {
      await DeliveryQueue.processQueue();
    } catch (error) {
      logger.error('Failed to process delivery queue:', error);
    }
  }, 30000);

  logger.info('Delivery queue retry processor started (30s interval)');
  logger.info('Harmony Federation Worker is ready');
}

export async function stopWorker(): Promise<void> {
  logger.info('Stopping Federation Worker...');

  if (deliveryRetryIntervalId) {
    clearInterval(deliveryRetryIntervalId);
    deliveryRetryIntervalId = null;
  }

  if (notificationListener) {
    await notificationListener.stop();
    notificationListener = null;
  }

  if (config.USE_BULLMQ_QUEUE) {
    await bullmqManager.stop();
  }

  await redis.disconnect();
  logger.info('Federation Worker stopped');
}
