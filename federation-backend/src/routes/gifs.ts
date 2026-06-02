/**
 * GIF proxy routes (Klipy)
 *
 * Authenticated proxy in front of Klipy. The browser never sees a Klipy key.
 * The ads decision is made here, server-side, from the viewer's supporter tier
 * and the instance toggle, so it cannot be bypassed by the client:
 *
 *   withAds = (an ad-enabled key exists) AND should_show_gif_ads(viewer)
 *
 * When withAds is false the no-ads key is used (and any stray ad objects are
 * stripped in KlipyService), so supporters get a clean, ad-free experience.
 */

import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { getSupabaseClient } from '../config/supabase.js';
import { KlipyService, isKlipyConfigured, hasAdsKey } from '../services/KlipyService.js';
import { logger } from '../utils/logger.js';

const router = Router();

/** Resolve whether this viewer should be shown ads, per instance + tier policy. */
async function shouldShowAds(profileId: string | undefined): Promise<boolean> {
  if (!hasAdsKey()) return false; // no ad key → nobody gets ads
  if (!profileId) return true;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('should_show_gif_ads', { p_user_id: profileId });
    if (error) {
      logger.warn('should_show_gif_ads RPC failed, defaulting to ads on:', error.message);
      return true;
    }
    // RPC returns boolean; default to showing ads if null/undefined.
    return data !== false;
  } catch (err) {
    logger.warn('should_show_gif_ads lookup errored, defaulting to ads on:', err);
    return true;
  }
}

async function handle(kind: 'trending' | 'search', req: AuthenticatedRequest, res: any) {
  if (!isKlipyConfigured()) {
    return res.status(503).json({ error: 'GIF search is not configured on this instance' });
  }

  const query = typeof req.query.q === 'string' ? req.query.q : undefined;
  const page = req.query.page ? Number(req.query.page) : 1;
  const perPage = req.query.per_page ? Number(req.query.per_page) : 24;
  const locale = typeof req.query.locale === 'string' ? req.query.locale : undefined;

  const withAds = await shouldShowAds(req.profileId);

  try {
    const feed = await KlipyService.fetchGifs({
      kind,
      query,
      page: Number.isFinite(page) ? page : 1,
      perPage: Number.isFinite(perPage) ? perPage : 24,
      locale,
      // Profile id is a stable, non-PII UUID — ideal as Klipy's customer_id.
      customerId: req.profileId || req.user.id,
      withAds,
      userAgent: req.headers['user-agent'],
    });
    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.json(feed);
  } catch (err: any) {
    return res.status(502).json({ error: err?.message || 'GIF provider error' });
  }
}

// Mounted at /gifs in server.ts
router.get('/trending', requireAuth, (req, res) =>
  handle('trending', req as AuthenticatedRequest, res),
);

router.get('/search', requireAuth, (req, res) =>
  handle('search', req as AuthenticatedRequest, res),
);

export default router;
