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

// Import ActivityPub routes (FEDERATION ONLY!)
import webFingerRouter from './activitypub/WebFingerService.js';
import actorRouter from './activitypub/ActorService.js';
import nodeInfoRouter from './activitypub/NodeInfoService.js';
import inboxRouter from './activitypub/InboxHandler.js';
import outboxRouter from './activitypub/OutboxHandler.js';
import groupRouter from './activitypub/GroupService.js';

// Import database listener
import { startDatabaseListener } from './listeners/DatabaseListener.js';
import { DeliveryQueue } from './activitypub/DeliveryQueue.js';

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

app.use('/link-preview', linkPreviewRouter);

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
  
  // Start database listener for federation events
  startDatabaseListener().catch((error) => {
    logger.error('Failed to start database listener:', error);
  });
  
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
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

export default app;

