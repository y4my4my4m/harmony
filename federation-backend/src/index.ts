/**
 * Harmony Federation Backend - Entry Point
 *
 * Supports three modes via FEDERATION_MODE env var:
 *   'server'  - HTTP server only (ActivityPub inbox, WebFinger, health, etc.)
 *   'worker'  - Queue workers only (BullMQ, LISTEN/NOTIFY, delivery retries)
 *   'unified' - Both in one process (default, backward compatible)
 *
 * In production, run server and worker as separate processes for isolation:
 *   FEDERATION_MODE=server node dist/index.js
 *   FEDERATION_MODE=worker node dist/index.js
 */

import config from './config/index.js';
import { logger } from './utils/logger.js';
import { startServer } from './server.js';
import { startWorker, stopWorker } from './worker.js';
import { redis } from './services/RedisService.js';
import { bullmqManager } from './queue/BullMQManager.js';

const mode = config.FEDERATION_MODE;

async function main(): Promise<void> {
  logger.info(`Harmony Federation Backend starting in "${mode}" mode`);

  if (mode === 'server' || mode === 'unified') {
    await startServer();
  }

  if (mode === 'worker' || mode === 'unified') {
    await startWorker();
  }
}

const shutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully...`);

  if (mode === 'worker' || mode === 'unified') {
    try {
      await stopWorker();
    } catch (error) {
      logger.error('Error stopping worker:', error);
    }
  }

  await bullmqManager.stop();
  await redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((error) => {
  logger.error('Fatal startup error:', error);
  process.exit(1);
});
