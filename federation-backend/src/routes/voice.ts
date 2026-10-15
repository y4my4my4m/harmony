import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { VoiceActivityHandler } from '../activitypub/VoiceActivityHandler.js';
import { livekitService } from '../services/LiveKitService.js';
import { evictFromChannel, syncVoiceMember, type SyncResult, type VoiceModerationDeps } from '../services/voiceModeration.js';
import { sendSuccess, sendError } from '../utils/response.js';

const router = Router();

/**
 * POST /join (mounted at /voice and /api/federation/voice)
 * Initiate a federated voice channel join
 * 
 * Body: { channelId, serverId }
 * Auth: Bearer token required
 */
router.post(
  '/join',
  asyncHandler(async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      sendError(res, 'Authorization required', 401);
      return;
    }

    const token = authHeader.substring(7);
    const supabase = getSupabaseClientWithAuth(token);

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      sendError(res, 'Invalid token', 401);
      return;
    }

    const { channelId, serverId } = req.body;
    if (!channelId || !serverId) {
      sendError(res, 'channelId and serverId are required');
      return;
    }

    logger.info(`Voice join request from user ${user.id} for channel ${channelId}`);

    try {
      const join = await VoiceActivityHandler.federateVoiceChannelJoin(user.id, channelId, serverId);
      if (!join) {
        sendError(res, 'Channel is not a voice channel of a federated server', 404);
        return;
      }
      sendSuccess(res, { message: 'Voice join request sent', joinId: join.joinId, serverHost: join.serverHost });
    } catch (error: any) {
      logger.error('Failed to federate voice join:', error);
      sendError(res, error.message || 'Failed to send voice join request', 500);
    }
  })
);

/**
 * POST /leave (mounted at /voice and /api/federation/voice)
 * Federate a voice channel leave event
 * 
 * Body: { channelId, serverId }
 * Auth: Bearer token required
 */
router.post(
  '/leave',
  asyncHandler(async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      sendError(res, 'Authorization required', 401);
      return;
    }

    const token = authHeader.substring(7);
    const supabase = getSupabaseClientWithAuth(token);

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      sendError(res, 'Invalid token', 401);
      return;
    }

    const { channelId, serverId } = req.body;
    if (!channelId || !serverId) {
      sendError(res, 'channelId and serverId are required');
      return;
    }

    logger.info(`Voice leave request from user ${user.id} for channel ${channelId}`);

    try {
      await VoiceActivityHandler.federateVoiceChannelLeave(user.id, channelId, serverId);
      sendSuccess(res, { message: 'Voice leave request sent' });
    } catch (error: any) {
      logger.error('Failed to federate voice leave:', error);
      sendError(res, error.message || 'Failed to send voice leave request', 500);
    }
  })
);

// VOICE MODERATION
//
// Server mute, server deafen, move and disconnect run as the authenticated
// user through the database (set_server_voice_state, move_voice_member in
// 20261017100002_voice_moderation.sql), which decides who may do what. The
// change then reaches LiveKit: the member's participants get the new
// permission, or leave the old room. Without LiveKit (P2P) the database
// change and its broadcasts are the whole effect.

/** A moved client leaves the old room itself; one still there after this is removed. */
export const MOVE_GRACE_MS = 5000;

const uuid = z.string().uuid();
const moderationSchema = z.object({
  serverId: uuid,
  userId: uuid,
  mute: z.boolean().optional(),
  deafen: z.boolean().optional(),
}).refine((b) => b.mute !== undefined || b.deafen !== undefined, { message: 'mute or deafen is required' });
const moveSchema = z.object({ serverId: uuid, userId: uuid, channelId: uuid.nullable().optional() });
const syncSchema = z.object({ serverId: uuid, userId: uuid });

type AuthedClient = ReturnType<typeof getSupabaseClientWithAuth>;

async function authenticate(req: Request, res: Response): Promise<{ supabase: AuthedClient; authUserId: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Authorization required', 401);
    return null;
  }
  const supabase = getSupabaseClientWithAuth(authHeader.substring(7));
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    sendError(res, 'Invalid token', 401);
    return null;
  }
  return { supabase, authUserId: user.id };
}

/** SQLSTATE of a refused RPC to an HTTP status. */
function rpcStatus(code: string | undefined): number {
  if (code === '42501') return 403;
  if (code === 'P0002') return 404;
  if (code === '22023' || code === '22004') return 400;
  return 500;
}

function liveKitDeps(): VoiceModerationDeps | null {
  if (!livekitService.isConfigured() || config.WEBRTC_MODE === 'p2p') return null;
  return {
    roomService: livekitService.roomServiceClient(),
    supabase: getSupabaseClient(),
    instanceDomain: config.INSTANCE_DOMAIN,
  };
}

async function syncLiveKit(serverId: string, userId: string): Promise<SyncResult | null> {
  const deps = liveKitDeps();
  if (!deps) return null;
  try {
    return await syncVoiceMember(deps, serverId, userId);
  } catch (error) {
    logger.error(`Voice sync of ${userId} in ${serverId} failed:`, error);
    return null;
  }
}

/**
 * POST /moderation (mounted at /voice and /api/federation/voice)
 * Body: { serverId, userId, mute?, deafen? }; an absent flag is left as it is.
 */
router.post(
  '/moderation',
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const body = moderationSchema.safeParse(req.body);
    if (!body.success) {
      sendError(res, 'serverId, userId and mute or deafen are required');
      return;
    }
    const { serverId, userId, mute, deafen } = body.data;
    const { data, error } = await auth.supabase.rpc('set_server_voice_state', {
      p_server_id: serverId,
      p_user_id: userId,
      p_mute: mute ?? null,
      p_deafen: deafen ?? null,
    });
    if (error) {
      sendError(res, error.message, rpcStatus(error.code));
      return;
    }
    const livekit = await syncLiveKit(serverId, userId);
    sendSuccess(res, { state: data, livekit });
  })
);

/**
 * POST /move (mounted at /voice and /api/federation/voice)
 * Body: { serverId, userId, channelId }; channelId null disconnects.
 */
router.post(
  '/move',
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const body = moveSchema.safeParse(req.body);
    if (!body.success) {
      sendError(res, 'serverId and userId are required');
      return;
    }
    const { serverId, userId } = body.data;
    const channelId = body.data.channelId ?? null;
    const { data, error } = await auth.supabase.rpc('move_voice_member', {
      p_server_id: serverId,
      p_user_id: userId,
      p_channel_id: channelId,
    });
    if (error) {
      sendError(res, error.message, rpcStatus(error.code));
      return;
    }

    const fromChannel: string | undefined = (data as any)?.from_channel_id;
    const deps = liveKitDeps();
    if (deps && fromChannel) {
      const evict = () => evictFromChannel(deps, userId, fromChannel).catch((e) => {
        logger.error(`Voice eviction of ${userId} from ${fromChannel} failed:`, e);
        return 0;
      });
      if (channelId) {
        setTimeout(() => void evict(), MOVE_GRACE_MS).unref?.();
      } else {
        await evict();
      }
    }
    sendSuccess(res, { move: data });
  })
);

/**
 * POST /sync (mounted at /voice and /api/federation/voice)
 * Body: { serverId, userId }. Brings the member's LiveKit participants in the
 * server's rooms in line with the database: after a kick, ban or timeout, or
 * a moderation change made without /moderation. Open to the server's owner
 * and accepted members; it applies the database's decision, nothing more.
 */
router.post(
  '/sync',
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const body = syncSchema.safeParse(req.body);
    if (!body.success) {
      sendError(res, 'serverId and userId are required');
      return;
    }
    const { serverId, userId } = body.data;
    const service = getSupabaseClient();
    const { data: caller } = await service
      .from('profiles')
      .select('id')
      .eq('auth_user_id', auth.authUserId)
      .maybeSingle();
    if (!caller?.id) {
      sendError(res, 'Profile not found', 403);
      return;
    }
    const [{ data: server }, { data: membership }] = await Promise.all([
      service.from('servers').select('owner').eq('id', serverId).maybeSingle(),
      service.from('user_servers').select('status').eq('server_id', serverId).eq('user_id', caller.id).maybeSingle(),
    ]);
    if (server?.owner !== caller.id && membership?.status !== 'accepted') {
      sendError(res, 'Not a member of this server', 403);
      return;
    }
    sendSuccess(res, { livekit: await syncLiveKit(serverId, userId) });
  })
);

export default router;

