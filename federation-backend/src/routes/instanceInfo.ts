import { Router, Request, Response } from 'express';
import config from '../config/index.js';
import { sendSuccess } from '../utils/response.js';

const router = Router();

// public config for native clients to discover an instance's Supabase project.
// anon key is public by design (baked into every web bundle).
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
