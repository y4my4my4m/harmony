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
        channels: (serverData['harmony:channels'] || []).map((c: any) => ({
          id: c.id,
          name: c.name,
          type: c.type === 'harmony:VoiceChannel' ? 'voice' : 'text',
        })),
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
      const remoteResponse = await fetch(`https://${instance}/api/invites/${code}`, {
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
      
      // Pass through the response from the remote instance
      res.json(data);
    } catch (error: any) {
      logger.error(`Failed to resolve remote invite: ${error.message}`);
      return res.status(502).json({ error: 'Failed to connect to remote instance' });
    }
  })
);

/**
 * GET /api/invites/:code
 * Resolve an invite code and return server info
 * This endpoint is called by remote instances to validate invite links
 */
router.get(
  '/api/invites/:code',
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

    // Get member count
    const { count: memberCount } = await supabase
      .from('user_servers')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', server.id)
      .eq('status', 'accepted');

    // Get channels
    const { data: channels } = await supabase
      .from('channels')
      .select('id, name, type')
      .eq('server_id', server.id)
      .eq('is_remote', false)
      .order('order', { ascending: true });

    res.json({
      code: invite.code,
      expiresAt: invite.expires_at,
      maxUses: invite.max_uses,
      uses: invite.uses || 0,
      createdBy: invite.creator ? {
        username: invite.creator.username,
        displayName: invite.creator.display_name,
        avatar: invite.creator.avatar_url,
      } : null,
      server: {
        id: `https://${hostDomain}/servers/${server.id}`,
        serverId: server.id,
        name: server.name,
        description: server.description || '',
        icon: server.icon,
        memberCount: memberCount || 0,
        channels: (channels || []).map(c => ({
          id: c.id,
          name: c.name,
          type: c.type === 1 ? 'voice' : 'text',
        })),
        inbox: `https://${hostDomain}/servers/${server.id}/inbox`,
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

      res.json({
        success: true,
        message: 'Join request sent',
        serverId: localServer.id,
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

      // Create server reference
      const { data: serverRef, error: serverError } = await supabase
        .from('servers')
        .insert({
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
        })
        .select()
        .single();

      if (serverError) {
        logger.error('Failed to create server reference:', serverError);
        throw serverError;
      }

      logger.info(`✅ Created local reference for remote server: ${remoteServer.name}`);

      // Create channel references
      for (const channelData of channels) {
        const channelType = channelData.type === 'harmony:VoiceChannel' || 
                           channelData.type === 'VoiceChannel' ? 1 : 0; // 0 = text, 1 = voice

        await supabase.from('channels').insert({
          server_id: serverRef.id,
          name: channelData.name,
          type: channelType,
          order: channelData.position || 0,
          ap_id: channelData.id,
          is_remote: true,
        });
      }

      logger.info(`✅ Created ${channels.length} channel references`);

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
      for (const channelData of remoteChannels) {
        const channelType = channelData.type === 'harmony:VoiceChannel' || 
                           channelData.type === 'VoiceChannel' ? 1 : 0;

        // Upsert channel
        await supabase
          .from('channels')
          .upsert({
            server_id: serverId,
            name: channelData.name,
            type: channelType,
            order: channelData.position || 0,
            ap_id: channelData.id,
            is_remote: true,
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
