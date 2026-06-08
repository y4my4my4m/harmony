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

import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import {
  KlipyService,
  isKlipyConfigured,
  hasAdsKey,
  isValidMediaType,
  startEmojiGeneration,
  fetchGenerationStatus,
  parseGenerationPayload,
  KLIPY_AD_QUERY_KEYS,
  type GeneratedEmoji,
  type GifMediaType,
  type KlipyAdParams,
} from '../services/KlipyService.js';
import { logger } from '../utils/logger.js';
import { isKlipyAdEligibleUserAgent } from '../utils/klipyAdEligibility.js';
import { resolveClientUserAgent } from '../utils/clientUserAgent.js';

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

/** Map client `ad_*` query keys to Klipy's hyphenated ad parameter names. */
const CLIENT_AD_KEY_MAP: Record<string, string> = {
  ad_min_width: 'ad-min-width',
  ad_max_width: 'ad-max-width',
  ad_min_height: 'ad-min-height',
  ad_max_height: 'ad-max-height',
  ad_app_version: 'ad-app-version',
  ad_os: 'ad-os',
  ad_osv: 'ad-osv',
  ad_hwv: 'ad-hwv',
  ad_make: 'ad-make',
  ad_model: 'ad-model',
  ad_device_w: 'ad-device-w',
  ad_device_h: 'ad-device-h',
  ad_ppi: 'ad-ppi',
  ad_pxratio: 'ad-pxratio',
  ad_language: 'ad-language',
  ad_connection_type: 'ad-connection-type',
  ad_position: 'ad-position',
};

function clampAdInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeAdString(raw: unknown, maxLen: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLen);
  return cleaned || undefined;
}

/** Extract and sanitize Klipy ad params from the incoming GIF proxy request. */
function sanitizeAdParams(query: Record<string, unknown>): KlipyAdParams {
  const raw: Record<string, unknown> = {};
  for (const [clientKey, klipyKey] of Object.entries(CLIENT_AD_KEY_MAP)) {
    if (query[clientKey] !== undefined) raw[klipyKey] = query[clientKey];
  }

  const out: KlipyAdParams = {};
  out['ad-min-width'] = String(clampAdInt(raw['ad-min-width'], 50, 4096, 50));
  out['ad-max-width'] = String(clampAdInt(raw['ad-max-width'], 50, 4096, 384));
  out['ad-min-height'] = String(clampAdInt(raw['ad-min-height'], 50, 250, 50));
  out['ad-max-height'] = String(clampAdInt(raw['ad-max-height'], 50, 250, 250));

  // Ensure max >= min after clamping.
  if (Number(out['ad-max-width']) < Number(out['ad-min-width'])) {
    out['ad-max-width'] = out['ad-min-width'];
  }
  if (Number(out['ad-max-height']) < Number(out['ad-min-height'])) {
    out['ad-max-height'] = out['ad-min-height'];
  }

  const appVersion = sanitizeAdString(raw['ad-app-version'], 32);
  if (appVersion) out['ad-app-version'] = appVersion;

  const os = sanitizeAdString(raw['ad-os'], 16);
  if (os) out['ad-os'] = os.toLowerCase();

  const osv = sanitizeAdString(raw['ad-osv'], 16);
  if (osv) out['ad-osv'] = osv;

  const hwv = sanitizeAdString(raw['ad-hwv'], 32);
  if (hwv) out['ad-hwv'] = hwv;

  const make = sanitizeAdString(raw['ad-make'], 32);
  if (make) out['ad-make'] = make.toLowerCase();

  const model = sanitizeAdString(raw['ad-model'], 64);
  if (model) out['ad-model'] = model.toLowerCase();

  out['ad-device-w'] = String(clampAdInt(raw['ad-device-w'], 50, 4096, 0) || 0);
  out['ad-device-h'] = String(clampAdInt(raw['ad-device-h'], 50, 4096, 0) || 0);
  if (Number(out['ad-device-w']) === 0) delete out['ad-device-w'];
  if (Number(out['ad-device-h']) === 0) delete out['ad-device-h'];

  const ppi = clampAdInt(raw['ad-ppi'], 50, 600, 0);
  if (ppi > 0) out['ad-ppi'] = String(ppi);

  const pxratio = Number(raw['ad-pxratio']);
  if (Number.isFinite(pxratio) && pxratio > 0 && pxratio <= 10) {
    out['ad-pxratio'] = String(pxratio);
  }

  const language = sanitizeAdString(raw['ad-language'], 8);
  if (language && /^[a-z]{2}$/i.test(language)) out['ad-language'] = language.toUpperCase();

  const conn = clampAdInt(raw['ad-connection-type'], 0, 7, -1);
  if (conn >= 0) out['ad-connection-type'] = String(conn);

  const position = clampAdInt(raw['ad-position'], 0, 20, -1);
  if (position >= 0) out['ad-position'] = String(position);

  // Drop keys Klipy doesn't recognize (defense in depth).
  for (const key of Object.keys(out)) {
    if (!KLIPY_AD_QUERY_KEYS.has(key)) delete out[key];
  }
  return out;
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
  const tierAllowsAds = mediaType === 'gifs' ? await shouldShowAds(req.profileId) : false;
  const clientUserAgent = resolveClientUserAgent(req.headers);
  // Klipy documents mobile-only ad delivery with a browser-like User-Agent.
  const mobileEligible = isKlipyAdEligibleUserAgent(clientUserAgent);
  const withAds = tierAllowsAds && mobileEligible;

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
      userAgent: clientUserAgent,
      adParams: withAds ? sanitizeAdParams(req.query as Record<string, unknown>) : undefined,
    });
    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.json({
      ...feed,
      meta: {
        showAds: withAds,
        /** Klipy only fills on mobile browsers; desktop gets the ad-free key. */
        adMobileOnly: true,
        adPlatformEligible: mobileEligible,
        adTierEligible: tierAllowsAds,
      },
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
    userAgent: resolveClientUserAgent(req.headers),
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

/** Instance admins/owners are exempt from the per-user cap (instance cap still applies). */
async function isInstanceAdmin(profileId: string): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', profileId)
      .maybeSingle();
    return data?.is_admin === true;
  } catch {
    return false;
  }
}

interface AiEmojiQuota {
  enabled: boolean;
  isExempt: boolean;
  perUserDaily: number;
  userUsed: number;
  userRemaining: number;
  instanceDaily: number;
  instanceUsed: number;
  instanceRemaining: number;
  /** What to actually show/enforce for this user (instance cap bounds everyone). */
  remaining: number;
}

/**
 * Compute the AI emoji generation quota for a user. Admins skip the per-user
 * cap but are still bounded by the instance-wide cap (Klipy's hard daily limit).
 */
async function getQuota(profileId: string): Promise<AiEmojiQuota> {
  const [enabled, isExempt, userUsed, instanceUsed] = await Promise.all([
    isGenerationEnabled(),
    isInstanceAdmin(profileId),
    countGeneratedToday(profileId),
    countGeneratedToday(),
  ]);

  const userRemaining = Math.max(0, GEN_PER_USER_DAILY - userUsed);
  const instanceRemaining = Math.max(0, GEN_INSTANCE_DAILY - instanceUsed);
  // Admins ignore the per-user cap; everyone is bounded by the instance cap.
  const remaining = isExempt
    ? instanceRemaining
    : Math.min(userRemaining, instanceRemaining);

  return {
    enabled,
    isExempt,
    perUserDaily: GEN_PER_USER_DAILY,
    userUsed,
    userRemaining,
    instanceDaily: GEN_INSTANCE_DAILY,
    instanceUsed,
    instanceRemaining,
    remaining,
  };
}

// ---------------------------------------------------------------------------
// Async AI emoji generation (webhook-driven).
//
// Klipy's generate endpoint returns a job id instantly and pushes the finished
// emoji to a callback URL when done — so we never hold the HTTP request open
// (that was causing the proxy/client to time out while the emoji still landed
// in the DB). Flow:
//   1. POST /ai-emojis/generate → kick off Klipy with our callback URL, record
//      a pending job in memory, return 202 immediately.
//   2. Klipy → POST /ai-emojis/callback?token=… with the result. We host the
//      bytes, create the emoji, and broadcast `ai_emoji:generated` on the
//      user's realtime channel.
//   3. Fallback: if no callback arrives, a detached server-side poll finalizes
//      the same way. In-memory state is intentionally ephemeral — a backend
//      restart mid-generation just drops the job (acceptable per product).
// ---------------------------------------------------------------------------

interface PendingGeneration {
  profileId: string;
  prompt: string;
  userAgent?: string;
  createdAt: number;
  /** Set once finalization starts so the callback and fallback poll can't race. */
  finalizing: boolean;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

const pendingGenerations = new Map<string, PendingGeneration>();
// Klipy emoji generation is async; allow a generous window for the result.
const GEN_FALLBACK_POLL_MS = 6_000;
const GEN_DEADLINE_MS = 120_000;

/** Stable secret for verifying inbound Klipy callbacks (derived if unset). */
function webhookSecret(): string {
  if (config.AI_EMOJI_WEBHOOK_SECRET) return config.AI_EMOJI_WEBHOOK_SECRET;
  return createHash('sha256')
    .update(`ai-emoji-callback:${config.SUPABASE_SERVICE_ROLE_KEY}`)
    .digest('hex');
}

/** Constant-time token comparison. */
function tokenMatches(provided: unknown): boolean {
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(webhookSecret());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Public callback URL Klipy will POST the finished emoji to. */
function callbackUrl(): string {
  const domain = config.INSTANCE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${domain}/api/federation/gifs/ai-emojis/callback?token=${encodeURIComponent(webhookSecret())}`;
}

/**
 * Host the generated bytes in the emojis bucket and create a per-user custom
 * emoji row. Returns the inserted emoji, or null on validation/IO failure.
 */
async function hostAndCreateEmoji(
  profileId: string,
  prompt: string,
  image: GeneratedEmoji,
): Promise<{ id: string; name: string; url: string } | null> {
  const ext = GEN_ALLOWED_MIME[image.mimeType.toLowerCase()];
  if (!ext) {
    logger.warn('Generated emoji has unsupported format:', image.mimeType);
    return null;
  }
  if (image.buffer.length > GEN_MAX_BYTES) {
    logger.warn('Generated emoji too large:', image.buffer.length);
    return null;
  }

  const supabase = getSupabaseClient();
  const path = `ai/${profileId}/${randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(GEN_BUCKET)
    .upload(path, image.buffer, { contentType: image.mimeType, upsert: false });
  if (uploadError) {
    logger.error('Failed to store generated emoji:', uploadError.message);
    return null;
  }

  // Public URL from the externally-reachable Supabase base (getPublicUrl would
  // emit the internal docker host). PUBLIC_SUPABASE_URL defaults to SUPABASE_URL.
  const publicBase = (config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL).replace(/\/+$/, '');
  const url = `${publicBase}/storage/v1/object/public/${GEN_BUCKET}/${path}`;

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
      file_size: image.buffer.length,
      domain: null,
    })
    .select('id, name, url')
    .single();
  if (insertError || !inserted) {
    logger.error('Failed to record generated emoji:', insertError?.message);
    await supabase.storage.from(GEN_BUCKET).remove([path]).catch(() => {});
    return null;
  }
  return inserted;
}

/** Push a terminal generation event to the user's realtime channel. */
async function broadcastGeneration(
  profileId: string,
  jobId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    await supabase.rpc('broadcast_user_event', {
      p_user_id: profileId,
      p_payload: { jobId, ...payload },
    });
  } catch (err) {
    logger.warn('Failed to broadcast AI emoji event:', err);
  }
}

/**
 * Finalize a generation from a parsed status/callback result. Idempotent and
 * race-safe: the first caller (callback or fallback poll) claims the job.
 */
async function finalizeGeneration(
  jobId: string,
  status: Awaited<ReturnType<typeof parseGenerationPayload>>,
): Promise<void> {
  const pending = pendingGenerations.get(jobId);
  if (!pending || pending.finalizing) return;

  if (status.state === 'processing') return; // not ready yet
  pending.finalizing = true;

  if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);

  if (status.state === 'failed') {
    pendingGenerations.delete(jobId);
    await broadcastGeneration(pending.profileId, jobId, {
      type: 'ai_emoji:failed',
      error: 'Klipy could not generate that emoji',
    });
    return;
  }

  const emoji = await hostAndCreateEmoji(pending.profileId, pending.prompt, status.image);
  pendingGenerations.delete(jobId);
  if (!emoji) {
    await broadcastGeneration(pending.profileId, jobId, {
      type: 'ai_emoji:failed',
      error: 'Failed to save the generated emoji',
    });
    return;
  }
  await broadcastGeneration(pending.profileId, jobId, {
    type: 'ai_emoji:generated',
    emoji,
  });
}

/** Detached fallback: poll Klipy's status endpoint until ready or deadline. */
function scheduleFallbackPoll(jobId: string): void {
  const pending = pendingGenerations.get(jobId);
  if (!pending) return;

  pending.fallbackTimer = setTimeout(async () => {
    const job = pendingGenerations.get(jobId);
    if (!job || job.finalizing) return;
    try {
      const status = await fetchGenerationStatus(jobId, { userAgent: job.userAgent });
      if (status.state === 'processing') {
        if (Date.now() - job.createdAt > GEN_DEADLINE_MS) {
          pendingGenerations.delete(jobId);
          await broadcastGeneration(job.profileId, jobId, {
            type: 'ai_emoji:failed',
            error: 'AI emoji generation timed out — please try again',
          });
          return;
        }
        scheduleFallbackPoll(jobId); // keep polling
        return;
      }
      await finalizeGeneration(jobId, status);
    } catch (err) {
      logger.warn('AI emoji fallback poll failed:', err);
      scheduleFallbackPoll(jobId);
    }
  }, GEN_FALLBACK_POLL_MS);
}

// Klipy posts the finished emoji here. Token-protected (no user auth — Klipy
// can't carry a Supabase JWT). Must be reachable from the public internet.
router.post('/ai-emojis/callback', async (req, res) => {
  if (!tokenMatches(req.query.token)) {
    res.status(403).json({ error: 'Invalid callback token' });
    return;
  }
  // Acknowledge immediately; do the heavy lifting after responding so Klipy
  // isn't kept waiting (and won't retry on our processing time).
  res.status(200).json({ ok: true });

  try {
    const payload = req.body;
    const jobId =
      (typeof req.query.gid === 'string' && req.query.gid) ||
      payload?.id ||
      payload?.data?.id;
    if (!jobId || typeof jobId !== 'string') return;
    if (!pendingGenerations.has(jobId)) return; // unknown/expired job
    const status = await parseGenerationPayload(payload);
    await finalizeGeneration(jobId, status);
  } catch (err) {
    logger.warn('AI emoji callback processing failed:', err);
  }
});

// AI emoji generation quota for the current user (drives the picker's
// "N generations left today" indicator). Cheap: a couple of indexed counts.
router.get('/ai-emojis/quota', requireAuth, async (req, res) => {
  const authedReq = req as AuthenticatedRequest;
  const profileId = authedReq.profileId;
  if (!profileId) return res.status(401).json({ error: 'Profile not found' });
  if (!isKlipyConfigured()) {
    return res.json({
      enabled: false,
      isExempt: false,
      perUserDaily: GEN_PER_USER_DAILY,
      userUsed: 0,
      userRemaining: 0,
      instanceDaily: GEN_INSTANCE_DAILY,
      instanceUsed: 0,
      instanceRemaining: 0,
      remaining: 0,
    });
  }
  const quota = await getQuota(profileId);
  res.setHeader('Cache-Control', 'private, max-age=10');
  return res.json(quota);
});

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
  // Instance admins/owners are exempt from the per-user cap but the instance
  // cap still bounds everyone so we never blow past Klipy's hard limit.
  const quota = await getQuota(profileId);
  if (!quota.isExempt && quota.userRemaining <= 0) {
    return res.status(429).json({
      error: `You've reached your daily limit of ${GEN_PER_USER_DAILY} generated emoji. Try again tomorrow.`,
    });
  }
  if (quota.instanceRemaining <= 0) {
    return res.status(429).json({
      error: 'This instance reached its daily AI emoji generation limit. Try again tomorrow.',
    });
  }

  try {
    // Kick off Klipy generation with our webhook; it returns a job id at once
    // and pushes the result to the callback (we never hold the request open).
    const jobId = await startEmojiGeneration(prompt, {
      userAgent: resolveClientUserAgent(req.headers),
      callbackUrl: callbackUrl(),
    });

    pendingGenerations.set(jobId, {
      profileId,
      prompt,
      userAgent: resolveClientUserAgent(req.headers),
      createdAt: Date.now(),
      finalizing: false,
    });
    // Safety net in case the webhook never arrives (detached from this request).
    scheduleFallbackPoll(jobId);

    // Optimistic quota: this generation will consume one slot once it resolves.
    const instanceRemaining = Math.max(0, quota.instanceRemaining - 1);
    const userRemaining = quota.isExempt
      ? quota.userRemaining
      : Math.max(0, quota.userRemaining - 1);
    const remaining = quota.isExempt
      ? instanceRemaining
      : Math.min(userRemaining, instanceRemaining);

    // 202 Accepted: the emoji arrives later via the `ai_emoji:generated`
    // realtime event on the user's channel.
    return res.status(202).json({
      jobId,
      status: 'processing',
      quota: {
        ...quota,
        userUsed: quota.userUsed + (quota.isExempt ? 0 : 1),
        instanceUsed: quota.instanceUsed + 1,
        userRemaining,
        instanceRemaining,
        remaining,
      },
    });
  } catch (err: any) {
    const message = err?.message || 'AI emoji generation failed';
    // Failure to even start the job is an upstream issue → 502.
    return res.status(502).json({ error: message });
  }
});

export default router;
