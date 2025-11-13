/**
 * GroupService - Servers as ActivityPub Groups
 * 
 * Implements federated Discord servers using ActivityPub Group actors.
 * Enables users from multiple Harmony instances to join the same server.
 */

import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import config from '../config/index.js';

const router = Router();

/**
 * Convert server to ActivityPub Group
 */
function serverToGroup(server: any, channels: any[], hostDomain: string): any {
  const serverUrl = `https://${hostDomain}/servers/${server.id}`;

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'harmony': 'https://harmonyapp.dev/ns#',
        'ChatServer': 'harmony:ChatServer',
        'TextChannel': 'harmony:TextChannel',
        'VoiceChannel': 'harmony:VoiceChannel',
        'channels': 'harmony:channels',
      },
    ],
    id: serverUrl,
    type: 'Group',
    name: server.name,
    summary: server.description || '',
    inbox: `${serverUrl}/inbox`,
    outbox: `${serverUrl}/outbox`,
    members: `${serverUrl}/members`,
    followers: `${serverUrl}/followers`,
    
    // Server owner
    attributedTo: server.owner_ap_id || `https://${hostDomain}/users/${server.owner_id}`,
    
    published: server.created_at,
    
    // Icon
    icon: server.icon ? {
      type: 'Image',
      url: server.icon,
    } : undefined,
    
    // Harmony extension: Channel structure
    'harmony:channels': channels.map(c => ({
      type: c.type === 'text' ? 'TextChannel' : 'VoiceChannel',
      id: `${serverUrl}/channels/${c.id}`,
      name: c.name,
      position: c.position,
      category: c.category_id,
    })),
    
    // Discoverability
    discoverable: server.public || false,
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

    // Get server
    const { data: server, error: serverError } = await supabase
      .from('servers')
      .select('*')
      .eq('id', serverId)
      .single();

    if (serverError || !server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Get channels
    const { data: channels } = await supabase
      .from('channels')
      .select('*')
      .eq('server_id', serverId)
      .order('position', { ascending: true });

    // Convert to ActivityPub Group
    const group = serverToGroup(server, channels || [], config.INSTANCE_DOMAIN);

    res.setHeader('Content-Type', 'application/activity+json');
    res.json(group);
  })
);

/**
 * GET /servers/:serverId/channels/:channelId - Channel details
 */
router.get(
  '/servers/:serverId/channels/:channelId',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId, channelId } = req.params;
    const supabase = getSupabaseClient();

    // Get channel
    const { data: channel, error } = await supabase
      .from('channels')
      .select('*')
      .eq('id', channelId)
      .eq('server_id', serverId)
      .single();

    if (error || !channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const hostDomain = config.INSTANCE_DOMAIN;
    const channelUrl = `https://${hostDomain}/servers/${serverId}/channels/${channelId}`;

    res.setHeader('Content-Type', 'application/activity+json');
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
      type: channel.type === 'text' ? 'TextChannel' : 'VoiceChannel',
      name: channel.name,
      context: `https://${hostDomain}/servers/${serverId}`,
      position: channel.position,
      published: channel.created_at,
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
    const supabase = getSupabaseClient();

    // Get member count
    const { count } = await supabase
      .from('user_servers')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', serverId);

    const hostDomain = config.INSTANCE_DOMAIN;
    const membersUrl = `https://${hostDomain}/servers/${serverId}/members`;

    res.setHeader('Content-Type', 'application/activity+json');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: membersUrl,
      type: 'Collection',
      totalItems: count || 0,
      first: `${membersUrl}?page=1`,
    });
  })
);

/**
 * GET /servers/:serverId/outbox - Server outbox (all channel messages)
 */
router.get(
  '/servers/:serverId/outbox',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;
    const supabase = getSupabaseClient();
    const page = req.query.page ? parseInt(req.query.page as string) : undefined;

    const hostDomain = config.INSTANCE_DOMAIN;
    const outboxUrl = `https://${hostDomain}/servers/${serverId}/outbox`;

    if (!page) {
      // Return collection metadata
      const { count } = await supabase
        .from('messages')
        .select('m.*, c.server_id', { count: 'exact', head: true })
        .from('messages as m')
        .innerJoin('channels as c', 'm.channel_id', 'c.id')
        .eq('c.server_id', serverId);

      res.setHeader('Content-Type', 'application/activity+json');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: outboxUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${outboxUrl}?page=1`,
      });
    } else {
      // Return paginated messages
      const limit = 20;
      const offset = (page - 1) * limit;

      // Get messages from all channels in this server
      const { data: messages } = await supabase
        .from('messages')
        .select(`
          *,
          channel:channels!messages_channel_id_fkey(id, name, server_id),
          author:profiles!messages_user_id_fkey(*)
        `)
        .eq('channel.server_id', serverId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      // Convert to ActivityPub Create activities
      const items = (messages || []).map((message) => ({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${outboxUrl}/activities/${message.id}`,
        type: 'Create',
        actor: `https://${hostDomain}/users/${message.author.username}`,
        published: message.created_at,
        object: {
          type: 'Note',
          id: `https://${hostDomain}/messages/${message.id}`,
          content: JSON.stringify(message.content),
          context: `${outboxUrl.replace('/outbox', '')}/channels/${message.channel.id}`,
          published: message.created_at,
        },
      }));

      res.setHeader('Content-Type', 'application/activity+json');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${outboxUrl}?page=${page}`,
        type: 'OrderedCollectionPage',
        partOf: outboxUrl,
        orderedItems: items,
        next: items.length === limit ? `${outboxUrl}?page=${page + 1}` : undefined,
      });
    }
  })
);

/**
 * POST /servers/:serverId/inbox - Receive Join/Leave/Message activities
 */
router.post(
  '/servers/:serverId/inbox',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;
    const activity = req.body;

    // Import dynamically to avoid circular deps
    const { processServerInboxActivity } = await import('./ServerInboxHandler.js');

    await processServerInboxActivity(serverId, activity);

    res.status(202).json({ message: 'Activity accepted' });
  })
);

export default router;

