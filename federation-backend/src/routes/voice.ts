import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { getSupabaseClientWithAuth } from '../config/supabase.js';
import { VoiceActivityHandler } from '../activitypub/VoiceActivityHandler.js';
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

    logger.info(`📞 Voice join request from user ${user.id} for channel ${channelId}`);

    try {
      await VoiceActivityHandler.federateVoiceChannelJoin(user.id, channelId, serverId);
      sendSuccess(res, { message: 'Voice join request sent' });
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

    logger.info(`📞 Voice leave request from user ${user.id} for channel ${channelId}`);

    try {
      await VoiceActivityHandler.federateVoiceChannelLeave(user.id, channelId, serverId);
      sendSuccess(res, { message: 'Voice leave request sent' });
    } catch (error: any) {
      logger.error('Failed to federate voice leave:', error);
      sendError(res, error.message || 'Failed to send voice leave request', 500);
    }
  })
);

export default router;

