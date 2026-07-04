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
import { linkPreviewLimiter, pushLimiter, gifLimiter } from './middleware/rateLimit.js';

import healthRouter from './routes/health.js';
import linkPreviewRouter from './routes/linkPreview.js';
import gifsRouter from './routes/gifs.js';
import pushRouter from './routes/push.js';
import livekitRouter from './routes/livekit.js';
import voiceRouter from './routes/voice.js';
import realtimeRouter from './routes/realtime.js';
import kofiWebhookRouter from './routes/webhooks/kofi.js';

import webFingerRouter from './activitypub/WebFingerService.js';
import actorRouter from './activitypub/ActorService.js';
import nodeInfoRouter from './activitypub/NodeInfoService.js';
import inboxRouter from './activitypub/InboxHandler.js';
import outboxRouter from './activitypub/OutboxHandler.js';
import groupRouter from './activitypub/GroupService.js';

import serverDiscoveryRouter from './services/ServerDiscoveryService.js';
import instanceProbeRouter from './routes/instanceProbe.js';
import { BlockedInstancesCache } from './services/BlockedInstancesCache.js';
import { PushNotificationService } from './services/PushNotificationService.js';
import { redis } from './services/RedisService.js';

export function createApp(): Application {
  const app: Application = express();

  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({
    origin: config.CORS_ORIGIN.split(',').map(o => o.trim()),
    credentials: true,
  }));

  // ActivityPub inboxes get a tight body limit: real AP payloads are a few KB,
  // and a large limit invites storage/bandwidth amplification via redeliveries.
  // Must be mounted before the general parser - once a body is parsed the
  // later parser skips the request.
  const jsonVerify = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as any).rawBody = buf;
  };
  const jsonTypes = ['application/json', 'application/activity+json', 'application/ld+json'];
  app.use(
    ['/inbox', '/users/:username/inbox', '/servers/:serverId/inbox'],
    express.json({ limit: '1mb', type: jsonTypes, verify: jsonVerify })
  );
  app.use(express.json({ limit: '10mb', type: jsonTypes, verify: jsonVerify }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.use(compression());

  const QUIET_PATHS = new Set(['/health', '/realtime/heartbeat', '/realtime/offline']);
  app.use((req, _res, next) => {
    if (!QUIET_PATHS.has(req.path)) {
      logger.info(`${req.method} ${req.path}`);
    }
    next();
  });

  app.use('/health', healthRouter);

  // Push, link-preview, livekit, voice, realtime: mount BEFORE catch-all '/' routes.
  // Otherwise these requests hit discoveryLimiter (30/min) and wrongly get "Too many discovery requests".
  const pushWithLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const p = (req.originalUrl || req.path || '').split('?')[0];
    if (req.method === 'GET') {
      if (p.endsWith('/vapid-key') || p.endsWith('/status') || p.endsWith('/subscriptions')) return next();
    }
    if (req.method === 'POST' && p.endsWith('/test')) return next();
    return pushLimiter(req, res, next);
  };
  app.use('/push', pushWithLimiter, pushRouter);
  app.use('/api/federation/push', pushWithLimiter, pushRouter);
  app.use('/link-preview', linkPreviewLimiter, linkPreviewRouter);
  // GIF proxy (Klipy). Frontend calls /api/federation/gifs/* which nginx
  // rewrites to /gifs/*. Limiter scoped to this mount to avoid cascade bleed.
  app.use('/gifs', gifLimiter, gifsRouter);
  app.use('/api/livekit', livekitRouter);
  app.use('/voice', voiceRouter);
  app.use('/api/federation/voice', voiceRouter);
  app.use('/realtime', realtimeRouter);
  app.use('/api/federation/realtime', realtimeRouter);

  // Donation webhooks - each provider handles its own body parser internally.
  // Ko-fi posts application/x-www-form-urlencoded which the global json
  // parser ignores.
  app.use('/webhooks', kofiWebhookRouter);
  app.use('/api/webhooks', kofiWebhookRouter);

  // Rate limiting is applied per-route inside each router (not at the mount level)
  // to prevent cascade bleeding - mounting `app.use('/', limiter, routerA)` causes
  // the limiter to count requests that don't match routerA but fall through to routerB.
  app.use('/', webFingerRouter);
  app.use('/', nodeInfoRouter);
  app.use('/', outboxRouter);
  // serverDiscoveryRouter before groupRouter: /servers/discover must not collide
  // with groupRouter's /servers/:serverId (which would match serverId='discover')
  app.use('/', serverDiscoveryRouter);
  app.use('/', groupRouter);
  app.use('/', instanceProbeRouter);
  app.use('/', actorRouter);
  app.use('/', inboxRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export async function startServer(): Promise<void> {
  // Connect Redis before starting the server so cache/rate-limit/presence
  // are available from the first request.
  await redis.connect();

  const app = createApp();
  const PORT = config.PORT;

  app.listen(PORT, () => {
    logger.info(`Harmony Federation Server running on port ${PORT}`);
    logger.info(`Environment: ${config.NODE_ENV}`);
    logger.info(`Instance: ${config.INSTANCE_NAME} (${config.INSTANCE_DOMAIN})`);
    logger.info(`Redis: ${redis.ready ? 'connected' : 'unavailable (fallback mode)'}`);

    BlockedInstancesCache.initialize().catch((error) => {
      logger.error('Failed to initialize blocked instances cache:', error);
    });

    if (PushNotificationService.initialize()) {
      logger.info('Push notification service initialized (server)');
    } else {
      logger.warn('Push notifications not available (VAPID not configured)');
    }
  });
}
