import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import config from './config/index.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';

// Import routes
import healthRouter from './routes/health.js';
import linkPreviewRouter from './routes/linkPreview.js';
import pushRouter from './routes/push.js';
import livekitRouter from './routes/livekit.js';

// Import ActivityPub routes (FEDERATION ONLY!)
import webFingerRouter from './activitypub/WebFingerService.js';
import actorRouter from './activitypub/ActorService.js';
import nodeInfoRouter from './activitypub/NodeInfoService.js';
import inboxRouter from './activitypub/InboxHandler.js';
import outboxRouter from './activitypub/OutboxHandler.js';
import groupRouter from './activitypub/GroupService.js';

// Import Federation API routes
import serverDiscoveryRouter from './services/ServerDiscoveryService.js';

// Import database listener (legacy - will be replaced by QueueManager)
import { startDatabaseListener } from './listeners/DatabaseListener.js';
import { startPushNotificationListener } from './listeners/PushNotificationHandler.js';
import { DeliveryQueue } from './activitypub/DeliveryQueue.js';

// Import pg-boss queue manager (new professional approach)
import { queueManager } from './queue/QueueManager.js';

// Import blocked instances cache
import { BlockedInstancesCache } from './services/BlockedInstancesCache.js';

// Feature flag: Set to true to use pg-boss instead of Supabase Realtime
const USE_PGBOSS_QUEUE = process.env.USE_PGBOSS_QUEUE === 'true';

const app: Application = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: config.CORS_ORIGIN.split(',').map(o => o.trim()),
  credentials: true,
}));

// Body parsing middleware
// ActivityPub uses application/activity+json and application/ld+json
app.use(express.json({ 
  limit: '10mb',
  type: ['application/json', 'application/activity+json', 'application/ld+json']
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression
app.use(compression());

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Health check (no rate limit)
app.use('/health', healthRouter);

// ActivityPub routes (FEDERATION ONLY - no rate limit)
app.use('/', webFingerRouter);
app.use('/', nodeInfoRouter);
app.use('/', actorRouter);
app.use('/', inboxRouter);
app.use('/', outboxRouter);
app.use('/', groupRouter); // Servers as Groups

// Federation API routes (for frontend to call)
app.use('/', serverDiscoveryRouter);

app.use('/link-preview', linkPreviewRouter);

// Push notification routes (with rate limiting)
app.use('/push', apiLimiter, pushRouter);

// LiveKit WebRTC routes
app.use('/api/livekit', livekitRouter);

// 404 handler
app.use(notFound);

// Error handler (must be last)
app.use(errorHandler);

// Start server
const PORT = config.PORT;
app.listen(PORT, () => {
  logger.info(`🚀 Harmony Federation Backend running on port ${PORT}`);
  logger.info(`📝 Environment: ${config.NODE_ENV}`);
  logger.info(`🌐 Instance: ${config.INSTANCE_NAME} (${config.INSTANCE_DOMAIN})`);
  logger.info(`⚠️  Federation ONLY - App uses Supabase directly`);
  
  // Initialize blocked instances cache (O(1) lookups for inbox filtering)
  BlockedInstancesCache.initialize().catch((error) => {
    logger.error('Failed to initialize blocked instances cache:', error);
  });
  
  // Start federation event processing
  if (USE_PGBOSS_QUEUE) {
    // NEW: pg-boss queue-based federation (professional approach)
    logger.info('🚀 Starting pg-boss QueueManager for federation...');
    queueManager.start().catch((error) => {
      logger.error('❌ Failed to start QueueManager:', error);
      logger.info('⚠️  Falling back to DatabaseListener...');
      startDatabaseListener().catch((err) => {
        logger.error('Failed to start database listener:', err);
      });
    });
  } else {
    // LEGACY: Supabase Realtime-based federation
    logger.info('📡 Using legacy DatabaseListener (set USE_PGBOSS_QUEUE=true to switch)');
  startDatabaseListener().catch((error) => {
    logger.error('Failed to start database listener:', error);
  });
  }
  
  // Initialize push notification service
  if (USE_PGBOSS_QUEUE) {
    // pg-boss handles push notifications via 'send-push-notification' queue
    import('./services/PushNotificationService.js').then(({ PushNotificationService }) => {
      if (PushNotificationService.initialize()) {
        logger.info('✅ Push notification service initialized (using pg-boss queue)');
      } else {
        logger.warn('⚠️ Push notifications not available (VAPID not configured)');
      }
    }).catch((error) => {
      logger.error('Failed to initialize push notification service:', error);
    });
  } else {
    // Legacy: Use Realtime listener
  startPushNotificationListener().catch((error) => {
    logger.error('Failed to start push notification listener:', error);
  });
  }
  
  // Process delivery queue for retries every 30 seconds
  // Note: New deliveries are attempted immediately, this is only for retrying failed deliveries
  setInterval(async () => {
    try {
      await DeliveryQueue.processQueue();
    } catch (error) {
      logger.error('Failed to process delivery queue:', error);
    }
  }, 30000); // 30 seconds
  
  logger.info('📬 Delivery queue retry processor started (30s interval)');
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully...`);
  
  if (USE_PGBOSS_QUEUE) {
    try {
      await queueManager.stop();
    } catch (error) {
      logger.error('Error stopping QueueManager:', error);
    }
  }
  
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;

