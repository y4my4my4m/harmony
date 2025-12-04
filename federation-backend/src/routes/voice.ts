import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { getSupabaseClientWithAuth } from '../config/supabase.js';
import { VoiceActivityHandler } from '../activitypub/VoiceActivityHandler.js';

const router = Router();

/**
 * POST /voice/join (proxied as /api/federation/voice/join)
 * Initiate a federated voice channel join
 * 
 * Body: { channelId, serverId }
 * Auth: Bearer token required
 */
router.post(
  '/voice/join',
  asyncHandler(async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const token = authHeader.substring(7);
    const supabase = getSupabaseClientWithAuth(token);

    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { channelId, serverId } = req.body;
    if (!channelId || !serverId) {
      res.status(400).json({ error: 'channelId and serverId are required' });
      return;
    }

    logger.info(`📞 Voice join request from user ${user.id} for channel ${channelId}`);

    try {
      await VoiceActivityHandler.federateVoiceChannelJoin(user.id, channelId, serverId);
      res.json({ success: true, message: 'Voice join request sent' });
    } catch (error: any) {
      logger.error('Failed to federate voice join:', error);
      res.status(500).json({ error: error.message || 'Failed to send voice join request' });
    }
  })
);

/**
 * POST /voice/leave (proxied as /api/federation/voice/leave)
 * Federate a voice channel leave event
 * 
 * Body: { channelId, serverId }
 * Auth: Bearer token required
 */
router.post(
  '/voice/leave',
  asyncHandler(async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const token = authHeader.substring(7);
    const supabase = getSupabaseClientWithAuth(token);

    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { channelId, serverId } = req.body;
    if (!channelId || !serverId) {
      res.status(400).json({ error: 'channelId and serverId are required' });
      return;
    }

    logger.info(`📞 Voice leave request from user ${user.id} for channel ${channelId}`);

    try {
      await VoiceActivityHandler.federateVoiceChannelLeave(user.id, channelId, serverId);
      res.json({ success: true, message: 'Voice leave request sent' });
    } catch (error: any) {
      logger.error('Failed to federate voice leave:', error);
      res.status(500).json({ error: error.message || 'Failed to send voice leave request' });
    }
  })
);

export default router;

