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
import { KlipyService, isKlipyConfigured, hasAdsKey, isValidMediaType, type GifMediaType } from '../services/KlipyService.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Short-lived cache of the per-viewer ads decision.
 *
 * `should_show_gif_ads` is two indexed lookups (instance_config by PK-ish key +
 * instance_supporters by indexed user_id), run once per GIF feed request — not
 * per profile and not per item, so there is no N+1. The only realistic hot path
 * is a user paging/typing in the picker, which would re-ask the same answer
 * repeatedly. A tiny TTL cache collapses that burst into one DB round-trip while
 * staying fresh enough that a tier change is reflected within a minute.
 */
const ADS_CACHE_TTL_MS = 60_000;
const adsDecisionCache = new Map<string, { value: boolean; expires: number }>();

async function shouldShowAds(profileId: string | undefined): Promise<boolean> {
  if (!hasAdsKey()) return false; // no ad key → nobody gets ads
  if (!profileId) return true;

  const cached = adsDecisionCache.get(profileId);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;

  let value = true;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('should_show_gif_ads', { p_user_id: profileId });
    if (error) {
      logger.warn('should_show_gif_ads RPC failed, defaulting to ads on:', error.message);
    } else {
      // RPC returns boolean; default to showing ads if null/undefined.
      value = data !== false;
    }
  } catch (err) {
    logger.warn('should_show_gif_ads lookup errored, defaulting to ads on:', err);
  }

  adsDecisionCache.set(profileId, { value, expires: now + ADS_CACHE_TTL_MS });
  // Opportunistic cleanup so the map can't grow unbounded on a busy instance.
  if (adsDecisionCache.size > 5000) {
    for (const [key, entry] of adsDecisionCache) {
      if (entry.expires <= now) adsDecisionCache.delete(key);
    }
  }
  return value;
}

async function handle(
  kind: 'trending' | 'search',
  mediaType: GifMediaType,
  req: AuthenticatedRequest,
  res: any,
) {
  if (!isKlipyConfigured()) {
    return res.status(503).json({ error: 'GIF search is not configured on this instance' });
  }

  const query = typeof req.query.q === 'string' ? req.query.q : undefined;
  const page = req.query.page ? Number(req.query.page) : 1;
  const perPage = req.query.per_page ? Number(req.query.per_page) : 24;
  const locale = typeof req.query.locale === 'string' ? req.query.locale : undefined;

  // Klipy serves ad objects on the GIF feed only in our setup; other media
  // feeds are kept ad-free (cleaner UX, and it skips the per-request ads lookup).
  const withAds = mediaType === 'gifs' ? await shouldShowAds(req.profileId) : false;

  try {
    const feed = await KlipyService.fetchGifs({
      kind,
      mediaType,
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
    return res.json({
      ...feed,
      // Helps diagnose ad setup (keys are never exposed).
      meta: { showAds: withAds },
    });
  } catch (err: any) {
    return res.status(502).json({ error: err?.message || 'GIF provider error' });
  }
}

// Mounted at /gifs in server.ts.

// Search suggestions / autocomplete (literal paths declared before /:media/*).
router.get('/suggest', requireAuth, async (req, res) => {
  if (!isKlipyConfigured()) return res.json({ suggestions: [] });
  const query = typeof req.query.q === 'string' ? req.query.q : undefined;
  const locale = typeof req.query.locale === 'string' ? req.query.locale : undefined;
  const suggestions = await KlipyService.fetchSuggestions({
    query,
    locale,
    userAgent: req.headers['user-agent'],
  });
  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.json({ suggestions });
});

// Back-compat GIF routes (frontend GIF path sits at the proxy root).
router.get('/trending', requireAuth, (req, res) =>
  handle('trending', 'gifs', req as AuthenticatedRequest, res),
);

router.get('/search', requireAuth, (req, res) =>
  handle('search', 'gifs', req as AuthenticatedRequest, res),
);

// Generic per-media routes: /stickers/trending, /clips/search, /memes/trending, etc.
router.get('/:media/trending', requireAuth, (req, res) => {
  const media = req.params.media;
  if (!isValidMediaType(media)) return res.status(404).json({ error: 'Unknown media type' });
  return handle('trending', media, req as AuthenticatedRequest, res);
});

router.get('/:media/search', requireAuth, (req, res) => {
  const media = req.params.media;
  if (!isValidMediaType(media)) return res.status(404).json({ error: 'Unknown media type' });
  return handle('search', media, req as AuthenticatedRequest, res);
});

export default router;
