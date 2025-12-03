/**
 * ServerDiscoveryService - Discover and fetch remote Harmony servers
 * 
 * Enables users to find and join servers on other Harmony instances
 */

import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { SignatureService } from '../activitypub/SignatureService.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

const router = Router();

// =============================================================================
// API ROUTES
// =============================================================================

/**
 * GET /servers/discover
 * Discover a remote server by URL or handle
 */
router.get(
  '/servers/discover',
  asyncHandler(async (req: Request, res: Response) => {
    const { url, handle } = req.query;

    if (!url && !handle) {
      return res.status(400).json({ error: 'Either url or handle is required' });
    }

    let serverData: any = null;

    if (url) {
      // Direct URL discovery
      serverData = await ServerDiscoveryService.fetchServerByUrl(url as string);
    } else if (handle) {
      // WebFinger discovery (format: server@domain.com or harmony://server@domain.com/name)
      serverData = await ServerDiscoveryService.discoverByWebFinger(handle as string);
    }

    if (!serverData) {
      return res.status(404).json({ error: 'Server not found' });
    }

    res.json({
      success: true,
      server: {
        id: serverData.id,
        name: serverData.name,
        description: serverData.summary || '',
        icon: serverData.icon?.url,
        memberCount: serverData.memberCount || 0,
        channels: (serverData['harmony:channels'] || []).map((c: any) => {
          // Map type to simple 'text', 'voice', or 'category'
          let type = 'text';
          if (c.type === 'harmony:VoiceChannel' || c.type === 1 || c.channelType === 'voice') {
            type = 'voice';
          } else if (c.type === 'harmony:Category' || c.type === 2 || c.channelType === 'category') {
            type = 'category';
          }
          return {
            id: c.id,
            localId: c.localId,
            name: c.name,
            type,
            category: c.category,
            categoryId: c.categoryId,
            order: c.order || c.position || 0,
          };
        }),
        inbox: serverData.inbox,
        discoverable: serverData.discoverable !== false,
      },
    });
  })
);

/**
 * POST /invites/resolve
 * Proxy invite resolution to a remote instance (avoids CORS)
 * Called by frontend when user pastes a remote invite link
 */
router.post(
  '/invites/resolve',
  asyncHandler(async (req: Request, res: Response) => {
    const { instance, code } = req.body;

    if (!instance || !code) {
      return res.status(400).json({ error: 'instance and code are required' });
    }

    logger.info(`🎟️ Proxying invite resolution: ${code} from ${instance}`);

    try {
      // Fetch invite info from the remote instance
      // Use /api/federation/invites/:code since remote instance also proxies through nginx
      const remoteResponse = await fetch(`https://${instance}/api/federation/invites/${code}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': `Harmony/${config.VERSION || '1.0.0'} (+https://${config.INSTANCE_DOMAIN})`,
        },
      });

      if (!remoteResponse.ok) {
        if (remoteResponse.status === 404) {
          return res.status(404).json({ error: 'Invite not found or expired' });
        }
        if (remoteResponse.status === 410) {
          return res.status(410).json({ error: 'Invite has expired or reached max uses' });
        }
        return res.status(remoteResponse.status).json({ 
          error: `Remote instance returned ${remoteResponse.status}` 
        });
      }

      const data = await remoteResponse.json();
      
      // Convert relative URLs to absolute URLs using the remote instance
      const makeAbsolute = (url: string | null | undefined): string | null => {
        if (!url) return null;
        if (url.startsWith('http://') || url.startsWith('https://')) return url;
        // Handle relative URLs - prefix with remote instance
        return `https://${instance}${url.startsWith('/') ? '' : '/'}${url}`;
      };

      // Fix server icon
      if (data.server?.icon) {
        data.server.icon = makeAbsolute(data.server.icon);
      }

      // Fix creator avatar if present
      if (data.createdBy?.avatar) {
        data.createdBy.avatar = makeAbsolute(data.createdBy.avatar);
      }

      // Fix server owner avatar if present
      if (data.server?.owner?.avatar_url) {
        data.server.owner.avatar_url = makeAbsolute(data.server.owner.avatar_url);
      }

      res.json(data);
    } catch (error: any) {
      logger.error(`Failed to resolve remote invite: ${error.message}`);
      return res.status(502).json({ error: 'Failed to connect to remote instance' });
    }
  })
);

/**
 * GET /invites/:code
 * Resolve an invite code and return server info
 * This endpoint is called by remote instances to validate invite links
 * Route is at /invites/:code so it works when nginx proxies /api/federation -> backend
 */
router.get(
  '/invites/:code',
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = req.params;
    const supabase = getSupabaseClient();

    // Find the invite
    const { data: invite, error: inviteError } = await supabase
      .from('invites')
      .select(`
        *,
        server:servers!invites_server_id_fkey(
          id, name, description, icon, public,
          owner:profiles!servers_owner_fkey(username, display_name, avatar_url)
        ),
        creator:profiles!invites_created_by_fkey(username, display_name, avatar_url)
      `)
      .eq('code', code)
      .single();

    if (inviteError || !invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    // Check if expired
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invite has expired' });
    }

    // Check if fully used
    if (invite.uses !== null && invite.max_uses !== null && invite.uses >= invite.max_uses) {
      return res.status(410).json({ error: 'Invite has reached maximum uses' });
    }

    const server = invite.server;
    const hostDomain = config.INSTANCE_DOMAIN;
    const supabaseUrl = config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL;

    // Helper to convert relative URLs to absolute
    // Handles both regular paths and Supabase storage paths
    const makeAbsolute = (url: string | null | undefined, bucket?: string): string | null => {
      if (!url) return null;
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      if (url.startsWith('blob:')) return null;
      
      // If bucket is specified, it's a Supabase storage path
      if (bucket) {
        // Format: uuid/uuid.webp -> full storage URL
        return `${supabaseUrl}/storage/v1/render/image/public/${bucket}/${url}?width=96&height=96&resize=contain&quality=80`;
      }
      
      // Regular path - use instance domain
      return `https://${hostDomain}${url.startsWith('/') ? '' : '/'}${url}`;
    };

    // Get member count
    const { count: memberCount } = await supabase
      .from('user_servers')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', server.id)
      .eq('status', 'accepted');

    // Get categories from channel_categories table
    const { data: categories } = await supabase
      .from('channel_categories')
      .select('id, name, order')
      .eq('server_id', server.id)
      .order('order', { ascending: true });

    // Get channels
    const { data: channels } = await supabase
      .from('channels')
      .select('id, name, type, category, order, description')
      .eq('server_id', server.id)
      .eq('is_remote', false)
      .order('order', { ascending: true });

    // Build channel structure with full AP IDs
    const serverApId = `https://${hostDomain}/servers/${server.id}`;
    
    // Convert categories to channel format (type = 'category')
    const categoryList = (categories || []).map(cat => ({
      id: `${serverApId}/channels/${cat.id}`,
      localId: cat.id,
      name: cat.name,
      type: 'category',
      category: null,
      categoryId: null,
      order: cat.order || 0,
      description: null,
    }));

    // Convert regular channels
    const channelList = (channels || []).map(c => ({
      id: `${serverApId}/channels/${c.id}`,
      localId: c.id,
      name: c.name,
      type: c.type === 1 ? 'voice' : 'text',
      category: c.category ? `${serverApId}/channels/${c.category}` : null,
      categoryId: c.category,
      order: c.order || 0,
      description: c.description,
    }));

    // Merge categories and channels
    const allChannels = [...categoryList, ...channelList];

    res.json({
      code: invite.code,
      expiresAt: invite.expires_at,
      maxUses: invite.max_uses,
      uses: invite.uses || 0,
      createdBy: invite.creator ? {
        username: invite.creator.username,
        displayName: invite.creator.display_name,
        avatar: makeAbsolute(invite.creator.avatar_url, 'avatars'),
      } : null,
      server: {
        id: serverApId,
        serverId: server.id,
        name: server.name,
        description: server.description || '',
        icon: makeAbsolute(server.icon, 'server_icons'),
        memberCount: memberCount || 0,
        channels: allChannels,
        inbox: `${serverApId}/inbox`,
      },
    });
  })
);

/**
 * POST /servers/join
 * Join a remote server
 */
router.post(
  '/servers/join',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverUrl, userId, inviteCode } = req.body;

    if (!serverUrl || !userId) {
      return res.status(400).json({ error: 'serverUrl and userId are required' });
    }

    const supabase = getSupabaseClient();

    // Verify user exists and is local
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('id, username, federated_id, inbox_url')
      .eq('id', userId)
      .eq('is_local', true)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Fetch remote server
    const remoteServer = await ServerDiscoveryService.fetchServerByUrl(serverUrl);
    if (!remoteServer) {
      return res.status(404).json({ error: 'Remote server not found' });
    }

    // Check if we already have a local reference
    let { data: localServer } = await supabase
      .from('servers')
      .select('*')
      .eq('ap_id', remoteServer.id)
      .single();

    if (!localServer) {
      // Create local reference
      localServer = await ServerDiscoveryService.createLocalServerReference(remoteServer);
    }

    // Check if already a member
    const { data: existingMembership } = await supabase
      .from('user_servers')
      .select('id, status')
      .eq('server_id', localServer.id)
      .eq('user_id', userId)
      .single();

    if (existingMembership) {
      return res.status(409).json({ 
        error: 'Already a member or pending',
        status: existingMembership.status 
      });
    }

    // Create pending membership
    const { error: membershipError } = await supabase
      .from('user_servers')
      .insert({
        server_id: localServer.id,
        user_id: userId,
        status: 'pending',
        member_instance: config.INSTANCE_DOMAIN,
      });

    if (membershipError) {
      logger.error('Failed to create membership:', membershipError);
      return res.status(500).json({ error: 'Failed to create membership' });
    }

    // Send Join activity to remote server
    const joinActivity = ServerDiscoveryService.createJoinActivity(
      user.federated_id || `https://${config.INSTANCE_DOMAIN}/users/${user.username}`,
      remoteServer.id,
      inviteCode as string | undefined
    );

    try {
      await ServerDiscoveryService.sendJoinRequest(
        remoteServer.inbox,
        joinActivity,
        userId
      );

      // Get default channel (first text channel, not a category)
      // Use maybeSingle() since there might be no channels yet
      const { data: defaultChannel } = await supabase
        .from('channels')
        .select('id')
        .eq('server_id', localServer.id)
        .eq('type', 0) // text channel
        .order('order', { ascending: true })
        .limit(1)
        .maybeSingle();

      logger.info(`🎯 Join complete: server=${localServer.id}, defaultChannel=${defaultChannel?.id || 'none'}`);

      res.json({
        success: true,
        message: 'Join request sent',
        serverId: localServer.id,
        defaultChannelId: defaultChannel?.id || null,
        status: 'pending',
      });
    } catch (error) {
      // Rollback membership
      await supabase
        .from('user_servers')
        .delete()
        .eq('server_id', localServer.id)
        .eq('user_id', userId);

      logger.error('Failed to send join request:', error);
      return res.status(500).json({ error: 'Failed to send join request' });
    }
  })
);

/**
 * POST /servers/leave
 * Leave a remote server
 */
router.post(
  '/servers/leave',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId, userId } = req.body;

    if (!serverId || !userId) {
      return res.status(400).json({ error: 'serverId and userId are required' });
    }

    const supabase = getSupabaseClient();

    // Get user
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id')
      .eq('id', userId)
      .eq('is_local', true)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get server
    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', serverId)
      .single();

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Remove local membership
    await supabase
      .from('user_servers')
      .delete()
      .eq('server_id', serverId)
      .eq('user_id', userId);

    // If remote server, send Leave activity
    if (!server.is_local_server && server.federation_inbox_url) {
      const leaveActivity = ServerDiscoveryService.createLeaveActivity(
        user.federated_id || `https://${config.INSTANCE_DOMAIN}/users/${user.username}`,
        server.ap_id
      );

      try {
        await ServerDiscoveryService.sendLeaveRequest(
          server.federation_inbox_url,
          leaveActivity,
          userId
        );
      } catch (error) {
        logger.warn('Failed to send leave activity (membership removed locally):', error);
      }
    }

    res.json({
      success: true,
      message: 'Left server successfully',
    });
  })
);

/**
 * GET /servers/:serverId/sync
 * Sync server metadata from remote
 */
router.get(
  '/servers/:serverId/sync',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;

    await ServerDiscoveryService.syncRemoteServer(serverId);

    res.json({ success: true, message: 'Server synced' });
  })
);

/**
 * GET /channels/:channelId/messages
 * Fetch messages from a remote channel
 */
router.get(
  '/channels/:channelId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const { channelId } = req.params;
    const { before, limit = 50 } = req.query;
    
    logger.info(`📥 GET /channels/${channelId}/messages (limit: ${limit}, before: ${before || 'none'})`);
    
    const supabase = getSupabaseClient();

    // Get channel info
    const { data: channel, error: channelError } = await supabase
      .from('channels')
      .select(`
        id, name, ap_id, is_remote,
        server:servers!channels_server_id_fkey(
          id, ap_id, is_local_server, federation_domain
        )
      `)
      .eq('id', channelId)
      .single();

    if (channelError || !channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // For local channels, just return local messages
    if (!channel.is_remote) {
      let query = supabase
        .from('messages')
        .select(`
          id, content, created_at, updated_at, metadata,
          author:profiles!messages_author_id_fkey(id, username, display_name, avatar_url, federated_id)
        `)
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(Number(limit));

      if (before) {
        query = query.lt('created_at', before);
      }

      const { data: messages } = await query;
      return res.json({ messages: messages || [], source: 'local' });
    }

    // For remote channels, fetch from the remote server
    const server = (channel as any).server;
    if (!server?.ap_id) {
      return res.status(400).json({ error: 'Remote server not properly configured' });
    }

    try {
      // Fetch from remote channel messages endpoint
      // Use /messages?page=1 format as that's what GroupService returns
      const channelMessagesUrl = `${channel.ap_id}/messages`;
      let fetchUrl = `${channelMessagesUrl}?page=1`;

      logger.info(`📨 Fetching messages from remote channel: ${fetchUrl}`);

      const response = await fetch(fetchUrl, {
        headers: {
          'Accept': 'application/activity+json, application/json',
          'User-Agent': `Harmony/${config.VERSION || '1.0.0'} (+https://${config.INSTANCE_DOMAIN})`,
        },
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch remote messages: ${response.status}`);
        // Fall back to local cached messages
        const { data: cachedMessages } = await supabase
          .from('messages')
          .select(`
            id, content, created_at, updated_at, metadata,
            author:profiles!messages_author_id_fkey(id, username, display_name, avatar_url, federated_id)
          `)
          .eq('channel_id', channelId)
          .order('created_at', { ascending: false })
          .limit(Number(limit));

        return res.json({ 
          messages: cachedMessages || [], 
          source: 'cache',
          error: 'Could not fetch from remote, showing cached messages'
        });
      }

      const data = await response.json();
      
      // Parse ActivityPub collection response
      const items = data.orderedItems || data.items || [];
      
      // Transform to our message format and cache locally
      const messages = await Promise.all(items.map(async (item: any) => {
        const activity = item.type === 'Create' ? item : { object: item };
        const note = activity.object;
        
        if (!note) return null;

        // Get author URL - can be from attributedTo or actor
        const authorUrl = note.attributedTo || activity.actor;
        
        let author: any = null;

        // Check if this is a valid author URL
        if (authorUrl && authorUrl !== 'undefined' && !authorUrl.endsWith('/undefined')) {
          // Ensure the author exists locally
          try {
            const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js');
            await ActivityProcessor['ensureRemoteUser'](authorUrl);

            // Get author from local DB
            const { data: authorData } = await supabase
              .from('profiles')
              .select('id, username, display_name, avatar_url, federated_id, color')
              .eq('federated_id', authorUrl)
              .maybeSingle();
            
            author = authorData;
          } catch (err) {
            logger.debug(`Could not fetch author ${authorUrl}: ${err}`);
          }
        }

        // For bridge messages (Discord, Matrix, etc.) without a valid author,
        // try to extract info from the note itself
        if (!author) {
          // Check if the note has author name in the content or signature
          const bridgeMatch = note.content?.match(/<strong>([^<]+)<\/strong>:/);
          const bridgeName = bridgeMatch?.[1] || note.name || 'External User';
          
          // Create a placeholder author for bridge messages
          author = {
            id: null,
            username: bridgeName.toLowerCase().replace(/\s+/g, '_'),
            display_name: bridgeName,
            avatar_url: null,
            federated_id: authorUrl || `bridge:${note.id}`,
            is_bridge: true,
          };
          
          logger.debug(`Using bridge author for message ${note.id}: ${bridgeName}`);
        }

        // Extract message UUID from ap_id if possible
        let messageUuid: string | undefined;
        const uuidMatch = note.id?.match(/\/messages\/([a-f0-9-]{36})$/i);
        if (uuidMatch) {
          messageUuid = uuidMatch[1];
        }

        // Cache message locally for reactions and offline access (only if we have a valid author ID)
        let cachedMsgId: string | null = null;
        
        if (author?.id && !author.is_bridge) {
          const messageData: any = {
            channel_id: channelId,
            user_id: author.id,
            content: note.content ? [{ type: 'text', text: note.content.replace(/<[^>]*>/g, '').trim() }] : [],
            created_at: note.published || new Date().toISOString(),
            updated_at: note.updated,
            metadata: { ap_id: note.id, is_remote: true },
          };

          if (messageUuid) {
            messageData.id = messageUuid;
          }

          // Upsert to avoid duplicates - use onConflict with id if we have UUID
          try {
            const { data: cachedMsg } = await supabase
              .from('messages')
              .upsert(messageData, {
                onConflict: 'id',
                ignoreDuplicates: true,
              })
              .select('id')
              .maybeSingle();
            
            cachedMsgId = cachedMsg?.id;
          } catch (cacheError: any) {
            logger.debug(`Could not cache message: ${cacheError.message}`);
          }
        }

        // Return the message regardless of caching success
        return {
          id: cachedMsgId || messageUuid || note.id,
          content: note.content,
          created_at: note.published,
          updated_at: note.updated,
          metadata: { 
            ap_id: note.id,
            is_bridge: author?.is_bridge || false,
          },
          author,
        };
      }));

      res.json({ 
        messages: messages.filter(Boolean), 
        source: 'remote' 
      });
    } catch (error: any) {
      logger.error('Error fetching remote messages:', error);
      
      // Fall back to local cached messages
      const { data: cachedMessages } = await supabase
        .from('messages')
        .select(`
          id, content, created_at, updated_at, metadata,
          author:profiles!messages_author_id_fkey(id, username, display_name, avatar_url, federated_id)
        `)
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(Number(limit));

      res.json({ 
        messages: cachedMessages || [], 
        source: 'cache',
        error: error.message 
      });
    }
  })
);

// =============================================================================
// SERVICE CLASS
// =============================================================================

export class ServerDiscoveryService {
  /**
   * Discover server by WebFinger
   * Formats supported:
   * - harmony://server@domain.com/server-name
   * - server@domain.com (for known servers)
   * - https://domain.com/servers/uuid (direct URL)
   */
  static async discoverByWebFinger(resource: string): Promise<any | null> {
    try {
      // Handle direct URL
      if (resource.startsWith('https://')) {
        return await this.fetchServerByUrl(resource);
      }

      // Parse harmony:// resource
      let domain: string;
      let serverIdentifier: string;

      const harmonyMatch = resource.match(/^harmony:\/\/server@([^/]+)\/(.+)$/);
      if (harmonyMatch) {
        domain = harmonyMatch[1];
        serverIdentifier = harmonyMatch[2];
      } else {
        // Try simple format: servername@domain.com
        const simpleMatch = resource.match(/^([^@]+)@(.+)$/);
        if (simpleMatch) {
          serverIdentifier = simpleMatch[1];
          domain = simpleMatch[2];
        } else {
          logger.warn('Invalid server resource format:', resource);
          return null;
        }
      }

      // WebFinger lookup
      const webfingerResource = `harmony://server@${domain}/${serverIdentifier}`;
      const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(webfingerResource)}`;

      const response = await fetch(webfingerUrl, {
        headers: {
          'Accept': 'application/jrd+json',
        },
      });

      if (!response.ok) {
        logger.warn(`WebFinger lookup failed for ${resource}: ${response.status}`);
        return null;
      }

      const data = await response.json();

      // Find ActivityPub link
      const apLink = data.links?.find(
        (link: any) => link.type === 'application/activity+json'
      );

      if (!apLink) {
        logger.warn('No ActivityPub link in WebFinger response');
        return null;
      }

      // Fetch server as ActivityPub Group
      return await this.fetchServerByUrl(apLink.href);
    } catch (error) {
      logger.error('Error discovering server via WebFinger:', error);
      return null;
    }
  }

  /**
   * Fetch server by direct ActivityPub URL
   */
  static async fetchServerByUrl(url: string): Promise<any | null> {
    try {
      logger.info(`🔍 Fetching remote server: ${url}`);

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch server: ${response.status}`);
        return null;
      }

      const server = await response.json();

      // Verify it's a Group (server)
      if (server.type !== 'Group') {
        logger.warn(`URL does not point to a Group: ${server.type}`);
        return null;
      }

      logger.info(`✅ Found remote server: ${server.name}`);
      return server;
    } catch (error) {
      logger.error('Error fetching server by URL:', error);
      return null;
    }
  }

  /**
   * Create local reference to remote server
   */
  static async createLocalServerReference(remoteServer: any): Promise<any> {
    const supabase = getSupabaseClient();

    try {
      const serverUrl = new URL(remoteServer.id);
      const hostDomain = serverUrl.hostname;

      // Extract channels from Harmony extension
      const channels = remoteServer['harmony:channels'] || [];

      // Check if server reference already exists
      const { data: existing } = await supabase
        .from('servers')
        .select('*')
        .eq('ap_id', remoteServer.id)
        .single();

      if (existing) {
        logger.info(`Server reference already exists: ${remoteServer.name}`);
        return existing;
      }

      // Extract server UUID from AP ID if possible
      // Format: https://instance.com/servers/{uuid}
      let serverUuid: string | undefined;
      const serverIdMatch = remoteServer.id.match(/\/servers\/([a-f0-9-]{36})$/i);
      if (serverIdMatch) {
        serverUuid = serverIdMatch[1];
      }

      // Create server reference (use remote UUID if available to maintain consistency)
      const serverInsertData: any = {
        name: remoteServer.name,
        description: remoteServer.summary || '',
        icon: remoteServer.icon?.url,
        federation_enabled: true,
        federation_domain: hostDomain,
        ap_id: remoteServer.id,
        federation_inbox_url: remoteServer.inbox,
        is_local_server: false,
        host_domain: hostDomain,
        public: remoteServer.discoverable !== false,
        federation_metadata: {
          outbox: remoteServer.outbox,
          members: remoteServer.members,
          followers: remoteServer.followers,
          attributedTo: remoteServer.attributedTo,
          fetched_at: new Date().toISOString(),
        },
      };

      // Use remote server UUID if extracted (for consistency)
      if (serverUuid) {
        serverInsertData.id = serverUuid;
      }

      const { data: serverRef, error: serverError } = await supabase
        .from('servers')
        .insert(serverInsertData)
        .select()
        .single();

      if (serverError) {
        logger.error('Failed to create server reference:', serverError);
        throw serverError;
      }

      logger.info(`✅ Created local reference for remote server: ${remoteServer.name} (id: ${serverRef.id})`);

      // Helper to extract UUID from AP ID
      const extractUuid = (apId: string): string | null => {
        const match = apId.match(/\/channels\/([a-f0-9-]{36})$/i);
        return match ? match[1] : null;
      };

      // Map to track category AP IDs to local UUIDs
      const categoryMap = new Map<string, string>();

      // First pass: Create categories in channel_categories table (NOT channels table!)
      // Local servers use channel_categories table, so federated servers must too
      // Handles multiple type formats: 'category', 2, 'harmony:Category', or channelType: 'category'
      const categories = channels.filter((c: any) => 
        c.type === 'category' || 
        c.type === 2 || 
        c.type === 'harmony:Category' ||
        c.channelType === 'category'
      );
      
      for (const cat of categories) {
        const catUuid = cat.localId || extractUuid(cat.id);
        const insertData: any = {
          server_id: serverRef.id,
          name: cat.name,
          order: cat.order || cat.position || 0,
          // Note: channel_categories table doesn't have ap_id or is_remote columns
          // We track the mapping in memory during this transaction
        };
        
        // Use remote UUID if available for consistency
        if (catUuid) {
          insertData.id = catUuid;
        }

        const { data: catRef, error: catError } = await supabase
          .from('channel_categories')
          .insert(insertData)
          .select('id')
          .single();

        if (catError) {
          logger.error(`Failed to create category ${cat.name}:`, catError);
        } else if (catRef) {
          logger.info(`📁 Created category: ${cat.name} (id: ${catRef.id})`);
          categoryMap.set(cat.id, catRef.id);
          if (cat.localId) {
            categoryMap.set(cat.localId, catRef.id);
          }
        }
      }

      // Second pass: Create regular channels (text/voice) in channels table
      // Excludes categories in all format variations
      const isCategory = (c: any) => 
        c.type === 'category' || 
        c.type === 2 || 
        c.type === 'harmony:Category' ||
        c.channelType === 'category';
      
      const regularChannels = channels.filter((c: any) => !isCategory(c));

      for (const channelData of regularChannels) {
        const channelUuid = channelData.localId || extractUuid(channelData.id);
        // Detect voice channels from multiple format variations
        const isVoice = 
          channelData.type === 'voice' || 
          channelData.type === 1 || 
          channelData.type === 'harmony:VoiceChannel' ||
          channelData.channelType === 'voice';
        const channelType = isVoice ? 1 : 0;

        // Resolve category reference - look up in our categoryMap
        let categoryId = null;
        if (channelData.category) {
          categoryId = categoryMap.get(channelData.category);
        } else if (channelData.categoryId) {
          categoryId = categoryMap.get(channelData.categoryId) || channelData.categoryId;
        }

        const insertData: any = {
          server_id: serverRef.id,
          name: channelData.name,
          type: channelType,
          order: channelData.order || channelData.position || 0,
          ap_id: channelData.id,
          is_remote: true,
          category: categoryId,
          description: channelData.description,
        };

        // Use remote UUID for consistency - this ensures messages can be linked
        if (channelUuid) {
          insertData.id = channelUuid;
        }

        const { error: channelError } = await supabase.from('channels').insert(insertData);
        if (channelError) {
          logger.error(`Failed to create channel ${channelData.name}:`, channelError);
        } else {
          logger.info(`📝 Created channel: ${channelData.name} (type: ${channelType}, category: ${categoryId})`);
        }
      }

      logger.info(`✅ Created ${regularChannels.length} channels and ${categories.length} categories for remote server`);

      return serverRef;
    } catch (error) {
      logger.error('Error creating local server reference:', error);
      throw error;
    }
  }

  /**
   * Create a Join activity
   */
  static createJoinActivity(actorId: string, serverId: string, inviteCode?: string): any {
    const activity: any = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          'harmony': 'https://harmonyapp.dev/ns#',
        },
      ],
      id: `${actorId}/activities/${crypto.randomUUID()}`,
      type: 'Join',
      actor: actorId,
      object: serverId,
      published: new Date().toISOString(),
    };

    // Include invite code if provided (for private servers)
    if (inviteCode) {
      activity['harmony:inviteCode'] = inviteCode;
    }

    return activity;
  }

  /**
   * Create a Leave activity
   */
  static createLeaveActivity(actorId: string, serverId: string): any {
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          'harmony': 'https://harmonyapp.dev/ns#',
        },
      ],
      id: `${actorId}/activities/${crypto.randomUUID()}`,
      type: 'Leave',
      actor: actorId,
      object: serverId,
      published: new Date().toISOString(),
    };
  }

  /**
   * Send Join request to remote server
   */
  static async sendJoinRequest(
    inboxUrl: string,
    activity: any,
    senderId: string
  ): Promise<void> {
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    await DeliveryQueue.sendToInbox(inboxUrl, activity, senderId);
    logger.info(`📤 Sent Join request to ${inboxUrl}`);
  }

  /**
   * Send Leave request to remote server
   */
  static async sendLeaveRequest(
    inboxUrl: string,
    activity: any,
    senderId: string
  ): Promise<void> {
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    await DeliveryQueue.sendToInbox(inboxUrl, activity, senderId);
    logger.info(`📤 Sent Leave request to ${inboxUrl}`);
  }

  /**
   * Sync server metadata from remote
   */
  static async syncRemoteServer(serverId: string): Promise<void> {
    const supabase = getSupabaseClient();

    try {
      // Get server reference
      const { data: server } = await supabase
        .from('servers')
        .select('*')
        .eq('id', serverId)
        .eq('is_local_server', false)
        .single();

      if (!server || !server.ap_id) {
        logger.warn('Server not found or not remote');
        return;
      }

      // Fetch latest from remote
      const remoteServer = await this.fetchServerByUrl(server.ap_id);

      if (!remoteServer) {
        logger.warn('Failed to fetch remote server');
        return;
      }

      // Update local reference
      await supabase
        .from('servers')
        .update({
          name: remoteServer.name,
          description: remoteServer.summary,
          icon: remoteServer.icon?.url,
          public: remoteServer.discoverable !== false,
          federation_metadata: {
            ...server.federation_metadata,
            outbox: remoteServer.outbox,
            members: remoteServer.members,
            followers: remoteServer.followers,
            synced_at: new Date().toISOString(),
          },
        })
        .eq('id', serverId);

      // Sync channels
      const remoteChannels = remoteServer['harmony:channels'] || [];
      
      // Helper to determine channel type
      const getChannelType = (c: any): number => {
        if (c.type === 'harmony:Category' || c.type === 2 || c.channelType === 'category') {
          return 2; // category
        }
        if (c.type === 'harmony:VoiceChannel' || c.type === 1 || c.channelType === 'voice') {
          return 1; // voice
        }
        return 0; // text
      };

      for (const channelData of remoteChannels) {
        const channelType = getChannelType(channelData);

        // Upsert channel
        await supabase
          .from('channels')
          .upsert({
            server_id: serverId,
            name: channelData.name,
            type: channelType,
            order: channelData.position || channelData.order || 0,
            ap_id: channelData.id,
            is_remote: true,
            category: channelData.categoryId || null,
          }, {
            onConflict: 'ap_id',
          });
      }

      logger.info(`✅ Synced remote server: ${remoteServer.name}`);
    } catch (error) {
      logger.error('Error syncing remote server:', error);
    }
  }

  /**
   * Get or create local server reference by AP ID
   */
  static async getOrCreateServerReference(apId: string): Promise<any | null> {
    const supabase = getSupabaseClient();

    // Check if exists
    const { data: existing } = await supabase
      .from('servers')
      .select('*')
      .eq('ap_id', apId)
      .single();

    if (existing) {
      return existing;
    }

    // Fetch and create
    const remoteServer = await this.fetchServerByUrl(apId);
    if (!remoteServer) {
      return null;
    }

    return await this.createLocalServerReference(remoteServer);
  }
}

export default router;
