import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';

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

    res.json({
      status: 'healthy',
      version: '1.0.0',
      environment: config.NODE_ENV,
      instance: {
        name: config.INSTANCE_NAME,
        domain: config.INSTANCE_DOMAIN,
      },
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;

