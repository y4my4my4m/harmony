/**
 * GroupService - Servers as ActivityPub Groups
 * 
 * Implements federated Discord servers using ActivityPub Group actors.
 * Enables users from multiple Harmony instances to join the same server.
 * 
 * Protocol Design:
 * - Servers are exposed as ActivityPub `Group` actors
 * - Channels are embedded as `harmony:channels` extension
 * - Messages reference channels via `context` property
 * - Join/Leave activities control membership
 * - Private servers and channels @everyone cannot view are served only to a
 *   signed remote member that can view them (groupAccess.ts)
 */

import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { SignatureService } from './SignatureService.js';
import { clientIp, inboxLimiter, instanceInboxLimit, signerInstanceKey } from '../middleware/rateLimit.js';
import { getFullServerBannerUrl, getFullServerIconUrl } from '../utils/urlUtils.js';
import { PUBLIC_AUDIENCE, federateContentParts } from '../utils/privateMedia.js';
import { withoutPollParts } from '../utils/polls.js';
import {
  canReadServer,
  isPublicView,
  loadGroupAccess,
  readableChannelIds,
  verifiedSigner,
  type GroupAccess,
} from './groupAccess.js';

const router = Router();

// channels.type: 0 = text, 1 = voice, 2 = category.
const CHANNEL_TYPE_VOICE = 1;
const CHANNEL_TYPE_CATEGORY = 2;

/**
 * Convert server to ActivityPub Group
 */
function serverToGroup(
  server: any, 
  channels: any[], 
  memberCount: number,
  ownerProfile: any | null,
  hostDomain: string
): any {
  const serverUrl = `https://${hostDomain}/servers/${server.id}`;
  
  const ownerApId = ownerProfile?.federated_id || 
    (ownerProfile?.username ? `https://${hostDomain}/users/${ownerProfile.username}` : null);

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'harmony': 'https://harmonyapp.dev/ns#',
        'ChatServer': 'harmony:ChatServer',
        'TextChannel': 'harmony:TextChannel',
        'VoiceChannel': 'harmony:VoiceChannel',
        'channels': 'harmony:channels',
        'memberCount': 'harmony:memberCount',
      },
    ],
    id: serverUrl,
    type: 'Group',
    'harmony:type': 'ChatServer',
    // WebFinger handle (acct:{preferredUsername}@domain). Lets remote instances
    // resolve and verify this Group the standard Fediverse way.
    preferredUsername: server.slug || undefined,
    name: server.name,
    summary: server.description || '',
    inbox: `${serverUrl}/inbox`,
    outbox: `${serverUrl}/outbox`,
    members: `${serverUrl}/members`,
    followers: `${serverUrl}/followers`,
    
    // Server owner
    attributedTo: ownerApId,
    
    published: server.created_at,
    updated: server.updated_at || server.created_at,
    
    // Member count for discovery
    'harmony:memberCount': memberCount,
    
    // Icon - omit default so remote instances use their own fallback
    icon: (() => {
      const url = getFullServerIconUrl(server.icon);
      return url ? { type: 'Image', url, mediaType: 'image/webp' } : undefined;
    })(),
    
    // Banner (ActivityPub uses 'image' for header/banner)
    image: (() => {
      const url = getFullServerBannerUrl(server.banner);
      return url ? { type: 'Image', url } : undefined;
    })(),
    
    // Harmony extension: Channel structure
    'harmony:channels': channels.map(c => {
      let channelType: string;
      if (c.type === CHANNEL_TYPE_CATEGORY) {
        channelType = 'category';
      } else if (c.type === CHANNEL_TYPE_VOICE) {
        channelType = 'voice';
      } else {
        channelType = 'text';
      }
      
      return {
        type: channelType === 'category' ? 'harmony:Category' : 
              (channelType === 'voice' ? 'harmony:VoiceChannel' : 'harmony:TextChannel'),
        id: `${serverUrl}/channels/${c.id}`,
        localId: c.id,
        name: c.name,
        position: c.order || c.position || 0,
        order: c.order || c.position || 0,
        category: c.category ? `${serverUrl}/channels/${c.category}` : null,
        categoryId: c.category,
        description: c.description || undefined,
        channelType, // 'text', 'voice', or 'category'
      };
    }),
    
    // Discoverability and federation settings
    discoverable: server.public === true,
    manuallyApprovesFollowers: false, // Auto-accept joins for public servers
    
    // Public key for verification
    publicKey: server.public_key ? {
      id: `${serverUrl}#main-key`,
      owner: serverUrl,
      publicKeyPem: server.public_key,
    } : undefined,
  };
}

/**
 * Group document for a caller who may not read the server: what a remote
 * Join by invite needs (id, inbox, key, and the name its reference row
 * stores) and no channels, member count or owner.
 */
function serverToJoinStub(server: any, hostDomain: string): any {
  const serverUrl = `https://${hostDomain}/servers/${server.id}`;
  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'harmony': 'https://harmonyapp.dev/ns#',
        'ChatServer': 'harmony:ChatServer',
      },
    ],
    id: serverUrl,
    type: 'Group',
    'harmony:type': 'ChatServer',
    name: server.name,
    inbox: `${serverUrl}/inbox`,
    discoverable: false,
    manuallyApprovesFollowers: true,
    publicKey: server.public_key ? {
      id: `${serverUrl}#main-key`,
      owner: serverUrl,
      publicKeyPem: server.public_key,
    } : undefined,
  };
}

const PRIVATE_CACHE = 'private, no-store';

/**
 * 404 for an unknown id and for one the caller may not read alike: same
 * status, body and headers, so a response never confirms a private id.
 */
function notFound(res: Response, what: 'Server' | 'Channel'): void {
  res.status(404).json({ error: `${what} not found` });
}

/**
 * Cache-Control for a response. Public only when it holds nothing beyond what
 * an unsigned caller reads; `Vary: Signature` where a signed caller can be
 * served more at the same URL.
 */
function setCaching(res: Response, shareable: boolean, publicValue: string, variesBySigner: boolean): void {
  if (!shareable) {
    res.setHeader('Cache-Control', PRIVATE_CACHE);
    return;
  }
  res.setHeader('Cache-Control', publicValue);
  if (variesBySigner) res.setHeader('Vary', 'Signature');
}

async function accessFor(req: Request): Promise<GroupAccess | null> {
  return loadGroupAccess(req.params.serverId, await verifiedSigner(req));
}

/**
 * GET /servers/:serverId - Server as ActivityPub Group
 *
 * A caller who may not read the server gets the Group stub a remote Join
 * needs. Everyone else gets the channels it may read.
 */
router.get(
  '/servers/:serverId',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;
    const supabase = getSupabaseClient();

    const access = await accessFor(req);
    if (!access) {
      notFound(res, 'Server');
      return;
    }

    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', serverId)
      .maybeSingle();

    if (!server) {
      notFound(res, 'Server');
      return;
    }

    if (!canReadServer(access)) {
      res.setHeader('Content-Type', 'application/activity+json');
      res.setHeader('Cache-Control', PRIVATE_CACHE);
      res.json(serverToJoinStub(server, config.INSTANCE_DOMAIN));
      return;
    }

    let ownerProfile = null;
    if (server.owner) {
      const { data: owner } = await supabase
        .from('profiles')
        .select('id, username, federated_id')
        .eq('id', server.owner)
        .single();
      ownerProfile = owner;
    }

    const { data: categories } = await supabase
      .from('channel_categories')
      .select('*')
      .eq('server_id', serverId)
      .order('order', { ascending: true });

    const { data: channelsData } = await supabase
      .from('channels')
      .select('*')
      .eq('server_id', serverId)
      .not('is_remote', 'is', true)
      .order('category', { ascending: true, nullsFirst: true })
      .order('order', { ascending: true });

    const readable = readableChannelIds(access);
    const allChannels = channelsData || [];
    const listedChannels = allChannels.filter(c => readable.has(c.id));

    // A category is listed when it holds a listed channel or holds none at
    // all; one holding only hidden channels would name what it hides.
    const listedCategoryIds = new Set(listedChannels.map(c => c.category).filter(Boolean));
    const occupiedCategoryIds = new Set(allChannels.map(c => c.category).filter(Boolean));
    const listedCategories = (categories || []).filter(
      cat => listedCategoryIds.has(cat.id) || !occupiedCategoryIds.has(cat.id),
    );

    // Categories are exported as type 2 alongside channels.
    const channels = [
      ...listedCategories.map(cat => ({
        id: cat.id,
        name: cat.name,
        type: CHANNEL_TYPE_CATEGORY,
        order: cat.order || 0,
        category: null,
        description: null,
        server_id: serverId,
      })),
      ...listedChannels,
    ];

    const { count: memberCount } = await supabase
      .from('user_servers')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', serverId)
      .eq('status', 'accepted');

    const group = serverToGroup(
      server,
      channels,
      memberCount || 0,
      ownerProfile,
      config.INSTANCE_DOMAIN
    );

    res.setHeader('Content-Type', 'application/activity+json');
    // 60s: name, channels and member count change rarely.
    setCaching(res, isPublicView(access, listedChannels.map(c => c.id)), 'public, max-age=60', true);
    res.json(group);
  })
);

/**
 * GET /servers/:serverId/channels/:channelId - Channel details
 * Returns channel as ActivityPub object that can be used as context for messages
 */
router.get(
  '/servers/:serverId/channels/:channelId',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId, channelId } = req.params;
    const supabase = getSupabaseClient();

    const access = await accessFor(req);
    if (!access || !readableChannelIds(access).has(channelId)) {
      notFound(res, 'Channel');
      return;
    }

    const { data: channel } = await supabase
      .from('channels')
      .select('*')
      .eq('id', channelId)
      .eq('server_id', serverId)
      .not('is_remote', 'is', true)
      .maybeSingle();

    if (!channel) {
      notFound(res, 'Channel');
      return;
    }

    const hostDomain = config.INSTANCE_DOMAIN;
    const serverUrl = `https://${hostDomain}/servers/${serverId}`;
    const channelUrl = `${serverUrl}/channels/${channelId}`;

    // Channel type: 0 = text, 1 = voice
    const channelType = channel.type === CHANNEL_TYPE_VOICE
      ? 'harmony:VoiceChannel'
      : 'harmony:TextChannel';

    res.setHeader('Content-Type', 'application/activity+json');
    // 60s: channel metadata changes rarely.
    setCaching(res, isPublicView(access, [channelId]), 'public, max-age=60', false);
    res.json({
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          'harmony': 'https://harmonyapp.dev/ns#',
          'TextChannel': 'harmony:TextChannel',
          'VoiceChannel': 'harmony:VoiceChannel',
        },
      ],
      id: channelUrl,
      type: channelType,
      name: channel.name,
      summary: channel.description || undefined,
      // The server this channel belongs to
      context: serverUrl,
      attributedTo: serverUrl,
      // Channel metadata
      position: channel.order || 0,
      published: channel.created_at,
      // Collection of messages in this channel
      replies: `${channelUrl}/messages`,
    });
  })
);

/**
 * GET /servers/:serverId/channels/:channelId/messages - Channel message collection
 * GET /servers/:serverId/channels/:channelId/outbox   - the same collection
 *
 * The outbox alias is served in place rather than redirected: a signature
 * covers the request path, so a signed GET cannot follow a redirect.
 */
router.get(
  ['/servers/:serverId/channels/:channelId/messages', '/servers/:serverId/channels/:channelId/outbox'],
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId, channelId } = req.params;
    const page = req.query.page ? parseInt(req.query.page as string) : undefined;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    const messagesUrl = `https://${hostDomain}/servers/${serverId}/channels/${channelId}/messages`;

    const access = await accessFor(req);
    if (!access || !readableChannelIds(access).has(channelId)) {
      notFound(res, 'Channel');
      return;
    }

    const { data: channel } = await supabase
      .from('channels')
      .select('id')
      .eq('id', channelId)
      .eq('server_id', serverId)
      .not('is_remote', 'is', true)
      .maybeSingle();

    if (!channel) {
      notFound(res, 'Channel');
      return;
    }

    const shareable = isPublicView(access, [channelId]);

    if (!page) {
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('channel_id', channelId)
        .eq('is_deleted', false);

      res.setHeader('Content-Type', 'application/activity+json');
      // 10s: live messages are pushed; this absorbs simultaneous backfills.
      setCaching(res, shareable, 'public, max-age=10', false);
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: messagesUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${messagesUrl}?page=1`,
      });
      return;
    }

    const limit = 50;
    const offset = (page - 1) * limit;

    const { data: messages } = await supabase
      .from('messages')
      .select(`
        *,
        author:profiles!messages_user_id_fkey(id, username, federated_id, display_name, avatar_url)
      `)
      .eq('channel_id', channelId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const items = (messages || []).map((message) => {
      const authorApId = message.author?.federated_id ||
        `https://${hostDomain}/users/${message.author?.username}`;

      return {
        type: 'Note',
        id: `https://${hostDomain}/messages/${message.id}`,
        attributedTo: authorApId,
        content: Array.isArray(message.content)
          ? message.content.map((c: any) => c.text || c.content || '').join('')
          : JSON.stringify(message.content),
        context: `https://${hostDomain}/servers/${serverId}/channels/${channelId}`,
        published: message.created_at,
        updated: message.updated_at !== message.created_at ? message.updated_at : undefined,
        inReplyTo: message.reply_to
          ? `https://${hostDomain}/messages/${message.reply_to}`
          : undefined,
      };
    });

    res.setHeader('Content-Type', 'application/activity+json');
    // 10s: live messages are pushed; pages serve backfill and sync.
    setCaching(res, shareable, 'public, max-age=10', false);
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${messagesUrl}?page=${page}`,
      type: 'OrderedCollectionPage',
      partOf: messagesUrl,
      orderedItems: items,
      next: items.length === limit ? `${messagesUrl}?page=${page + 1}` : undefined,
      prev: page > 1 ? `${messagesUrl}?page=${page - 1}` : undefined,
    });
  })
);

/**
 * GET /servers/:serverId/members - Member collection
 */
router.get(
  '/servers/:serverId/members',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;
    const page = req.query.page ? parseInt(req.query.page as string) : undefined;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    const membersUrl = `https://${hostDomain}/servers/${serverId}/members`;

    const access = await accessFor(req);
    if (!access || !canReadServer(access)) {
      notFound(res, 'Server');
      return;
    }

    if (!page) {
      const { count } = await supabase
        .from('user_servers')
        .select('*', { count: 'exact', head: true })
        .eq('server_id', serverId)
        .eq('status', 'accepted');

      res.setHeader('Content-Type', 'application/activity+json');
      // 60s: membership changes occasionally.
      setCaching(res, access.isPublic, 'public, max-age=60', false);
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: membersUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${membersUrl}?page=1`,
      });
      return;
    }

    // Paginated member list
    const limit = 50;
    const offset = (page - 1) * limit;

    const { data: memberships } = await supabase
      .from('user_servers')
      .select(`
        user_id,
        created_at,
        member_instance,
        profile:profiles!user_servers_user_id_fkey(id, username, federated_id, display_name, avatar_url, is_local)
      `)
      .eq('server_id', serverId)
      .eq('status', 'accepted')
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    const items = (memberships || []).map((m: any) => {
      const memberApId = m.profile?.federated_id ||
        (m.profile?.is_local ? `https://${hostDomain}/users/${m.profile?.username}` : null);

      return memberApId;
    }).filter(Boolean);

    res.setHeader('Content-Type', 'application/activity+json');
    // 60s: membership changes occasionally.
    setCaching(res, access.isPublic, 'public, max-age=60', false);
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${membersUrl}?page=${page}`,
      type: 'OrderedCollectionPage',
      partOf: membersUrl,
      orderedItems: items,
      next: items.length === limit ? `${membersUrl}?page=${page + 1}` : undefined,
    });
  })
);

/**
 * GET /servers/:serverId/outbox - Server outbox (messages of the channels the
 * caller may read, as Create activities)
 */
router.get(
  '/servers/:serverId/outbox',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;
    const supabase = getSupabaseClient();
    const page = req.query.page ? parseInt(req.query.page as string) : undefined;

    const hostDomain = config.INSTANCE_DOMAIN;
    const serverUrl = `https://${hostDomain}/servers/${serverId}`;
    const outboxUrl = `${serverUrl}/outbox`;

    const signer = await verifiedSigner(req);
    const access = await loadGroupAccess(serverId, signer);
    if (!access || !canReadServer(access)) {
      notFound(res, 'Server');
      return;
    }
    // Attachment URLs name the member's instance; anyone else reads public channels only.
    const mediaAudience = access.memberId && signer
      ? new URL(signer).host.toLowerCase()
      : PUBLIC_AUDIENCE;

    const channelIds = [...readableChannelIds(access)];
    const shareable = isPublicView(access, channelIds);

    if (!page) {
      let total = 0;
      if (channelIds.length > 0) {
        const { count } = await supabase
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .in('channel_id', channelIds)
          .eq('is_deleted', false);
        total = count || 0;
      }

      res.setHeader('Content-Type', 'application/activity+json');
      // 15s: backfill only.
      setCaching(res, shareable, 'public, max-age=15', true);
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: outboxUrl,
        type: 'OrderedCollection',
        totalItems: total,
        first: `${outboxUrl}?page=1`,
      });
      return;
    }

    const limit = 20;
    const offset = (page - 1) * limit;

    let messages: any[] = [];
    if (channelIds.length > 0) {
      const { data } = await supabase
        .from('messages')
        .select(`
          *,
          channel:channels!messages_channel_id_fkey(id, name),
          author:profiles!messages_user_id_fkey(id, username, federated_id, display_name)
        `)
        .in('channel_id', channelIds)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      messages = data || [];
    }

    const items = messages.map((message: any) => {
      const authorApId = message.author?.federated_id ||
        `https://${hostDomain}/users/${message.author?.username}`;
      const channelUrl = `${serverUrl}/channels/${message.channel?.id}`;

      const contentHtml = Array.isArray(message.content)
        ? message.content.map((c: any) => {
            if (c.type === 'text') return `<p>${c.text || ''}</p>`;
            if (c.type === 'mention') return `<span class="mention">@${c.username}</span>`;
            return '';
          }).join('')
        : '';

      return {
        '@context': [
          'https://www.w3.org/ns/activitystreams',
          { 'harmony': 'https://harmonyapp.dev/ns#' },
        ],
        id: `${serverUrl}/activities/${message.id}`,
        type: 'Create',
        actor: authorApId,
        published: message.created_at,
        to: [`${serverUrl}/members`],
        cc: [],
        object: {
          type: 'Note',
          id: `https://${hostDomain}/messages/${message.id}`,
          attributedTo: authorApId,
          content: contentHtml,
          'harmony:rawContent': federateContentParts(withoutPollParts(message.content), mediaAudience),
          context: channelUrl,
          'harmony:channelName': message.channel?.name,
          'harmony:serverId': serverId,
          published: message.created_at,
          updated: message.updated_at !== message.created_at ? message.updated_at : undefined,
          inReplyTo: message.reply_to
            ? `https://${hostDomain}/messages/${message.reply_to}`
            : undefined,
        },
      };
    });

    res.setHeader('Content-Type', 'application/activity+json');
    // 15s: backfill only.
    setCaching(res, shareable, 'public, max-age=15', true);
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${outboxUrl}?page=${page}`,
      type: 'OrderedCollectionPage',
      partOf: outboxUrl,
      orderedItems: items,
      next: items.length === limit ? `${outboxUrl}?page=${page + 1}` : undefined,
      prev: page > 1 ? `${outboxUrl}?page=${page - 1}` : undefined,
    });
  })
);

/**
 * POST /servers/:serverId/inbox - Receive Join/Leave/Message activities
 */
router.post(
  '/servers/:serverId/inbox',
  inboxLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;
    const activity = req.body;
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    let verifiedSigner: string | null = null;

    const signature = req.headers.signature as string;
    if (!signature) {
      if (config.REQUIRE_VALID_SIGNATURES) {
        logger.warn(`Rejecting unsigned server inbox activity from ${actorUrl}`);
        res.status(401).json({ error: 'Missing HTTP Signature' });
        return;
      }
      logger.warn(`Accepting unsigned server inbox activity from ${actorUrl} (REQUIRE_VALID_SIGNATURES=false)`);
    } else {
      const rawBody = (req as any).rawBody as Buffer | undefined;
      const verification = await SignatureService.verifySignature(
        signature,
        req.headers as Record<string, string>,
        req.method,
        req.originalUrl || req.path,
        rawBody || activity,
        req.protocol,
      );

      if (!verification.verified) {
        if (config.REQUIRE_VALID_SIGNATURES) {
          logger.warn(`Rejecting server inbox activity with invalid signature: ${verification.error}`);
          res.status(401).json({ error: `Invalid HTTP Signature: ${verification.error}` });
          return;
        }
        logger.warn(`Accepting invalid signature on server inbox (REQUIRE_VALID_SIGNATURES=false)`);
      } else if (verification.actorUrl) {
        // Strict match, as on the user inbox (BUGS.md C1). Every handler here
        // treats `activity.actor` as the member acting; same-domain
        // delegation would let any user on a host act as any other user on
        // it. Harmony peers sign server-inbox deliveries with the actor's key.
        const actorMatch = !!actorUrl && SignatureService.verifyActorMatch(actorUrl, verification.actorUrl);
        if (!actorMatch && config.REQUIRE_VALID_SIGNATURES) {
          logger.warn(`Rejecting: actor mismatch on server inbox. Activity: ${actorUrl}, Signer: ${verification.actorUrl}`);
          res.status(403).json({ error: 'Actor mismatch' });
          return;
        }
        verifiedSigner = verification.actorUrl;
      }
    }

    // Per-instance budget, keyed on the verified signer, never on the body.
    if (!(await instanceInboxLimit(res, signerInstanceKey(verifiedSigner, clientIp(req))))) {
      return;
    }

    // Store + claim for idempotency, same machinery as the user inbox: a
    // redelivered activity must not run its side effects twice. Activities
    // that can't be stored (missing id, ap_type outside the DB constraint)
    // are processed without a claim rather than dropped.
    const supabase = getSupabaseClient();
    let claimedForProcessing = false;
    if (typeof activity.id === 'string' && activity.id) {
      let originDomain: string | null = null;
      try {
        originDomain = actorUrl ? new URL(actorUrl).hostname.toLowerCase() : null;
      } catch {
        originDomain = null;
      }
      const normalizedType = activity.type === 'EmojiReact' ? 'EmojiReaction' : activity.type;
      const { error: storeError } = await supabase.rpc('upsert_ap_activity', {
        p_ap_id: activity.id,
        p_ap_type: normalizedType,
        p_actor_ap_id: actorUrl,
        p_activity_data: activity,
        p_origin_domain: originDomain,
        p_to_addresses: Array.isArray(activity.to) ? activity.to : [activity.to].filter(Boolean),
        p_cc_addresses: Array.isArray(activity.cc) ? activity.cc : [activity.cc].filter(Boolean),
        p_is_local: false,
      });
      if (storeError) {
        logger.warn(`Could not store server inbox activity ${activity.id}: ${storeError.message}`);
      } else {
        const { data: claimed, error: claimError } = await supabase.rpc('claim_ap_activity', {
          p_ap_id: activity.id,
        });
        if (!claimError && claimed === false) {
          logger.info(`Skipping already-processed server inbox activity ${activity.id}`);
          res.status(202).json({ message: 'Activity already processed' });
          return;
        }
        claimedForProcessing = !claimError;
      }
    }

    const { processServerInboxActivity } = await import('./ServerInboxHandler.js');
    try {
      await processServerInboxActivity(serverId, activity);
    } catch (error) {
      if (claimedForProcessing) {
        await supabase.rpc('complete_ap_activity', {
          p_ap_id: activity.id,
          p_success: false,
          p_error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
    if (claimedForProcessing) {
      await supabase.rpc('complete_ap_activity', { p_ap_id: activity.id, p_success: true });
    }

    res.status(202).json({ message: 'Activity accepted' });
  })
);

export default router;

