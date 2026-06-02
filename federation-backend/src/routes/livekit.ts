import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { livekitService, type TokenRequest, type FederatedTokenRequest } from '../services/LiveKitService.js';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { SignatureService } from '../activitypub/SignatureService.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

const router = Router();

// =============================================================================
// REQUEST VALIDATION SCHEMAS
// =============================================================================

const tokenRequestSchema = z.object({
  roomName: z.string().min(1).max(256),
  roomType: z.enum(['voice_channel', 'dm_call', 'stage']),
  canPublish: z.boolean().optional(),
  canSubscribe: z.boolean().optional(),
  canPublishData: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
});

const federatedTokenRequestSchema = z.object({
  actorId: z.string().url(),
  roomName: z.string().min(1).max(256),
  roomType: z.enum(['voice_channel', 'dm_call', 'stage']),
  canPublish: z.boolean().optional(),
  canSubscribe: z.boolean().optional(),
  canPublishData: z.boolean().optional(),
});

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Middleware to verify user authentication via Supabase JWT
 */
const requireAuth = async (req: Request, res: Response, next: Function) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  
  const token = authHeader.substring(7);
  
  try {
    const supabase = getSupabaseClientWithAuth(token);
    const { data: { user }, error } = await supabase.auth.getUser();
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    // Attach user to request
    (req as any).user = user;
    next();
  } catch (error) {
    logger.error('Auth verification failed:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

/**
 * Is the given auth user an instance admin? (auth.uid -> profiles.is_admin)
 */
const isAdmin = async (authUserId: string): Promise<boolean> => {
  try {
    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('auth_user_id', authUserId)
      .single();
    return !!profile?.is_admin;
  } catch {
    return false;
  }
};

/**
 * Check if LiveKit is configured
 */
const requireLiveKit = (req: Request, res: Response, next: Function) => {
  if (!livekitService.isConfigured()) {
    return res.status(503).json({ 
      error: 'LiveKit is not configured',
      mode: config.WEBRTC_MODE,
      fallbackAvailable: config.WEBRTC_MODE === 'hybrid' || config.WEBRTC_MODE === 'p2p',
    });
  }
  next();
};

// =============================================================================
// PUBLIC ROUTES
// =============================================================================

/**
 * GET /api/livekit/config
 * Get WebRTC configuration for clients
 * No auth required - clients need to know if SFU is available before connecting
 */
router.get('/config', (req: Request, res: Response) => {
  const clientConfig = livekitService.getClientConfig();
  
  res.json({
    ...clientConfig,
    instanceDomain: config.INSTANCE_DOMAIN,
  });
});

/**
 * GET /api/livekit/health
 * Health check for LiveKit service
 */
router.get('/health', async (req: Request, res: Response) => {
  const isConfigured = livekitService.isConfigured();
  
  if (!isConfigured) {
    return res.json({
      status: 'not_configured',
      mode: config.WEBRTC_MODE,
      message: 'LiveKit is not configured. P2P mode is available.',
    });
  }
  
  try {
    // Try to list rooms to verify connectivity
    const rooms = await livekitService.listRooms();
    
    res.json({
      status: 'healthy',
      mode: config.WEBRTC_MODE,
      activeRooms: rooms.length,
      allowFederatedVoice: config.ALLOW_FEDERATED_VOICE,
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      mode: config.WEBRTC_MODE,
      error: 'Failed to connect to LiveKit server',
    });
  }
});

// =============================================================================
// AUTHENTICATED ROUTES
// =============================================================================

/**
 * POST /api/livekit/token
 * Generate a room token for authenticated local users
 */
router.post('/token', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validation = tokenRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: 'Invalid request', 
        details: validation.error.errors 
      });
    }
    
    const user = (req as any).user;
    const { roomName, roomType, canPublish, canSubscribe, canPublishData, metadata } = validation.data;
    
    const tokenRequest: TokenRequest = {
      userId: user.id,
      roomName,
      roomType,
      canPublish,
      canSubscribe,
      canPublishData,
      metadata,
    };
    
    const { token, profileId } = await livekitService.generateToken(tokenRequest);
    const cfg = livekitService.getClientConfig();
    
    res.json({
      token,
      wsUrl: cfg.wsUrl,
      roomName,
      identity: profileId,
    });
  } catch (error) {
    logger.error('Failed to generate token:', error);
    
    if (error instanceof Error && error.message.includes('permission')) {
      return res.status(403).json({ error: error.message });
    }
    
    res.status(500).json({ error: 'Failed to generate room token' });
  }
});

/**
 * POST /api/livekit/federated-token
 * Generate a room token for federated users (from remote instances)
 */
router.post('/federated-token', requireLiveKit, async (req: Request, res: Response) => {
  try {
    // Check if federated voice is allowed
    if (!config.ALLOW_FEDERATED_VOICE) {
      return res.status(403).json({ error: 'Federated voice is not enabled on this instance' });
    }
    
    // Validate request body
    const validation = federatedTokenRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: 'Invalid request', 
        details: validation.error.errors 
      });
    }
    
    const { actorId, roomName, roomType, canPublish, canSubscribe, canPublishData } = validation.data;
    
    // Verify HTTP Signature from the requesting instance
    const signatureHeader = req.headers.signature as string | undefined;
    if (!signatureHeader) {
      return res.status(401).json({ error: 'Missing HTTP Signature - federated requests must be signed' });
    }

    const rawBody = (req as any).rawBody as Buffer | undefined;
    const verification = await SignatureService.verifySignature(
      signatureHeader,
      req.headers as Record<string, string>,
      req.method,
      req.originalUrl || req.path,
      rawBody || req.body
    );

    if (!verification.verified) {
      logger.warn(`🚫 Rejecting federated token request with invalid signature: ${verification.error}`);
      return res.status(401).json({ error: `Invalid HTTP Signature: ${verification.error}` });
    }

    // The signature is verified, but that only proves "some remote actor signed
    // this request". We must also bind the claimed `actorId` to the signer so a
    // valid signer can't mint a LiveKit token for a different actor (BUGS.md C3).
    // Strict match - no same-domain delegation for Person-style identities.
    if (!verification.actorUrl) {
      logger.warn('🚫 Rejecting federated token request: signature verification did not return an actor URL');
      return res.status(401).json({ error: 'Signature verification did not yield an actor URL' });
    }
    if (!SignatureService.verifyActorMatch(actorId, verification.actorUrl)) {
      logger.warn(
        `🚫 Rejecting federated token request: actorId ${actorId} does not match signer ${verification.actorUrl}`,
      );
      return res.status(403).json({ error: 'actorId does not match the signing key owner' });
    }
    
    const tokenRequest: FederatedTokenRequest = {
      actorId,
      roomName,
      roomType,
      canPublish,
      canSubscribe,
      canPublishData,
      signature: signatureHeader,
    };
    
    const token = await livekitService.generateFederatedToken(tokenRequest);
    const cfg = livekitService.getClientConfig();
    
    res.json({
      token,
      wsUrl: cfg.wsUrl,
      roomName,
      identity: `federated:${actorId}`,
    });
  } catch (error) {
    logger.error('Failed to generate federated token:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('blocked')) {
        return res.status(403).json({ error: 'Instance is blocked' });
      }
      if (error.message.includes('not enabled')) {
        return res.status(403).json({ error: error.message });
      }
    }
    
    res.status(500).json({ error: 'Failed to generate federated token' });
  }
});

/**
 * GET /api/livekit/rooms
 * List active rooms (admin only)
 */
router.get('/rooms', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    
    // Check if user is admin (user.id is auth UUID, use auth_user_id)
    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('auth_user_id', user.id)
      .single();
    
    if (!profile?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const rooms = await livekitService.listRooms();
    res.json({ rooms });
  } catch (error) {
    logger.error('Failed to list rooms:', error);
    res.status(500).json({ error: 'Failed to list rooms' });
  }
});

/**
 * GET /api/livekit/rooms/:roomName
 * Get room info
 */
router.get('/rooms/:roomName', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { roomName } = req.params;

    // Only members of the room (or admins) may introspect it.
    const canAccess = await livekitService.userCanAccessRoom(user.id, roomName);
    if (!canAccess && !(await isAdmin(user.id))) {
      return res.status(403).json({ error: 'You do not have access to this room' });
    }

    const room = await livekitService.getRoomInfo(roomName);
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    return res.json({ room });
  } catch (error) {
    logger.error('Failed to get room info:', error);
    return res.status(500).json({ error: 'Failed to get room info' });
  }
});

/**
 * GET /api/livekit/rooms/:roomName/participants
 * Get participants in a room
 */
router.get('/rooms/:roomName/participants', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { roomName } = req.params;

    const canAccess = await livekitService.userCanAccessRoom(user.id, roomName);
    if (!canAccess && !(await isAdmin(user.id))) {
      return res.status(403).json({ error: 'You do not have access to this room' });
    }

    const participants = await livekitService.getParticipants(roomName);
    
    return res.json({ participants });
  } catch (error) {
    logger.error('Failed to get participants:', error);
    return res.status(500).json({ error: 'Failed to get participants' });
  }
});

/**
 * DELETE /api/livekit/rooms/:roomName
 * Delete a room (admin only)
 */
router.delete('/rooms/:roomName', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    
    // Check if user is admin (user.id is auth UUID, use auth_user_id)
    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('auth_user_id', user.id)
      .single();
    
    if (!profile?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { roomName } = req.params;
    const success = await livekitService.deleteRoom(roomName);
    
    if (success) {
      res.json({ message: 'Room deleted' });
    } else {
      res.status(500).json({ error: 'Failed to delete room' });
    }
  } catch (error) {
    logger.error('Failed to delete room:', error);
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

/**
 * POST /api/livekit/rooms/:roomName/participants/:identity/remove
 * Remove a participant from a room (moderator action)
 */
router.post('/rooms/:roomName/participants/:identity/remove', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { roomName, identity } = req.params;
    
    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('auth_user_id', user.id)
      .single();
    
    if (!profile?.is_admin) {
      return res.status(403).json({ error: 'Moderation permission required' });
    }
    
    const success = await livekitService.removeParticipant(roomName, identity);
    
    if (success) {
      res.json({ message: 'Participant removed' });
    } else {
      res.status(500).json({ error: 'Failed to remove participant' });
    }
  } catch (error) {
    logger.error('Failed to remove participant:', error);
    res.status(500).json({ error: 'Failed to remove participant' });
  }
});

/**
 * POST /api/livekit/rooms/:roomName/participants/:identity/permissions
 * Update participant permissions (e.g., promote to speaker in stage)
 */
router.post('/rooms/:roomName/participants/:identity/permissions', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { roomName, identity } = req.params;
    const { canPublish, canSubscribe, canPublishData } = req.body;
    
    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('auth_user_id', user.id)
      .single();
    
    if (!profile?.is_admin) {
      return res.status(403).json({ error: 'Moderation permission required' });
    }
    
    const success = await livekitService.updateParticipantPermissions(roomName, identity, {
      canPublish,
      canSubscribe,
      canPublishData,
    });
    
    if (success) {
      res.json({ message: 'Permissions updated' });
    } else {
      res.status(500).json({ error: 'Failed to update permissions' });
    }
  } catch (error) {
    logger.error('Failed to update permissions:', error);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
});

// =============================================================================
// FEDERATED CALL ROUTES
// =============================================================================

/**
 * POST /api/livekit/federated-call/invite
 * Send a federated call invitation via ActivityPub
 */
router.post('/federated-call/invite', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { callerFederatedId, calleeFederatedId, callType, conversationId, livekitUrl, roomName } = req.body;
    
    if (!callerFederatedId || !calleeFederatedId || !callType || !livekitUrl || !roomName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Import voice activity handler
    const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js');
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    
    // Create the voice call invite activity
    const activity = VoiceActivityHandler.createVoiceCallInvite(
      callerFederatedId,
      calleeFederatedId,
      callType,
      conversationId,
      livekitUrl,
      roomName
    );
    
    // Get callee's inbox URL
    const supabase = getSupabaseClient();
    const { data: callee } = await supabase
      .from('profiles')
      .select('inbox_url')
      .eq('federated_id', calleeFederatedId)
      .single();
    
    if (!callee?.inbox_url) {
      return res.status(404).json({ error: 'Callee not found or no inbox URL' });
    }
    
    // Send the activity to callee's inbox
    await DeliveryQueue.sendToInbox(callee.inbox_url, activity, user.id);
    
    logger.info(`📞 Sent federated call invite from ${callerFederatedId} to ${calleeFederatedId}`);
    
    res.json({ 
      success: true,
      activityId: activity.id,
    });
  } catch (error) {
    logger.error('Failed to send federated call invite:', error);
    res.status(500).json({ error: 'Failed to send federated call invite' });
  }
});

/**
 * POST /api/livekit/federated-call/accept
 * Accept a federated call via ActivityPub
 */
router.post('/federated-call/accept', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { conversationId, callerFederatedId } = req.body;
    
    if (!conversationId || !callerFederatedId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Get acceptor's federated ID (user.id is auth UUID)
    const supabase = getSupabaseClient();
    const { data: acceptor } = await supabase
      .from('profiles')
      .select('federated_id')
      .eq('auth_user_id', user.id)
      .single();
    
    if (!acceptor?.federated_id) {
      return res.status(400).json({ error: 'User has no federated ID' });
    }
    
    // Get the original call invite
    const { data: call } = await supabase
      .from('federated_voice_calls')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('caller_federated_id', callerFederatedId)
      .eq('status', 'pending')
      .single();
    
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    // Update call status
    await supabase
      .from('federated_voice_calls')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('id', call.id);
    
    // Import voice activity handler
    const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js');
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    
    // Create accept activity
    const activity = VoiceActivityHandler.createVoiceCallAccept(
      acceptor.federated_id,
      callerFederatedId,
      call.ap_id
    );
    
    // Get caller's inbox
    const { data: caller } = await supabase
      .from('profiles')
      .select('inbox_url')
      .eq('federated_id', callerFederatedId)
      .single();
    
    if (caller?.inbox_url) {
      await DeliveryQueue.sendToInbox(caller.inbox_url, activity, user.id);
    }
    
    logger.info(`📞 Accepted federated call from ${callerFederatedId}`);
    
    res.json({
      success: true,
      livekitUrl: call.livekit_url,
      roomName: call.room_name,
    });
  } catch (error) {
    logger.error('Failed to accept federated call:', error);
    res.status(500).json({ error: 'Failed to accept federated call' });
  }
});

/**
 * POST /api/livekit/federated-call/reject
 * Reject a federated call via ActivityPub
 */
router.post('/federated-call/reject', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { conversationId, callerFederatedId } = req.body;
    
    if (!conversationId || !callerFederatedId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Get rejector's federated ID (user.id is auth UUID)
    const supabase = getSupabaseClient();
    const { data: rejector } = await supabase
      .from('profiles')
      .select('federated_id')
      .eq('auth_user_id', user.id)
      .single();
    
    if (!rejector?.federated_id) {
      return res.status(400).json({ error: 'User has no federated ID' });
    }
    
    // Get the original call invite
    const { data: call } = await supabase
      .from('federated_voice_calls')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('caller_federated_id', callerFederatedId)
      .eq('status', 'pending')
      .single();
    
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    // Update call status
    await supabase
      .from('federated_voice_calls')
      .update({ status: 'rejected', ended_at: new Date().toISOString() })
      .eq('id', call.id);
    
    // Import voice activity handler
    const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js');
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    
    // Create reject activity
    const activity = VoiceActivityHandler.createVoiceCallReject(
      rejector.federated_id,
      callerFederatedId,
      call.ap_id
    );
    
    // Get caller's inbox
    const { data: caller } = await supabase
      .from('profiles')
      .select('inbox_url')
      .eq('federated_id', callerFederatedId)
      .single();
    
    if (caller?.inbox_url) {
      await DeliveryQueue.sendToInbox(caller.inbox_url, activity, user.id);
    }
    
    logger.info(`📞 Rejected federated call from ${callerFederatedId}`);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to reject federated call:', error);
    res.status(500).json({ error: 'Failed to reject federated call' });
  }
});

/**
 * POST /api/livekit/federated-call/end
 * End a federated call via ActivityPub
 */
router.post('/federated-call/end', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { conversationId, otherParticipantFederatedId } = req.body;
    
    if (!conversationId) {
      return res.status(400).json({ error: 'Missing conversationId' });
    }
    
    // Get user's federated ID (user.id is auth UUID)
    const supabase = getSupabaseClient();
    const { data: ender } = await supabase
      .from('profiles')
      .select('federated_id')
      .eq('auth_user_id', user.id)
      .single();
    
    // Update call status
    await supabase
      .from('federated_voice_calls')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .in('status', ['pending', 'accepted']);
    
    // Send end activity if we have the other participant's info
    if (ender?.federated_id && otherParticipantFederatedId) {
      const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js');
      const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
      
      // Get call AP ID
      const { data: call } = await supabase
        .from('federated_voice_calls')
        .select('ap_id')
        .eq('conversation_id', conversationId)
        .single();
      
      if (call) {
        const activity = VoiceActivityHandler.createVoiceCallEnd(
          ender.federated_id,
          otherParticipantFederatedId,
          call.ap_id
        );
        
        const { data: other } = await supabase
          .from('profiles')
          .select('inbox_url')
          .eq('federated_id', otherParticipantFederatedId)
          .single();
        
        if (other?.inbox_url) {
          await DeliveryQueue.sendToInbox(other.inbox_url, activity, user.id);
        }
      }
    }
    
    logger.info(`📞 Ended federated call for conversation ${conversationId}`);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to end federated call:', error);
    res.status(500).json({ error: 'Failed to end federated call' });
  }
});

export default router;

