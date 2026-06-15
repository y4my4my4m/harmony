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
 */

import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { SignatureService } from './SignatureService.js';
import { inboxLimiter } from '../middleware/rateLimit.js';
import { getFullServerBannerUrl, getFullServerIconUrl } from '../utils/urlUtils.js';

const router = Router();

// Channel type constants (matches DB schema: 0 = text, 1 = voice, 2 = category)
// eslint-disable-next-line unused-imports/no-unused-vars
const CHANNEL_TYPE_TEXT = 0;
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
  
  // Determine owner AP ID
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
 * GET /servers/:serverId - Server as ActivityPub Group
 */
router.get(
  '/servers/:serverId',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;
    const supabase = getSupabaseClient();

    logger.info(`📥 Fetching server ${serverId} as ActivityPub Group`);

    // Get server with owner profile
    const { data: server, error: serverError } = await supabase
      .from('servers')
      .select('*')
      .eq('id', serverId)
      .single();

    if (serverError || !server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Only serve local servers as ActivityPub actors
    if (server.is_local_server === false) {
      return res.status(404).json({ error: 'Server is not hosted here' });
    }

    // Get owner profile
    let ownerProfile = null;
    if (server.owner) {
      const { data: owner } = await supabase
        .from('profiles')
        .select('id, username, federated_id')
        .eq('id', server.owner)
        .single();
      ownerProfile = owner;
    }

    // Get categories from channel_categories table
    const { data: categories } = await supabase
      .from('channel_categories')
      .select('*')
      .eq('server_id', serverId)
      .order('order', { ascending: true });

    // Get channels ordered by category and position
    const { data: channelsData } = await supabase
      .from('channels')
      .select('*')
      .eq('server_id', serverId)
      .eq('is_remote', false)
      .order('category', { ascending: true, nullsFirst: true })
      .order('order', { ascending: true });

    // Merge categories (as type=2) with channels for ActivityPub export
    const channels = [
      // Add categories as type=2 channels
      ...(categories || []).map(cat => ({
        id: cat.id,
        name: cat.name,
        type: CHANNEL_TYPE_CATEGORY, // 2
        order: cat.order || 0,
        category: null,
        description: null,
        server_id: serverId,
      })),
      // Add regular channels
      ...(channelsData || []),
    ];

    // Get member count
    const { count: memberCount } = await supabase
      .from('user_servers')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', serverId)
      .eq('status', 'accepted');

    // Convert to ActivityPub Group
    const group = serverToGroup(
      server, 
      channels || [], 
      memberCount || 0,
      ownerProfile,
      config.INSTANCE_DOMAIN
    );

    res.setHeader('Content-Type', 'application/activity+json');
    // Server info (name, channels, member count) - cache for 60 seconds
    // Balances freshness with efficiency for federated discovery
    res.setHeader('Cache-Control', 'public, max-age=60');
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

    // Get channel with server info
    const { data: channel, error } = await supabase
      .from('channels')
      .select(`
        *,
        server:servers!channels_server_id_fkey(id, name, is_local_server)
      `)
      .eq('id', channelId)
      .eq('server_id', serverId)
      .single();

    if (error || !channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Only serve local channels
    if (channel.is_remote) {
      return res.status(404).json({ error: 'Channel is not hosted here' });
    }

    const hostDomain = config.INSTANCE_DOMAIN;
    const serverUrl = `https://${hostDomain}/servers/${serverId}`;
    const channelUrl = `${serverUrl}/channels/${channelId}`;

    // Channel type: 0 = text, 1 = voice
    const channelType = channel.type === CHANNEL_TYPE_VOICE 
      ? 'harmony:VoiceChannel' 
      : 'harmony:TextChannel';

    res.setHeader('Content-Type', 'application/activity+json');
    // Channel metadata changes rarely - cache for 60 seconds
    res.setHeader('Cache-Control', 'public, max-age=60');
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
 */
router.get(
  '/servers/:serverId/channels/:channelId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId, channelId } = req.params;
    const page = req.query.page ? parseInt(req.query.page as string) : undefined;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    const messagesUrl = `https://${hostDomain}/servers/${serverId}/channels/${channelId}/messages`;

    // Verify channel exists
    const { data: channel } = await supabase
      .from('channels')
      .select('id')
      .eq('id', channelId)
      .eq('server_id', serverId)
      .single();

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    if (!page) {
      // Return collection metadata
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('channel_id', channelId)
        .eq('is_deleted', false);

      res.setHeader('Content-Type', 'application/activity+json');
      // Short cache for message collection metadata - real-time messages are PUSHED
      // This cache helps when many instances backfill simultaneously
      res.setHeader('Cache-Control', 'public, max-age=10');
      return res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: messagesUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${messagesUrl}?page=1`,
      });
    }

    // Return paginated messages
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
    // Short cache for message pages - balances near-real-time feel with efficiency
    // Real-time messages are PUSHED, this is for backfill/sync
    res.setHeader('Cache-Control', 'public, max-age=10');
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
 * GET /servers/:serverId/channels/:channelId/outbox - Channel outbox (alias for messages)
 * Standard ActivityPub endpoint for fetching channel content
 */
router.get(
  '/servers/:serverId/channels/:channelId/outbox',
  asyncHandler(async (req: Request, res: Response) => {
    // Redirect to messages endpoint
    const { serverId, channelId } = req.params;
    const page = req.query.page;
    const hostDomain = config.INSTANCE_DOMAIN;
    const messagesUrl = `https://${hostDomain}/servers/${serverId}/channels/${channelId}/messages`;
    
    res.redirect(301, page ? `${messagesUrl}?page=${page}` : messagesUrl);
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

    if (!page) {
      // Get member count
      const { count } = await supabase
        .from('user_servers')
        .select('*', { count: 'exact', head: true })
        .eq('server_id', serverId)
        .eq('status', 'accepted');

      res.setHeader('Content-Type', 'application/activity+json');
      // Member count doesn't change frequently - cache for 60 seconds
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: membersUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${membersUrl}?page=1`,
      });
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
    // Member list changes occasionally - cache for 60 seconds
    res.setHeader('Cache-Control', 'public, max-age=60');
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
 * GET /servers/:serverId/outbox - Server outbox (all channel messages as Create activities)
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

    // Get all channel IDs for this server
    const { data: channels } = await supabase
      .from('channels')
      .select('id')
      .eq('server_id', serverId)
      .eq('is_remote', false);

    const channelIds = (channels || []).map(c => c.id);

    if (!page) {
      // Return collection metadata
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .in('channel_id', channelIds)
        .eq('is_deleted', false);

      res.setHeader('Content-Type', 'application/activity+json');
      // Server outbox is for backfill - short cache for efficiency
      res.setHeader('Cache-Control', 'public, max-age=15');
      return res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: outboxUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${outboxUrl}?page=1`,
      });
    }

    // Return paginated messages as Create activities
    const limit = 20;
    const offset = (page - 1) * limit;

    const { data: messages } = await supabase
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

    // Convert to ActivityPub Create activities
    const items = (messages || []).map((message: any) => {
      const authorApId = message.author?.federated_id || 
        `https://${hostDomain}/users/${message.author?.username}`;
      const channelUrl = `${serverUrl}/channels/${message.channel?.id}`;
      
      // Convert content array to HTML
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
          'harmony:rawContent': message.content,
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
    // Server outbox pages - short cache for backfill efficiency
    res.setHeader('Cache-Control', 'public, max-age=15');
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

    // Verify HTTP signature (same pattern as user inbox)
    const signature = req.headers.signature as string;
    if (!signature) {
      if (config.REQUIRE_VALID_SIGNATURES) {
        logger.warn(`🚫 Rejecting unsigned server inbox activity from ${actorUrl}`);
        res.status(401).json({ error: 'Missing HTTP Signature' });
        return;
      }
      logger.warn(`⚠️ Accepting unsigned server inbox activity from ${actorUrl} (REQUIRE_VALID_SIGNATURES=false)`);
    } else {
      const rawBody = (req as any).rawBody as Buffer | undefined;
      const verification = await SignatureService.verifySignature(
        signature,
        req.headers as Record<string, string>,
        req.method,
        req.originalUrl || req.path,
        rawBody || activity
      );

      if (!verification.verified) {
        if (config.REQUIRE_VALID_SIGNATURES) {
          logger.warn(`🚫 Rejecting server inbox activity with invalid signature: ${verification.error}`);
          res.status(401).json({ error: `Invalid HTTP Signature: ${verification.error}` });
          return;
        }
        logger.warn(`⚠️ Accepting invalid signature on server inbox (REQUIRE_VALID_SIGNATURES=false)`);
      } else if (verification.actorUrl && actorUrl) {
        // Server inbox carries Group/Service actor activities (e.g. Lemmy
        // c/<community> announcements signed by u/<moderator>). Allow
        // same-domain delegation here, but the strict mode used by the
        // user inbox (`verifyActorMatch(a, b)`) still applies for Person
        // actors and prevents cross-user impersonation. See BUGS.md C1.
        const actorMatch = SignatureService.verifyActorMatch(
          actorUrl,
          verification.actorUrl,
          true /* allowSameDomainDelegation */,
        );
        if (!actorMatch && config.REQUIRE_VALID_SIGNATURES) {
          logger.warn(`🚫 Rejecting: actor mismatch on server inbox. Activity: ${actorUrl}, Signer: ${verification.actorUrl}`);
          res.status(403).json({ error: 'Actor mismatch' });
          return;
        }
      }
    }

    const { processServerInboxActivity } = await import('./ServerInboxHandler.js');
    await processServerInboxActivity(serverId, activity);

    res.status(202).json({ message: 'Activity accepted' });
  })
);

export default router;

