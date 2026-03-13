/**
 * Federation HTTP Server
 *
 * Express-only entry point that handles incoming ActivityPub requests,
 * WebFinger, NodeInfo, health checks, and API routes.
 * No queue processing -- run worker.ts separately for that.
 *
 * Usage:
 *   FEDERATION_MODE=server npm start
 *   npm run start:server
 */

import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import config from './config/index.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { inboxLimiter, linkPreviewLimiter, discoveryLimiter, pushLimiter } from './middleware/rateLimit.js';

import healthRouter from './routes/health.js';
import linkPreviewRouter from './routes/linkPreview.js';
import pushRouter from './routes/push.js';
import livekitRouter from './routes/livekit.js';
import voiceRouter from './routes/voice.js';

import webFingerRouter from './activitypub/WebFingerService.js';
import actorRouter from './activitypub/ActorService.js';
import nodeInfoRouter from './activitypub/NodeInfoService.js';
import inboxRouter from './activitypub/InboxHandler.js';
import outboxRouter from './activitypub/OutboxHandler.js';
import groupRouter from './activitypub/GroupService.js';

import serverDiscoveryRouter from './services/ServerDiscoveryService.js';
import { BlockedInstancesCache } from './services/BlockedInstancesCache.js';

export function createApp(): Application {
  const app: Application = express();

  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({
    origin: config.CORS_ORIGIN.split(',').map(o => o.trim()),
    credentials: true,
  }));

  app.use(express.json({
    limit: '10mb',
    type: ['application/json', 'application/activity+json', 'application/ld+json'],
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.use(compression());

  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`);
    next();
  });

  app.use('/health', healthRouter);

  app.use('/', webFingerRouter);
  app.use('/', nodeInfoRouter);
  app.use('/', discoveryLimiter, actorRouter);
  app.use('/', inboxLimiter, inboxRouter);
  app.use('/', outboxRouter);
  app.use('/', inboxLimiter, groupRouter);

  // Push must be before serverDiscoveryRouter — some proxies preserve /api/federation,
  // so /api/federation/push/test would otherwise hit discoveryLimiter (wrong 429 message)
  // Skip rate limit for GET vapid-key (public, cheap) so users can always fetch it for subscribe
  const pushWithLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === 'GET' && req.path.endsWith('/vapid-key')) {
      return next();
    }
    return pushLimiter(req, res, next);
  };
  app.use('/push', pushWithLimiter, pushRouter);
  app.use('/api/federation/push', pushWithLimiter, pushRouter);
  app.use('/', discoveryLimiter, serverDiscoveryRouter);
  app.use('/link-preview', linkPreviewLimiter, linkPreviewRouter);
  app.use('/api/livekit', livekitRouter);
  app.use('/', voiceRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export async function startServer(): Promise<void> {
  const app = createApp();
  const PORT = config.PORT;

  app.listen(PORT, () => {
    logger.info(`Harmony Federation Server running on port ${PORT}`);
    logger.info(`Environment: ${config.NODE_ENV}`);
    logger.info(`Instance: ${config.INSTANCE_NAME} (${config.INSTANCE_DOMAIN})`);

    BlockedInstancesCache.initialize().catch((error) => {
      logger.error('Failed to initialize blocked instances cache:', error);
    });
  });
}
