import { Router, Request, Response } from 'express';
import config from '../config/index.js';
import { sendSuccess } from '../utils/response.js';

const router = Router();

/**
 * Public instance configuration for native clients.
 *
 * A native (Tauri) client is one universal binary — it discovers which
 * Supabase project backs an instance by fetching this endpoint from the
 * instance domain the user typed in. The anon key is public by design
 * (it's baked into every web client bundle).
 */
router.get('/', (_req: Request, res: Response) => {
  sendSuccess(res, {
    name: config.INSTANCE_NAME,
    domain: config.INSTANCE_DOMAIN,
    version: config.VERSION,
    supabaseUrl: config.PUBLIC_SUPABASE_URL,
    supabaseAnonKey: config.SUPABASE_ANON_KEY,
  });
});

export default router;
