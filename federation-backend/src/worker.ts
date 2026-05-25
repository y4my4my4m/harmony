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
    logger.info('Starting BullMQ workers with LISTEN/NOTIFY bridge...');
    await bullmqManager.start();

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for LISTEN/NOTIFY bridge');
    }

    notificationListener = new NotificationListener(
      connectionString,
      (jobName) => bullmqManager.getQueue(jobName),
    );
    await notificationListener.start();
    logger.info('NotificationListener bridging pg_notify -> BullMQ');

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
