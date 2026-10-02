import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { presenceService, type PresenceStatus } from '../services/PresenceService.js';
import { typingService } from '../services/TypingService.js';
import { profileCacheService } from '../services/ProfileCacheService.js';
import { redis } from '../services/RedisService.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { sendSuccess, sendError } from '../utils/response.js';

const router = Router();

const VALID_STATUSES: PresenceStatus[] = ['online', 'idle', 'dnd', 'offline', 'invisible'];
const VALID_CONTEXT_TYPES = ['channel', 'conversation', 'thread'] as const;
const RELATED_BATCH = 1000;

/**
 * Profiles among `ids` whose presence `viewer` may read (presence_related_ids:
 * a server or conversation in common, or a follow). Empty on a failed lookup.
 */
async function relatedProfiles(viewer: string, ids: string[]): Promise<Set<string>> {
  const related = new Set<string>();
  const unique = [...new Set(ids.filter((id) => typeof id === 'string'))];
  for (let i = 0; i < unique.length; i += RELATED_BATCH) {
    const { data, error } = await getSupabaseClient()
      .rpc('presence_related_ids', { p_viewer: viewer, p_ids: unique.slice(i, i + RELATED_BATCH) });
    if (error) {
      logger.warn(`presence_related_ids failed: ${error.message}`);
      return new Set();
    }
    for (const id of (data ?? []) as string[]) related.add(id);
  }
  return related;
}

/** The typing context is one `viewer` may read, by the Realtime topic rules (topic_readable_by). */
async function canUseTypingContext(viewer: string, contextType: string, contextId: unknown): Promise<boolean> {
  if (typeof contextId !== 'string' || contextId.length > 64) return false;
  const { data, error } = await getSupabaseClient()
    .rpc('topic_readable_by', { p_profile_id: viewer, p_topic: `typing:${contextType}:${contextId}` });
  if (error) {
    logger.warn(`topic_readable_by failed: ${error.message}`);
    return false;
  }
  return data === true;
}

// ─── Presence ────────────────────────────────────────────────────────────────

/**
 * POST /heartbeat
 * Body: { status?: PresenceStatus, customStatus?: string }
 *
 * Client calls every 60s to maintain online presence.
 */
router.post('/heartbeat', requireAuth, async (req: Request, res: Response) => {
  const { profileId } = req as AuthenticatedRequest;
  if (!profileId) return sendError(res, 'No profile found');

  const status = VALID_STATUSES.includes(req.body.status) ? req.body.status : 'online';
  const customStatus = typeof req.body.customStatus === 'string'
    ? req.body.customStatus.slice(0, 128)
    : undefined;

  await presenceService.heartbeat(profileId, status, customStatus);
  return sendSuccess(res);
});

/**
 * POST /offline
 * Explicitly go offline (tab close, logout).
 */
router.post('/offline', requireAuth, async (req: Request, res: Response) => {
  const { profileId } = req as AuthenticatedRequest;
  if (!profileId) return sendError(res, 'No profile found');

  await presenceService.setOffline(profileId);
  return sendSuccess(res);
});

/**
 * POST /presence/bulk
 * Body: { profileIds: string[] }
 *
 * Returns presence for a batch of users (max 200).
 */
router.post('/presence/bulk', requireAuth, async (req: Request, res: Response) => {
  const { profileId } = req as AuthenticatedRequest;
  if (!profileId) return sendError(res, 'No profile found');
  const { profileIds } = req.body;
  if (!Array.isArray(profileIds)) {
    return sendError(res, 'profileIds must be an array');
  }

  const related = await relatedProfiles(profileId, profileIds.slice(0, 200));
  const statuses = await presenceService.getBulkStatus([...related]);

  const result: Record<string, { status: string; customStatus?: string; lastSeen: number }> = {};
  for (const [id, data] of statuses) {
    if (data.status !== 'invisible') {
      result[id] = data;
    }
  }

  return sendSuccess(res, { presence: result });
});

/**
 * GET /presence/online
 * Online profile IDs among the profiles the caller may see.
 */
router.get('/presence/online', requireAuth, async (req: Request, res: Response) => {
  const { profileId } = req as AuthenticatedRequest;
  if (!profileId) return sendError(res, 'No profile found');
  const ids = await presenceService.getOnlineIds();
  return sendSuccess(res, { online: [...await relatedProfiles(profileId, ids)] });
});

// ─── Typing ──────────────────────────────────────────────────────────────────

/**
 * POST /typing/start
 * Body: { contextType, contextId, username }
 */
router.post('/typing/start', requireAuth, async (req: Request, res: Response) => {
  const { profileId } = req as AuthenticatedRequest;
  if (!profileId) return sendError(res, 'No profile found');

  const { contextType, contextId, username } = req.body;

  if (!VALID_CONTEXT_TYPES.includes(contextType) || !contextId || !username) {
    return sendError(res, 'Missing contextType, contextId, or username');
  }
  if (!(await canUseTypingContext(profileId, contextType, contextId))) {
    return sendError(res, 'Not a member of this context', 403);
  }

  await typingService.startTyping(contextType, contextId, profileId, username);
  return sendSuccess(res);
});

/**
 * POST /typing/stop
 * Body: { contextType, contextId }
 */
router.post('/typing/stop', requireAuth, async (req: Request, res: Response) => {
  const { profileId } = req as AuthenticatedRequest;
  if (!profileId) return sendError(res, 'No profile found');

  const { contextType, contextId } = req.body;

  if (!VALID_CONTEXT_TYPES.includes(contextType) || !contextId) {
    return sendError(res, 'Missing contextType or contextId');
  }
  if (!(await canUseTypingContext(profileId, contextType, contextId))) {
    return sendError(res, 'Not a member of this context', 403);
  }

  await typingService.stopTyping(contextType, contextId, profileId);
  return sendSuccess(res);
});

/**
 * POST /typing/active
 * Body: { contextType, contextId }
 *
 * Returns currently typing users in a context.
 */
router.post('/typing/active', requireAuth, async (req: Request, res: Response) => {
  const { profileId } = req as AuthenticatedRequest;
  if (!profileId) return sendError(res, 'No profile found');
  const { contextType, contextId } = req.body;

  if (!VALID_CONTEXT_TYPES.includes(contextType) || !contextId) {
    return sendError(res, 'Missing contextType or contextId');
  }
  if (!(await canUseTypingContext(profileId, contextType, contextId))) {
    return sendError(res, 'Not a member of this context', 403);
  }

  const users = await typingService.getTypingUsers(contextType, contextId);
  return sendSuccess(res, { typing: users });
});

// ─── Profiles (cached) ───────────────────────────────────────────────────────

/**
 * POST /profiles/bulk
 * Body: { profileIds: string[] }
 *
 * Returns cached user profiles (max 100).
 */
router.post('/profiles/bulk', requireAuth, async (req: Request, res: Response) => {
  const { profileIds } = req.body;
  if (!Array.isArray(profileIds)) {
    return sendError(res, 'profileIds must be an array');
  }

  const capped = profileIds.slice(0, 100);
  const profiles = await profileCacheService.getByIds(capped);

  const result: Record<string, any> = {};
  for (const [id, p] of profiles) {
    result[id] = {
      id: p.id,
      username: p.username,
      display_name: p.display_name,
      avatar_url: p.avatar_url,
      domain: p.domain,
      is_local: p.is_local,
      bio: p.bio,
      color: p.color,
      status: p.status,
      banner_url: p.banner_url,
    };
  }

  return sendSuccess(res, { profiles: result });
});

// ─── Health ──────────────────────────────────────────────────────────────────

router.get('/redis-health', requireAuth, async (_req: Request, res: Response) => {
  const health = await redis.healthCheck();
  return res.status(health.ok ? 200 : 503).json(health);
});

export default router;
