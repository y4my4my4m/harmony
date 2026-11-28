import { Router, Request, Response } from 'express';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { cachedInstanceName } from '../utils/instanceName.js';
import { sendSuccess } from '../utils/response.js';
import { CAPABILITIES } from '../config/capabilities.js';

const router = Router();

// public config for native clients to discover an instance's Supabase project.
// anon key is public by design (baked into every web bundle).
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, {
    name: await cachedInstanceName(getSupabaseClient()),
    domain: config.INSTANCE_DOMAIN,
    version: config.VERSION,
    supabaseUrl: config.PUBLIC_SUPABASE_URL,
    supabaseAnonKey: config.SUPABASE_ANON_KEY,
    capabilities: CAPABILITIES,
  });
}));

export default router;
