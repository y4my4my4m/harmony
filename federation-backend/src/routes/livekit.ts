import express, { Router, Request, Response } from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import { z } from 'zod';
import { livekitService, TokenRefused, type TokenRequest, type FederatedTokenRequest } from '../services/LiveKitService.js';
import { channelIdOfRoom, eitherBlocks, isConversationParticipant, isFederatedDmRoomFor } from '../services/voiceAccess.js';
import { metadataProfileId } from '../services/voiceParticipantReconciler.js';
import { reconcileVoiceNow } from '../services/voiceParticipantSweep.js';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { SignatureService } from '../activitypub/SignatureService.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

const router = Router();

// REQUEST VALIDATION SCHEMAS

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

// MIDDLEWARE

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
    
    (req as any).user = user;
    return next();
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
const requireLiveKit = (_req: Request, res: Response, next: Function) => {
  if (!livekitService.isConfigured()) {
    return res.status(503).json({
      error: 'LiveKit is not configured',
      mode: config.WEBRTC_MODE,
      fallbackAvailable: config.WEBRTC_MODE === 'hybrid' || config.WEBRTC_MODE === 'p2p',
    });
  }
  return next();
};

// PUBLIC ROUTES

/**
 * GET /api/livekit/config
 * Get WebRTC configuration for clients
 * No auth required - clients need to know if SFU is available before connecting
 */
router.get('/config', (_req: Request, res: Response) => {
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
router.get('/health', async (_req: Request, res: Response) => {
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

    return res.json({
      status: 'healthy',
      mode: config.WEBRTC_MODE,
      activeRooms: rooms.length,
      allowFederatedVoice: config.ALLOW_FEDERATED_VOICE,
    });
  } catch (error) {
    logger.error('LiveKit health check failed:', error);
    return res.status(503).json({
      status: 'unhealthy',
      mode: config.WEBRTC_MODE,
      error: 'Failed to connect to LiveKit server',
    });
  }
});

/**
 * POST /api/livekit/webhook
 * LiveKit server webhook (livekit.yaml `webhook.urls`, signed with `webhook.api_key`,
 * which must be LIVEKIT_API_KEY). participant_left, participant_connection_aborted and
 * room_finished on a channel room reconcile that channel's voice_channel_participants.
 * Content-Type is application/webhook+json; the signature covers the raw body.
 */
const WEBHOOK_EVENTS = new Set(['participant_left', 'participant_connection_aborted', 'room_finished']);

router.post(
  '/webhook',
  requireLiveKit,
  express.text({ type: 'application/webhook+json', limit: '256kb' }),
  async (req: Request, res: Response) => {
    const raw = typeof req.body === 'string' ? req.body : (req as any).rawBody?.toString('utf8');
    if (typeof raw !== 'string' || raw.length === 0) {
      return res.status(400).json({ error: 'Empty body' });
    }

    const cfg = livekitService.getConfig();
    let event;
    try {
      event = await new WebhookReceiver(cfg.apiKey, cfg.apiSecret).receive(raw, req.get('Authorization'));
    } catch (error) {
      logger.warn('LiveKit webhook refused:', error instanceof Error ? error.message : error);
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const channelId = channelIdOfRoom(event.room?.name);
    if (!WEBHOOK_EVENTS.has(event.event) || !channelId) {
      return res.status(200).json({ ok: true });
    }

    const createdAt = Number(event.createdAt ?? 0);
    const departure = event.participant && event.event !== 'room_finished'
      ? {
          identity: event.participant.identity,
          profileId: metadataProfileId(event.participant.metadata),
          at: createdAt > 0 ? new Date(createdAt * 1000) : new Date(),
        }
      : undefined;

    try {
      const result = await reconcileVoiceNow({ channelIds: [channelId], departure });
      if (!result.ok) logger.warn(`LiveKit webhook ${event.event} on ${event.room?.name}: ${result.reason}`);
    } catch (error) {
      logger.error(`LiveKit webhook ${event.event} on ${event.room?.name} failed:`, error);
    }
    return res.status(200).json({ ok: true });
  },
);

// AUTHENTICATED ROUTES

/**
 * POST /api/livekit/token
 * Generate a room token for authenticated local users
 */
router.post('/token', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
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
    
    return res.json({
      token,
      wsUrl: cfg.wsUrl,
      roomName,
      identity: profileId,
    });
  } catch (error) {
    if (error instanceof TokenRefused) {
      logger.info(`Token for ${req.body?.roomName} refused: ${error.message}`);
      return res.status(403).json({ error: error.answer });
    }
    logger.error('Failed to generate token:', error);
    return res.status(500).json({ error: 'Failed to generate room token' });
  }
});

/**
 * POST /api/livekit/federated-token
 * Generate a room token for federated users (from remote instances)
 */
router.post('/federated-token', requireLiveKit, async (req: Request, res: Response) => {
  try {
    if (!config.ALLOW_FEDERATED_VOICE) {
      return res.status(403).json({ error: 'Federated voice is not enabled on this instance' });
    }
    
    const validation = federatedTokenRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: 'Invalid request', 
        details: validation.error.errors 
      });
    }
    
    const { actorId, roomName, roomType, canPublish, canSubscribe, canPublishData } = validation.data;
    
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
      logger.warn(`Rejecting federated token request with invalid signature: ${verification.error}`);
      return res.status(401).json({ error: `Invalid HTTP Signature: ${verification.error}` });
    }

    // A verified signature only proves "some remote actor signed this request".
    // The claimed `actorId` must also be bound to the signer, else a valid
    // signer can mint a LiveKit token for a different actor (BUGS.md C3).
    // Strict match - no same-domain delegation for Person-style identities.
    if (!verification.actorUrl) {
      logger.warn('Rejecting federated token request: signature verification did not return an actor URL');
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
    
    return res.json({
      token,
      wsUrl: cfg.wsUrl,
      roomName,
      identity: `federated:${actorId}`,
    });
  } catch (error) {
    if (error instanceof TokenRefused) {
      logger.info(`Federated token for ${req.body?.actorId} in ${req.body?.roomName} refused: ${error.message}`);
      return res.status(403).json({ error: error.answer });
    }
    logger.error('Failed to generate federated token:', error);
    return res.status(500).json({ error: 'Failed to generate federated token' });
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
    return res.json({ rooms });
  } catch (error) {
    logger.error('Failed to list rooms:', error);
    return res.status(500).json({ error: 'Failed to list rooms' });
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
      return res.json({ message: 'Room deleted' });
    }
    return res.status(500).json({ error: 'Failed to delete room' });
  } catch (error) {
    logger.error('Failed to delete room:', error);
    return res.status(500).json({ error: 'Failed to delete room' });
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
      return res.json({ message: 'Participant removed' });
    }
    return res.status(500).json({ error: 'Failed to remove participant' });
  } catch (error) {
    logger.error('Failed to remove participant:', error);
    return res.status(500).json({ error: 'Failed to remove participant' });
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
      return res.json({ message: 'Permissions updated' });
    }
    return res.status(500).json({ error: 'Failed to update permissions' });
  } catch (error) {
    logger.error('Failed to update permissions:', error);
    return res.status(500).json({ error: 'Failed to update permissions' });
  }
});

// FEDERATED CALL ROUTES
//
// federated_voice_calls holds both directions of a federated DM call. inbound:
// a remote caller rang a local recipient. outbound: a local caller rang a
// remote recipient. The caller's LiveKit hosts the room. The routes act for the
// authenticated profile: an invite goes out under its own actor for a
// conversation it shares with the callee and is stored as outbound; accept and
// reject touch inbound calls it was invited to while they ring; end touches
// calls it is a party to and tells the remote party.

/** Profile of the authenticated user. */
async function callerProfile(authUserId: string): Promise<{ id: string; federated_id: string | null } | null> {
  const { data } = await getSupabaseClient()
    .from('profiles')
    .select('id, federated_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return data ?? null;
}

/** Pending, unexpired inbound call to `recipientId` from `callerFederatedId` in `conversationId`. */
async function ringingCallFor(recipientId: string, conversationId: unknown, callerFederatedId: unknown) {
  if (typeof conversationId !== 'string' || typeof callerFederatedId !== 'string') return null;
  const { data } = await getSupabaseClient()
    .from('federated_voice_calls')
    .select('*')
    .eq('direction', 'inbound')
    .eq('conversation_id', conversationId)
    .eq('caller_federated_id', callerFederatedId)
    .eq('recipient_id', recipientId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** Inbox and actor of a profile, for a delivery to it. */
async function remoteInbox(profileId: string | null): Promise<{ inbox: string; federatedId: string } | null> {
  if (!profileId) return null;
  const { data } = await getSupabaseClient()
    .from('profiles')
    .select('federated_id, inbox_url, is_local')
    .eq('id', profileId)
    .maybeSingle();
  if (!data || data.is_local || !data.inbox_url || !data.federated_id) return null;
  return { inbox: data.inbox_url, federatedId: data.federated_id };
}

/**
 * POST /api/livekit/federated-call/invite
 * Rings a remote user over ActivityPub. The room is on this instance's LiveKit;
 * the outbound row admits the callee to it.
 */
router.post('/federated-call/invite', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    if (!config.ALLOW_FEDERATED_VOICE) {
      return res.status(403).json({ error: 'Federated voice is not enabled on this instance' });
    }

    const user = (req as any).user;
    const { calleeFederatedId, callType, conversationId, roomName } = req.body ?? {};
    
    if (typeof calleeFederatedId !== 'string' || (callType !== 'voice' && callType !== 'video')
        || typeof conversationId !== 'string' || typeof roomName !== 'string') {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const caller = await callerProfile(user.id);
    if (!caller?.federated_id) {
      return res.status(400).json({ error: 'User has no federated ID' });
    }
    if (!isFederatedDmRoomFor(roomName, conversationId)) {
      return res.status(400).json({ error: 'roomName must be federated-dm-{conversationId}-{timestamp}' });
    }

    const supabase = getSupabaseClient();
    const { data: callee } = await supabase
      .from('profiles')
      .select('id, inbox_url, is_local')
      .eq('federated_id', calleeFederatedId)
      .maybeSingle();
    
    if (!callee?.inbox_url || callee.is_local) {
      return res.status(404).json({ error: 'Callee not found or no inbox URL' });
    }

    if (!(await isConversationParticipant(supabase, conversationId, caller.id))
        || !(await isConversationParticipant(supabase, conversationId, callee.id))) {
      return res.status(403).json({ error: 'Not a conversation shared with the callee' });
    }
    if (await eitherBlocks(supabase, caller.id, callee.id)) {
      return res.status(403).json({ error: 'Cannot call this user' });
    }

    const livekitUrl = livekitService.getClientConfig().wsUrl;
    if (!livekitUrl) {
      return res.status(503).json({ error: 'LiveKit is not configured' });
    }
    
    const { VoiceActivityHandler, RING_TTL_MS } = await import('../activitypub/VoiceActivityHandler.js');
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    
    const activity = VoiceActivityHandler.createVoiceCallInvite(
      caller.federated_id,
      calleeFederatedId,
      callType,
      conversationId,
      livekitUrl,
      roomName
    );

    // Stored before delivery: the callee's token request and Accept can
    // arrive before the delivery returns.
    const now = Date.now();
    const { error: insertError } = await supabase
      .from('federated_voice_calls')
      .insert({
        ap_id: activity.id,
        caller_id: caller.id,
        caller_federated_id: caller.federated_id,
        recipient_id: callee.id,
        call_type: callType,
        conversation_id: conversationId,
        livekit_url: livekitUrl,
        room_name: roomName,
        status: 'pending',
        direction: 'outbound',
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + RING_TTL_MS).toISOString(),
      });
    if (insertError) {
      logger.error('Failed to store outbound federated call:', insertError);
      return res.status(500).json({ error: 'Failed to send federated call invite' });
    }
    
    await DeliveryQueue.sendToInbox(callee.inbox_url, activity, caller.id);
    
    logger.info(`Sent federated call invite from ${caller.federated_id} to ${calleeFederatedId}`);

    return res.json({
      success: true,
      activityId: activity.id,
      expiresInMs: RING_TTL_MS,
    });
  } catch (error) {
    logger.error('Failed to send federated call invite:', error);
    return res.status(500).json({ error: 'Failed to send federated call invite' });
  }
});

/**
 * POST /api/livekit/federated-call/accept
 * Accepts a ringing inbound call: fetches this user's token for the caller's
 * room from the caller's instance, then tells it over ActivityPub. Answers
 * with the token; nothing changes when the caller's instance refuses one.
 */
router.post('/federated-call/accept', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    if (!config.ALLOW_FEDERATED_VOICE) {
      return res.status(403).json({ error: 'Federated voice is not enabled on this instance' });
    }

    const user = (req as any).user;
    const { conversationId, callerFederatedId } = req.body ?? {};
    
    if (!conversationId || !callerFederatedId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const acceptor = await callerProfile(user.id);
    if (!acceptor?.federated_id) {
      return res.status(400).json({ error: 'User has no federated ID' });
    }
    
    const call = await ringingCallFor(acceptor.id, conversationId, callerFederatedId);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js');
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');

    const token = await VoiceActivityHandler.requestCallToken(call, {
      id: acceptor.id,
      federated_id: acceptor.federated_id,
    });
    if (!token) {
      return res.status(502).json({ error: 'The caller\'s instance issued no token for this call' });
    }
    
    const supabase = getSupabaseClient();
    const { data: updated } = await supabase
      .from('federated_voice_calls')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('id', call.id)
      .eq('status', 'pending')
      .select('id');
    if (!updated?.length) {
      return res.status(409).json({ error: 'Call is no longer ringing' });
    }
    
    const activity = VoiceActivityHandler.createVoiceCallAccept(
      acceptor.federated_id,
      call.caller_federated_id,
      call.ap_id
    );
    const caller = await remoteInbox(call.caller_id);
    if (caller) {
      await DeliveryQueue.sendToInbox(caller.inbox, activity, acceptor.id);
    }
    
    logger.info(`Accepted federated call from ${call.caller_federated_id}`);
    
    return res.json({
      success: true,
      livekitUrl: token.wsUrl,
      roomName: token.roomName,
      token: token.token,
    });
  } catch (error) {
    logger.error('Failed to accept federated call:', error);
    return res.status(500).json({ error: 'Failed to accept federated call' });
  }
});

/**
 * POST /api/livekit/federated-call/reject
 * Reject a federated call via ActivityPub
 */
router.post('/federated-call/reject', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { conversationId, callerFederatedId } = req.body ?? {};
    
    if (!conversationId || !callerFederatedId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const rejector = await callerProfile(user.id);
    if (!rejector?.federated_id) {
      return res.status(400).json({ error: 'User has no federated ID' });
    }
    
    const call = await ringingCallFor(rejector.id, conversationId, callerFederatedId);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    const supabase = getSupabaseClient();
    await supabase
      .from('federated_voice_calls')
      .update({ status: 'rejected', ended_at: new Date().toISOString() })
      .eq('id', call.id)
      .eq('status', 'pending');
    
    const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js');
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    
    const activity = VoiceActivityHandler.createVoiceCallReject(
      rejector.federated_id,
      call.caller_federated_id,
      call.ap_id
    );
    const caller = await remoteInbox(call.caller_id);
    if (caller) {
      await DeliveryQueue.sendToInbox(caller.inbox, activity, rejector.id);
    }
    
    logger.info(`Rejected federated call from ${call.caller_federated_id}`);

    return res.json({ success: true });
  } catch (error) {
    logger.error('Failed to reject federated call:', error);
    return res.status(500).json({ error: 'Failed to reject federated call' });
  }
});

/**
 * POST /api/livekit/federated-call/end
 * Ends the user's live federated calls in a conversation, either direction,
 * and tells each remote party.
 */
router.post('/federated-call/end', requireAuth, requireLiveKit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { conversationId } = req.body ?? {};
    
    if (typeof conversationId !== 'string' || !conversationId) {
      return res.status(400).json({ error: 'Missing conversationId' });
    }
    
    const ender = await callerProfile(user.id);
    if (!ender) {
      return res.status(400).json({ error: 'Profile not found' });
    }

    const supabase = getSupabaseClient();
    const { data: calls } = await supabase
      .from('federated_voice_calls')
      .select('id, ap_id, direction, caller_id, recipient_id')
      .eq('conversation_id', conversationId)
      .in('status', ['pending', 'accepted'])
      .or(`caller_id.eq.${ender.id},recipient_id.eq.${ender.id}`);

    const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js');
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');

    for (const call of calls ?? []) {
      // The local party of each direction ends it; the other party is remote.
      const outbound = call.direction === 'outbound';
      if ((outbound ? call.caller_id : call.recipient_id) !== ender.id) continue;

      const { data: updated } = await supabase
        .from('federated_voice_calls')
        .update({ status: 'ended', ended_at: new Date().toISOString() })
        .eq('id', call.id)
        .in('status', ['pending', 'accepted'])
        .select('id');
      if (!updated?.length || !ender.federated_id) continue;

      const other = await remoteInbox(outbound ? call.recipient_id : call.caller_id);
      if (!other) continue;
      const activity = VoiceActivityHandler.createVoiceCallEnd(ender.federated_id, other.federatedId, call.ap_id);
      await DeliveryQueue.sendToInbox(other.inbox, activity, ender.id);
    }
    
    logger.info(`Ended federated call for conversation ${conversationId}`);

    return res.json({ success: true });
  } catch (error) {
    logger.error('Failed to end federated call:', error);
    return res.status(500).json({ error: 'Failed to end federated call' });
  }
});

export default router;

