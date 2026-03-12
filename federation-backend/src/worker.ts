/**
 * Federation Queue Worker
 *
 * Runs pg-boss queue workers, LISTEN/NOTIFY instant job pickup,
 * and the DeliveryQueue retry processor. No HTTP server.
 *
 * Usage:
 *   FEDERATION_MODE=worker npm start
 *   npm run start:worker
 */

import config from './config/index.js';
import { logger } from './utils/logger.js';
import { queueManager } from './queue/QueueManager.js';
import { startDatabaseListener } from './listeners/DatabaseListener.js';
import { startPushNotificationListener } from './listeners/PushNotificationHandler.js';
import { DeliveryQueue } from './activitypub/DeliveryQueue.js';
import { BlockedInstancesCache } from './services/BlockedInstancesCache.js';

let deliveryRetryIntervalId: ReturnType<typeof setInterval> | null = null;

export async function startWorker(): Promise<void> {
  logger.info('Harmony Federation Worker starting...');
  logger.info(`Environment: ${config.NODE_ENV}`);
  logger.info(`Instance: ${config.INSTANCE_NAME} (${config.INSTANCE_DOMAIN})`);

  await BlockedInstancesCache.initialize().catch((error) => {
    logger.error('Failed to initialize blocked instances cache:', error);
  });

  if (config.USE_PGBOSS_QUEUE) {
    logger.info('Starting pg-boss QueueManager with LISTEN/NOTIFY...');
    await queueManager.start();

    // Push notification service initialization
    try {
      const { PushNotificationService } = await import('./services/PushNotificationService.js');
      if (PushNotificationService.initialize()) {
        logger.info('Push notification service initialized (using pg-boss queue)');
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

  if (config.USE_PGBOSS_QUEUE) {
    await queueManager.stop();
  }

  logger.info('Federation Worker stopped');
}
