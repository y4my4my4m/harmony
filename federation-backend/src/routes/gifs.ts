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

import { randomUUID } from 'crypto';
import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { getSupabaseClient } from '../config/supabase.js';
import {
  KlipyService,
  isKlipyConfigured,
  hasAdsKey,
  isValidMediaType,
  generateEmoji,
  type GifMediaType,
} from '../services/KlipyService.js';
import { logger } from '../utils/logger.js';

const router = Router();

// AI emoji generation guardrails. The Klipy daily cap (20/key) is shared across
// the whole instance, so we cap per-user too and never exceed the instance cap.
const GEN_PROMPT_MAX_LEN = 200;
const GEN_PER_USER_DAILY = 3;
const GEN_INSTANCE_DAILY = 20;
const GEN_BUCKET = 'ai-emojis';
const GEN_ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
};
const GEN_MAX_BYTES = 3 * 1024 * 1024;

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

/** Whether AI emoji generation is enabled for this instance. */
async function isGenerationEnabled(): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'gif_ai_emoji_generation_enabled')
      .maybeSingle();
    const v = data?.config_value;
    return v === true || v === 'true';
  } catch {
    return false;
  }
}

/** Count today's (UTC) generated emoji rows, optionally scoped to one user. */
async function countGeneratedToday(profileId?: string): Promise<number> {
  const supabase = getSupabaseClient();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  let q = supabase
    .from('gif_favorites')
    .select('id', { count: 'exact', head: true })
    .eq('is_generated', true)
    .gte('created_at', start.toISOString());
  if (profileId) q = q.eq('user_id', profileId);
  const { count, error } = await q;
  if (error) {
    logger.warn('Failed to count generated emoji:', error.message);
    // Fail safe: treat as at-limit so we never blow past Klipy's cap on errors.
    return Number.MAX_SAFE_INTEGER;
  }
  return count ?? 0;
}

// AI emoji generation: prompt → Klipy → host the bytes → save per-user row.
router.post('/ai-emojis/generate', requireAuth, async (req, res) => {
  const authedReq = req as AuthenticatedRequest;
  if (!isKlipyConfigured()) {
    return res.status(503).json({ error: 'AI emoji is not configured on this instance' });
  }
  if (!(await isGenerationEnabled())) {
    return res.status(403).json({ error: 'AI emoji generation is disabled on this instance' });
  }

  const rawPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
  const prompt = rawPrompt.replace(/\s+/g, ' ').trim();
  if (!prompt) {
    return res.status(400).json({ error: 'A prompt is required' });
  }
  if (prompt.length > GEN_PROMPT_MAX_LEN) {
    return res.status(400).json({ error: `Prompt must be ${GEN_PROMPT_MAX_LEN} characters or fewer` });
  }

  const profileId = authedReq.profileId;
  if (!profileId) {
    return res.status(401).json({ error: 'Profile not found' });
  }

  // Enforce per-user and instance daily caps (Klipy's 20/day is instance-wide).
  const [userCount, instanceCount] = await Promise.all([
    countGeneratedToday(profileId),
    countGeneratedToday(),
  ]);
  if (userCount >= GEN_PER_USER_DAILY) {
    return res.status(429).json({
      error: `You've reached your daily limit of ${GEN_PER_USER_DAILY} generated emoji. Try again tomorrow.`,
    });
  }
  if (instanceCount >= GEN_INSTANCE_DAILY) {
    return res.status(429).json({
      error: 'This instance reached its daily AI emoji generation limit. Try again tomorrow.',
    });
  }

  try {
    const { buffer, mimeType } = await generateEmoji(prompt, {
      userAgent: req.headers['user-agent'],
    });

    const ext = GEN_ALLOWED_MIME[mimeType.toLowerCase()];
    if (!ext) {
      return res.status(502).json({ error: 'Generated image has an unsupported format' });
    }
    if (buffer.length > GEN_MAX_BYTES) {
      return res.status(502).json({ error: 'Generated image is too large' });
    }

    const supabase = getSupabaseClient();
    const path = `${profileId}/${randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(GEN_BUCKET)
      .upload(path, buffer, { contentType: mimeType, upsert: false });
    if (uploadError) {
      logger.error('Failed to store generated emoji:', uploadError.message);
      return res.status(500).json({ error: 'Failed to save the generated emoji' });
    }

    const { data: pub } = supabase.storage.from(GEN_BUCKET).getPublicUrl(path);
    const url = pub?.publicUrl;
    if (!url) {
      return res.status(500).json({ error: 'Failed to resolve the generated emoji URL' });
    }

    // Persist as the user's generation history (doubles as the daily-cap source).
    const { error: insertError } = await supabase.from('gif_favorites').insert({
      user_id: profileId,
      gif_url: url,
      preview_url: url,
      title: prompt,
      media_type: 'ai-emoji',
      is_generated: true,
    });
    if (insertError) {
      logger.error('Failed to record generated emoji:', insertError.message);
      // The image is stored and usable even if the history row failed.
    }

    return res.json({ url, title: prompt, createdAt: new Date().toISOString() });
  } catch (err: any) {
    const message = err?.message || 'AI emoji generation failed';
    // Timeouts/failures from Klipy are upstream issues → 502.
    return res.status(502).json({ error: message });
  }
});

export default router;
