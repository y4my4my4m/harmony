import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';
import { redis } from '../services/RedisService.js';
import { bullmqManager } from '../queue/BullMQManager.js';

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
      return res.status(503).json({
        status: 'unhealthy',
        database: 'disconnected',
        error: error.message,
      });
    }

    const redisHealth = await redis.healthCheck();

    let queueStats: Record<string, any> | undefined;
    try {
      queueStats = await bullmqManager.getStats();
    } catch {
      queueStats = { status: 'unavailable' };
    }

    res.json({
      status: 'healthy',
      version: '1.0.0',
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
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Trigger maintenance tasks manually (admin use)
 * POST /health/maintenance
 * Body: { task: 'keygen-sweep' | 'cleanup-orphans' }
 */
router.post('/maintenance', async (req: Request, res: Response) => {
  const { task } = req.body;
  
  const validTasks = ['keygen-sweep', 'cleanup-orphans', 'verify-federation'];
  if (!task || !validTasks.includes(task)) {
    return res.status(400).json({
      error: 'Invalid task',
      valid_tasks: validTasks,
    });
  }

  try {
    const jobId = await bullmqManager.addJob('maintenance', {
      type: 'create',
      task,
      triggered_by: 'api',
    });

    logger.info(`Maintenance task ${task} triggered via API, job: ${jobId}`);

    res.json({
      status: 'queued',
      task,
      job_id: jobId,
      message: `Maintenance task '${task}' has been queued`,
    });
  } catch (error) {
    logger.error('Failed to queue maintenance task:', error);
    res.status(500).json({
      error: 'Failed to queue maintenance task',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get key consistency report
 * GET /health/key-consistency
 */
router.get('/key-consistency', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseClient();
    
    // Get users with inconsistent keys
    const { data: inconsistent, error: inconsistentError } = await supabase.rpc('check_key_consistency');
    
    // Get count of local users without public keys
    const { count: missingKeysCount, error: countError } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('is_local', true)
      .is('public_key', null);

    if (inconsistentError || countError) {
      return res.status(500).json({
        error: 'Failed to check key consistency',
        details: inconsistentError?.message || countError?.message,
      });
    }

    res.json({
      status: 'ok',
      users_missing_keys: missingKeysCount || 0,
      users_with_inconsistent_keys: inconsistent?.length || 0,
      inconsistent_users: inconsistent || [],
      message: (missingKeysCount === 0 && (!inconsistent || inconsistent.length === 0))
        ? '✅ All local users have consistent key pairs'
        : '⚠️ Some users need key generation or cleanup',
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check key consistency',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;

