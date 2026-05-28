import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';
import { redis } from '../services/RedisService.js';
import { bullmqManager } from '../queue/BullMQManager.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/response.js';

const router = Router();

/**
 * Health check endpoint
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    // Check database connection
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('profiles').select('id').limit(1);

    if (error) {
      return sendError(res, error.message, 503, { status: 'unhealthy', database: 'disconnected' });
    }

    const redisHealth = await redis.healthCheck();

    let queueStats: Record<string, any> | undefined;
    try {
      queueStats = await bullmqManager.getStats();
    } catch {
      queueStats = { status: 'unavailable' };
    }

    sendSuccess(res, {
      status: 'healthy',
      version: config.VERSION,
      environment: config.NODE_ENV,
      instance: {
        name: config.INSTANCE_NAME,
        domain: config.INSTANCE_DOMAIN,
      },
      database: 'connected',
      redis: redisHealth.ok ? 'connected' : 'unavailable',
      redis_latency_ms: redisHealth.latencyMs,
      queues: queueStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    sendError(res, error instanceof Error ? error.message : 'Unknown error', 503, { status: 'unhealthy' });
  }
});

/**
 * Trigger maintenance tasks manually (admin use)
 * POST /health/maintenance
 * Body: { task: 'keygen-sweep' | 'cleanup-orphans' }
 * Requires admin authentication.
 */
router.post('/maintenance', requireAuth, async (req: Request, res: Response) => {
  // requireAuth already verified the JWT; now enforce admin-only access
  const authUser = (req as any).user;
  const supabase = getSupabaseClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('auth_user_id', authUser.id)
    .single();

  if (!profile?.is_admin) {
    return sendError(res, 'Admin access required', 403);
  }

  const { task } = req.body;
  
  const validTasks = ['keygen-sweep', 'cleanup-orphans', 'verify-federation'];
  if (!task || !validTasks.includes(task)) {
    return sendError(res, 'Invalid task', 400, { valid_tasks: validTasks });
  }

  try {
    const jobId = await bullmqManager.addJob('maintenance', {
      type: 'create',
      task,
      triggered_by: 'api',
    });

    logger.info(`Maintenance task ${task} triggered via API, job: ${jobId}`);

    sendSuccess(res, {
      status: 'queued',
      task,
      job_id: jobId,
      message: `Maintenance task '${task}' has been queued`,
    });
  } catch (error) {
    logger.error('Failed to queue maintenance task:', error);
    sendError(res, 'Failed to queue maintenance task', 500);
  }
});

/**
 * Get key consistency report
 * GET /health/key-consistency
 */
router.get('/key-consistency', requireAuth, async (req: Request, res: Response) => {
  const authUser = (req as any).user;
  const supabase = getSupabaseClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('auth_user_id', authUser.id)
    .single();

  if (!profile?.is_admin) {
    return sendError(res, 'Admin access required', 403);
  }

  try {
    // Get users with inconsistent keys
    const { data: inconsistent, error: inconsistentError } = await supabase.rpc('check_key_consistency');
    
    // Get count of local users without public keys
    const { count: missingKeysCount, error: countError } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('is_local', true)
      .is('public_key', null);

    if (inconsistentError || countError) {
      return sendError(res, 'Failed to check key consistency', 500, {
        details: inconsistentError?.message || countError?.message,
      });
    }

    sendSuccess(res, {
      status: 'ok',
      users_missing_keys: missingKeysCount || 0,
      users_with_inconsistent_keys: inconsistent?.length || 0,
      inconsistent_users: inconsistent || [],
      message: (missingKeysCount === 0 && (!inconsistent || inconsistent.length === 0))
        ? 'All local users have consistent key pairs'
        : 'Some users need key generation or cleanup',
    });
  } catch (error) {
    sendError(res, 'Failed to check key consistency', 500);
  }
});

export default router;

