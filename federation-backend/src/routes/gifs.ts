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

// ---------------------------------------------------------------------------
// Input sanitization for everything forwarded to Klipy. Nothing user-supplied
// reaches the upstream API (or our DB) without passing through these.
// ---------------------------------------------------------------------------
const QUERY_MAX_LEN = 100;

/** Trim, strip control chars, collapse whitespace, and cap a free-text query. */
function sanitizeQuery(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, QUERY_MAX_LEN);
  return cleaned || undefined;
}

/** Accept only ISO 3166-1 alpha-2 locale codes; anything else is dropped. */
function sanitizeLocale(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}

/** Clamp a page number to a sane positive range. */
function sanitizePage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}

/** Clamp per-page to Klipy's allowed window (1..50). */
function sanitizePerPage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 24;
  return Math.min(Math.max(Math.trunc(n), 1), 50);
}

// AI emoji generation guardrails. The Klipy daily cap (20/key) is shared across
// the whole instance, so we cap per-user too and never exceed the instance cap.
// Generated emoji become real custom emoji (public.emojis, scope 'user').
const GEN_PROMPT_MAX_LEN = 200;
const GEN_PER_USER_DAILY = 3;
const GEN_INSTANCE_DAILY = 20;
// Reuse the existing custom-emoji bucket so AI emoji render via the normal path.
const GEN_BUCKET = 'emojis';
const GEN_ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
};
// Match the 'emojis' bucket limit (1MB). Generated emoji are tens of KB.
const GEN_MAX_BYTES = 1024 * 1024;
const GEN_NAME_MAX_LEN = 32;

/**
 * Turn a free-text prompt into a safe emoji shortcode: lowercase, ASCII
 * alphanumerics + underscore only, collapsed and trimmed. Never trusts the
 * prompt as-is (it ends up in `:shortcode:` markup and the DB).
 */
function promptToShortcode(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, GEN_NAME_MAX_LEN)
    .replace(/_+$/g, '');
  return slug || 'ai_emoji';
}

/** Find a name not already used by this user's emoji (appends _2, _3, …). */
async function uniqueEmojiName(supabase: any, profileId: string, base: string): Promise<string> {
  const { data } = await supabase
    .from('emojis')
    .select('name')
    .eq('uploader', profileId)
    .eq('scope', 'user')
    .like('name', `${base}%`);
  const taken = new Set<string>((data || []).map((r: { name: string }) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}`.slice(0, GEN_NAME_MAX_LEN);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`.slice(0, GEN_NAME_MAX_LEN);
}

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

  const query = sanitizeQuery(req.query.q);
  const page = sanitizePage(req.query.page);
  const perPage = sanitizePerPage(req.query.per_page);
  const locale = sanitizeLocale(req.query.locale);

  // Klipy serves ad objects on the GIF feed only in our setup; other media
  // feeds are kept ad-free (cleaner UX, and it skips the per-request ads lookup).
  const withAds = mediaType === 'gifs' ? await shouldShowAds(req.profileId) : false;

  try {
    const feed = await KlipyService.fetchGifs({
      kind,
      mediaType,
      query,
      page,
      perPage,
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
  const query = sanitizeQuery(req.query.q);
  const locale = sanitizeLocale(req.query.locale);
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

/** Count today's (UTC) AI-generated emoji, optionally scoped to one uploader. */
async function countGeneratedToday(profileId?: string): Promise<number> {
  const supabase = getSupabaseClient();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  let q = supabase
    .from('emojis')
    .select('id', { count: 'exact', head: true })
    .eq('is_ai_generated', true)
    .gte('created_at', start.toISOString());
  if (profileId) q = q.eq('uploader', profileId);
  const { count, error } = await q;
  if (error) {
    logger.warn('Failed to count generated emoji:', error.message);
    // Fail safe: treat as at-limit so we never blow past Klipy's cap on errors.
    return Number.MAX_SAFE_INTEGER;
  }
  return count ?? 0;
}

// AI emoji generation: prompt → Klipy → host the bytes → create a custom emoji.
router.post('/ai-emojis/generate', requireAuth, async (req, res) => {
  const authedReq = req as AuthenticatedRequest;
  if (!isKlipyConfigured()) {
    return res.status(503).json({ error: 'AI emoji is not configured on this instance' });
  }
  if (!(await isGenerationEnabled())) {
    return res.status(403).json({ error: 'AI emoji generation is disabled on this instance' });
  }

  const rawPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
  const prompt = rawPrompt
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    // Store under the user's folder in the emojis bucket: ai/{profileId}/{uuid}.
    const path = `ai/${profileId}/${randomUUID()}.${ext}`;
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

    // Create a real, per-user custom emoji so it renders via :shortcode: and
    // shows up in the picker's AI Generated category.
    const name = await uniqueEmojiName(supabase, profileId, promptToShortcode(prompt));
    const { data: inserted, error: insertError } = await supabase
      .from('emojis')
      .insert({
        name,
        url,
        server_id: null,
        scope: 'user',
        uploader: profileId,
        is_ai_generated: true,
        file_size: buffer.length,
        domain: null,
      })
      .select('id, name, url')
      .single();
    if (insertError || !inserted) {
      logger.error('Failed to record generated emoji:', insertError?.message);
      // Clean up the orphaned upload so it doesn't linger in storage.
      await supabase.storage.from(GEN_BUCKET).remove([path]).catch(() => {});
      return res.status(500).json({ error: 'Failed to save the generated emoji' });
    }

    return res.json({
      id: inserted.id,
      name: inserted.name,
      url: inserted.url,
      createdAt: new Date().toISOString(),
    });
  } catch (err: any) {
    const message = err?.message || 'AI emoji generation failed';
    // Timeouts/failures from Klipy are upstream issues → 502.
    return res.status(502).json({ error: message });
  }
});

export default router;
