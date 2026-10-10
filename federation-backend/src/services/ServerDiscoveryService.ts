/**
 * ServerDiscoveryService - discovery, join and sync for servers hosted on
 * other Harmony instances.
 */

import { Router, Request, Response } from 'express';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { stripIncomingMediaPaths } from '../utils/privateMedia.js';
import { withoutPollParts } from '../utils/polls.js';
import { normalizeInboundMentions, actorHostname } from '../utils/mentionParts.js';
import config from '../config/index.js';
import { validateExternalHostname, safeFetch } from '../utils/ssrfProtection.js';
import { discoveryLimiter } from '../middleware/rateLimit.js';
import { sameOrigin, urlHost } from '../utils/apOrigin.js';
import { SignatureService } from '../activitypub/SignatureService.js';
import { loadGroupAccess } from '../activitypub/groupAccess.js';
import { localProfileIdFromBearer } from '../middleware/auth.js';
import { INVITE_REFUSALS } from '../utils/inviteRefusals.js';
import {
  getFullAvatarUrl,
  getFullServerBannerUrl,
  getFullServerIconUrl,
  isDefaultServerIcon,
} from '../utils/urlUtils.js';

const router = Router();

// API ROUTES

/**
 * GET /servers/discover
 * Discover a remote server by URL or handle
 */
router.get(
  '/servers/discover',
  discoveryLimiter,
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

    return res.json({
      success: true,
      server: {
        id: serverData.id,
        name: serverData.name,
        description: serverData.summary || '',
        icon: serverData.icon?.url ?? null,
        banner: serverData.image?.url || null,
        memberCount: serverData.memberCount ?? serverData['harmony:memberCount'] ?? 0,
        channels: (serverData['harmony:channels'] || []).map((c: any) => {
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
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { instance, code } = req.body;

    if (!instance || !code) {
      return res.status(400).json({ error: 'instance and code are required' });
    }

    try {
      validateExternalHostname(instance);
    } catch (err: any) {
      return res.status(400).json({ error: `Invalid instance: ${err.message}` });
    }

    logger.info(`Proxying invite resolution: ${code} from ${instance}`);

    try {
      // Fetch invite info from the remote instance
      // Use /api/federation/invites/:code since remote instance also proxies through nginx
      const remoteResponse = await safeFetch(`https://${instance}/api/federation/invites/${code}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': `Harmony/${config.VERSION} (+https://${config.INSTANCE_DOMAIN})`,
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

      // The invite blob is attacker-controlled JSON. Before rendering a
      // preview, confirm the advertised server is a genuine ActivityPub Group
      // actor on the same instance the invite came from: a hostile host can
      // then neither fake the card nor point at someone else's real Group.
      // safeFetch (inside fetchServerByUrl) re-guards SSRF.
      const actorId: unknown = data?.server?.id;
      let actorVerified = false;
      if (typeof actorId === 'string') {
        try {
          const actorHost = new URL(actorId).host.toLowerCase();
          if (actorHost === instance.toLowerCase()) {
            const actor = await ServerDiscoveryService.fetchServerByUrl(actorId);
            if (actor) {
              // If the actor declares an inbox it must live on the same host too
              const inbox = actor.inbox || data?.server?.inbox;
              const inboxHost = inbox
                ? new URL(inbox, `https://${instance}`).host.toLowerCase()
                : actorHost;
              actorVerified = inboxHost === actorHost;
            }
          }
        } catch {
          actorVerified = false;
        }
      }

      if (!actorVerified) {
        logger.warn(`Invite actor verification failed: code=${code} instance=${instance} id=${String(actorId)}`);
        return res.status(422).json({
          error: 'Could not verify this as a genuine federated server',
        });
      }

      // Convert relative URLs to absolute URLs using the remote instance
      const makeAbsolute = (url: string | null | undefined): string | null => {
        if (!url) return null;
        if (url.startsWith('http://') || url.startsWith('https://')) return url;
        // Handle relative URLs - prefix with remote instance
        return `https://${instance}${url.startsWith('/') ? '' : '/'}${url}`;
      };

      // Fix server icon - omit default so remote UIs use their own fallback
      if (data.server?.icon) {
        data.server.icon = isDefaultServerIcon(data.server.icon)
          ? null
          : makeAbsolute(data.server.icon);
      }

      // Fix creator avatar if present
      if (data.createdBy?.avatar) {
        data.createdBy.avatar = makeAbsolute(data.createdBy.avatar);
      }

      // Fix server owner avatar if present
      if (data.server?.owner?.avatar_url) {
        data.server.owner.avatar_url = makeAbsolute(data.server.owner.avatar_url);
      }

      return res.json(data);
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
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = req.params;
    const supabase = getSupabaseClient();

    const { data: invite, error: inviteError } = await supabase
      .from('invites')
      .select(`
        *,
        server:servers!invites_server_id_fkey(
          id, name, description, icon, banner, public, rules,
          owner:profiles!servers_owner_fkey(username, display_name, avatar_url)
        ),
        creator:profiles!invites_created_by_fkey(username, display_name, avatar_url)
      `)
      .eq('code', code)
      .single();

    if (inviteError || !invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invite has expired' });
    }

    if (invite.max_uses > 0 && (invite.uses ?? 0) >= invite.max_uses) {
      return res.status(410).json({ error: 'Invite has reached maximum uses' });
    }

    // used marks a revoked invite, or one spent at its limit (checked above).
    if (invite.used) {
      return res.status(410).json({ error: 'Invite has been revoked' });
    }

    const server = invite.server;
    const hostDomain = config.INSTANCE_DOMAIN;

    const { count: memberCount } = await supabase
      .from('user_servers')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', server.id)
      .eq('status', 'accepted');

    const { data: categories } = await supabase
      .from('channel_categories')
      .select('id, name, order')
      .eq('server_id', server.id)
      .order('order', { ascending: true });

    const { data: channels } = await supabase
      .from('channels')
      .select('id, name, type, category, order, description')
      .eq('server_id', server.id)
      .not('is_remote', 'is', true)
      .order('order', { ascending: true });

    const serverApId = `https://${hostDomain}/servers/${server.id}`;

    // The invite holder joins as @everyone: the preview lists what @everyone
    // can view, and a category only when it holds such a channel or none.
    const access = await loadGroupAccess(server.id, null);
    const everyoneIds = access?.everyoneChannelIds ?? new Set<string>();
    const listed = (channels || []).filter(c => everyoneIds.has(c.id));
    const listedCategoryIds = new Set(listed.map(c => c.category).filter(Boolean));
    const occupiedCategoryIds = new Set((channels || []).map(c => c.category).filter(Boolean));

    const categoryList = (categories || [])
      .filter(cat => listedCategoryIds.has(cat.id) || !occupiedCategoryIds.has(cat.id))
      .map(cat => ({
        id: `${serverApId}/channels/${cat.id}`,
        localId: cat.id,
        name: cat.name,
        type: 'category',
        category: null,
        categoryId: null,
        order: cat.order || 0,
        description: null,
      }));

    const channelList = listed.map(c => ({
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

    // rules travel with the invite so remote clients can show them pre-join
    const serverRules = Array.isArray(server.rules)
      ? server.rules.filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];

    let instanceRules: string[] = [];
    const { data: instanceRulesRow } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'instance_rules')
      .maybeSingle();
    if (Array.isArray(instanceRulesRow?.config_value)) {
      instanceRules = instanceRulesRow.config_value.filter(
        (r: unknown): r is string => typeof r === 'string' && r.trim().length > 0
      );
    }

    return res.json({
      code: invite.code,
      expiresAt: invite.expires_at,
      maxUses: invite.max_uses,
      uses: invite.uses || 0,
      instanceRules,
      createdBy: invite.creator ? {
        username: invite.creator.username,
        displayName: invite.creator.display_name,
        avatar: getFullAvatarUrl(invite.creator.avatar_url),
      } : null,
      server: {
        id: serverApId,
        serverId: server.id,
        name: server.name,
        description: server.description || '',
        icon: getFullServerIconUrl(server.icon),
        banner: getFullServerBannerUrl(server.banner),
        memberCount: memberCount || 0,
        rules: serverRules,
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
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { serverUrl, userId, inviteCode } = req.body;

    if (!serverUrl || !userId) {
      return res.status(400).json({ error: 'serverUrl and userId are required' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization required' });
    }
    const supabaseAuth = getSupabaseClientWithAuth(authHeader.substring(7));
    const { data: { user: authUser }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !authUser) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const supabase = getSupabaseClient();

    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('id, username, federated_id, inbox_url')
      .eq('id', userId)
      .eq('auth_user_id', authUser.id)
      .eq('is_local', true)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const remoteServer = await ServerDiscoveryService.fetchServerByUrl(serverUrl);
    if (!remoteServer) {
      return res.status(404).json({ error: 'Remote server not found' });
    }

    // Check if we already have a local reference (by ap_id or by UUID extracted from URL)
    let { data: localServer } = await supabase
      .from('servers')
      .select('*')
      .eq('ap_id', remoteServer.id)
      .single();

    if (!localServer) {
      // Also check by UUID for same-instance servers that don't have ap_id set.
      // Only ids on this instance name a local row; a remote Group reusing a
      // local server's UUID would otherwise be joined, and its member list
      // synced, into that local server.
      const isOwnInstance = urlHost(remoteServer.id) === config.INSTANCE_DOMAIN.toLowerCase();
      const uuidMatch = isOwnInstance ? remoteServer.id.match(/\/servers\/([a-f0-9-]{36})$/i) : null;
      if (uuidMatch) {
        const { data: serverById } = await supabase
          .from('servers')
          .select('*')
          .eq('id', uuidMatch[1])
          .single();
        if (serverById) {
          localServer = serverById;
        }
      }
    }

    if (!localServer) {
      localServer = await ServerDiscoveryService.createLocalServerReference(remoteServer, userId);
    }

    const { data: existingMembership } = await supabase
      .from('user_servers')
      .select('id, status')
      .eq('server_id', localServer.id)
      .eq('user_id', userId)
      .single();

    // A server on this instance admits directly: a Join to our own Group has
    // no remote to answer it, and the row would stay pending.
    if (localServer.is_local_server !== false) {
      if (existingMembership && existingMembership.status !== 'pending') {
        return res.status(409).json({ error: 'Already a member', status: existingMembership.status });
      }

      if (!localServer.public) {
        if (typeof inviteCode !== 'string' || !inviteCode) {
          return res.status(403).json({ error: 'Private server requires invite code' });
        }
        const { data: refusal, error: inviteError } = await supabase.rpc('consume_invite', {
          p_server_id: localServer.id,
          p_code: inviteCode,
        });
        if (inviteError || refusal) {
          const reason = inviteError ? 'Invalid invite code' : INVITE_REFUSALS[refusal as string] ?? 'Invalid invite code';
          return res.status(403).json({ error: reason });
        }
      }

      const { error: localJoinError } = existingMembership
        ? await supabase.from('user_servers').update({ status: 'accepted' }).eq('id', existingMembership.id)
        : await supabase.from('user_servers').insert({
            server_id: localServer.id,
            user_id: userId,
            status: 'accepted',
            member_instance: config.INSTANCE_DOMAIN,
          });
      if (localJoinError) {
        logger.error('Failed to create local membership:', localJoinError);
        return res.status(500).json({ error: 'Failed to create membership' });
      }

      const { data: localDefaultChannel } = await supabase
        .from('channels')
        .select('id')
        .eq('server_id', localServer.id)
        .eq('type', 0)
        .order('order', { ascending: true })
        .limit(1)
        .maybeSingle();

      logger.info(`Local join: server=${localServer.id}, user=${userId}`);
      return res.json({
        success: true,
        message: 'Joined server',
        serverId: localServer.id,
        defaultChannelId: localDefaultChannel?.id || null,
        status: 'accepted',
      });
    }

    if (existingMembership) {
      return res.status(409).json({ 
        error: 'Already a member or pending',
        status: existingMembership.status 
      });
    }

    // Public servers: accept immediately so the user can interact right away.
    // Private servers: stay pending until we get an Accept from the remote.
    const isPublicServer = localServer.public !== false && remoteServer.discoverable !== false;
    const initialStatus = isPublicServer ? 'accepted' : 'pending';

    const { error: membershipError } = await supabase
      .from('user_servers')
      .insert({
        server_id: localServer.id,
        user_id: userId,
        status: initialStatus,
        member_instance: config.INSTANCE_DOMAIN,
      });

    if (membershipError) {
      logger.error('Failed to create membership:', membershipError);
      return res.status(500).json({ error: 'Failed to create membership' });
    }

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

      // A private Group lists channels only to members, and the reference
      // was built from what a non-member sees. Delivery is attempted inline,
      // so a host that admits on receipt already counts this user a member.
      if (!localServer.is_local_server) {
        await ServerDiscoveryService.syncRemoteServer(localServer.id, { asUserId: userId });
      }

      const { data: defaultChannel } = await supabase
        .from('channels')
        .select('id')
        .eq('server_id', localServer.id)
        .eq('type', 0)
        .order('order', { ascending: true })
        .limit(1)
        .maybeSingle();

      logger.info(`Join complete: server=${localServer.id}, status=${initialStatus}, defaultChannel=${defaultChannel?.id || 'none'}`);

      // A local server's members are its own rows; only remote references
      // mirror a remote member list.
      if (remoteServer.members && !localServer.is_local_server) {
        ServerDiscoveryService.syncRemoteServerMembers(localServer.id, remoteServer.members)
          .catch(err => logger.error('Failed to sync remote members:', err));
      }

      return res.json({
        success: true,
        message: isPublicServer ? 'Joined server' : 'Join request sent',
        serverId: localServer.id,
        defaultChannelId: defaultChannel?.id || null,
        status: initialStatus,
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
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId, userId } = req.body;

    if (!serverId || !userId) {
      return res.status(400).json({ error: 'serverId and userId are required' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization required' });
    }
    const supabaseAuth = getSupabaseClientWithAuth(authHeader.substring(7));
    const { data: { user: authUser }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !authUser) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const supabase = getSupabaseClient();

    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id')
      .eq('id', userId)
      .eq('auth_user_id', authUser.id)
      .eq('is_local', true)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', serverId)
      .single();

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

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

    return res.json({
      success: true,
      message: 'Left server successfully',
    });
  })
);

/**
 * GET /servers/:serverId/sync
 * Sync server metadata from remote, signed as the requester when a bearer
 * token names a local member of the server, else as any local member.
 */
router.get(
  '/servers/:serverId/sync',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;

    const requesterId = await localProfileIdFromBearer(req.headers.authorization);
    const asUserId = requesterId && await ServerDiscoveryService.isAcceptedMember(serverId, requesterId)
      ? requesterId
      : undefined;

    await ServerDiscoveryService.syncRemoteServer(serverId, { asUserId });

    return res.json({ success: true, message: 'Server synced' });
  })
);

/**
 * GET /channels/:channelId/messages
 * Messages of a remote channel, fetched from its host with a GET signed as
 * the requesting local user. The host decides what that user may read.
 */
router.get(
  '/channels/:channelId/messages',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { channelId } = req.params;
    const { before, limit = 50 } = req.query;
    
    logger.info(`GET /channels/${channelId}/messages (limit: ${limit}, before: ${before || 'none'})`);

    const requesterId = await localProfileIdFromBearer(req.headers.authorization);
    if (!requesterId) {
      return res.status(401).json({ error: 'Authorization required' });
    }
    
    const supabase = getSupabaseClient();

    const { data: channel, error: channelError } = await supabase
      .from('channels')
      .select(`
        id, name, ap_id, is_remote,
        server:servers!channels_server_id_fkey(
          id, ap_id, is_local_server, federation_domain
        )
      `)
      .eq('id', channelId)
      .maybeSingle();

    if (channelError || !channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Local channels are read by clients through Supabase under RLS; this
    // route reads with the service role.
    if (!channel.is_remote) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // The GET carries the requester's signature, so it goes only to a channel
    // under the server's own Group.
    const server = (channel as any).server;
    if (!server?.ap_id || typeof channel.ap_id !== 'string' || !channel.ap_id.startsWith(`${server.ap_id}/channels/`)) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const { data: membership } = await supabase
      .from('user_servers')
      .select('status')
      .eq('server_id', server.id)
      .eq('user_id', requesterId)
      .maybeSingle();

    // Pending counts: the host holds the authoritative membership, and a
    // local row stays pending until its Accept arrives.
    if (!membership || (membership.status !== 'accepted' && membership.status !== 'pending')) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Cached rows are served only to an accepted member, and only when the
    // host could not be reached; a refusal from the host is final.
    const serveCache = async (reason: string) => {
      if (membership.status !== 'accepted') {
        return res.status(502).json({ error: reason });
      }
      const { data: cachedMessages } = await supabase
        .from('messages')
        .select(`
          id, content, created_at, updated_at, metadata,
          author:profiles!messages_user_id_fkey(id, username, display_name, avatar_url, federated_id)
        `)
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(Number(limit));

      return res.json({
        messages: cachedMessages || [],
        source: 'cache',
        error: reason,
      });
    };

    try {
      // GroupService serves the collection page at /messages?page=N.
      const fetchUrl = `${channel.ap_id}/messages?page=1`;

      logger.info(`Fetching messages from remote channel: ${fetchUrl}`);

      // BUGS.md H15: fetchUrl is constructed from remote AP response data;
      // signedApFetch goes through safeFetch.
      const response = await SignatureService.signedApFetch(fetchUrl, {
        headers: {
          'Accept': 'application/activity+json, application/json',
          'User-Agent': `Harmony/${config.VERSION} (+https://${config.INSTANCE_DOMAIN})`,
        },
        timeoutMs: 10000,
        signAs: requesterId,
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch remote messages: ${response.status}`);
        if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) {
          return res.status(404).json({ error: 'Channel not found' });
        }
        return serveCache('Could not fetch from remote, showing cached messages');
      }

      const data = await response.json();
      
      const items = data.orderedItems || data.items || [];
      
      // Deduplicate author URLs to avoid fetching the same user multiple times
      const uniqueAuthorUrls = new Set<string>();
      for (const item of items) {
        const activity = item.type === 'Create' ? item : { object: item };
        const note = activity.object;
        if (!note) continue;
        
        const authorUrl = note.attributedTo || activity.actor;
        if (authorUrl && authorUrl !== 'undefined' && !authorUrl.endsWith('/undefined')) {
          uniqueAuthorUrls.add(authorUrl);
        }
      }

      // Fetch all unique authors in parallel.
      // ensureRemoteUser returns the profile directly.
      const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js');
      const authorMap = new Map<string, any>();
      
      const fetchResults = await Promise.all(Array.from(uniqueAuthorUrls).map(async (url) => {
        try {
          const profile = await ActivityProcessor['ensureRemoteUser'](url);
          if (profile) {
            logger.debug(`Got profile for ${url}: id=${profile.id}, username=${profile.username}`);
            return { url, profile };
          } else {
            logger.warn(`ensureRemoteUser returned null for ${url}`);
            return null;
          }
        } catch (err) {
          logger.warn(`Could not fetch author ${url}: ${err}`);
          return null;
        }
      }));
      
      for (const result of fetchResults) {
        if (result && result.profile) {
          const { url, profile } = result;
          authorMap.set(url, profile);
          authorMap.set(url.toLowerCase(), profile);
          if (profile.federated_id && profile.federated_id !== url) {
            authorMap.set(profile.federated_id, profile);
            authorMap.set(profile.federated_id.toLowerCase(), profile);
          }
          logger.debug(`Mapped author: ${url} -> ${profile.username}`);
        }
      }
      
      logger.info(`Author map has ${authorMap.size} entries for ${uniqueAuthorUrls.size} unique URLs`);

      // Transform messages using the cached author data
      const messages = await Promise.all(items.map(async (item: any) => {
        const activity = item.type === 'Create' ? item : { object: item };
        const note = activity.object;
        
        if (!note) return null;

        const authorUrl = note.attributedTo || activity.actor;
        
        let author = authorMap.get(authorUrl) || 
                     authorMap.get(authorUrl?.toLowerCase()) || 
                     null;

        // For bridge messages (Discord, Matrix, etc.) or messages without a valid author,
        // try to extract info from the note itself
        if (!author) {
          // Check if the note has author name in the content or signature
          // Common bridge patterns:
          // - <strong>Username</strong>: message
          // - **Username**: message
          // - [Username]: message
          const bridgeMatch = note.content?.match(/<strong>([^<]+)<\/strong>:/) ||
                              note.content?.match(/\*\*([^*]+)\*\*:/) ||
                              note.content?.match(/^\[([^\]]+)\]:?/);
          const bridgeName = bridgeMatch?.[1] || note.name || 'External User';
          
          author = {
            id: null,
            username: bridgeName.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 30),
            display_name: bridgeName,
            avatar_url: null,
            federated_id: authorUrl || `bridge:${note.id}`,
            is_bridge: true,
          };
          
          // Only log as debug if we have an authorUrl (expected case for bridges)
          if (!authorUrl || authorUrl.includes('/undefined')) {
            logger.debug(`Bridge message ${note.id}: ${bridgeName}`);
          } else {
            logger.warn(`Author not found for ${authorUrl}, using bridge fallback: ${bridgeName}`);
          }
        }

        let messageUuid: string | undefined;
        const uuidMatch = note.id?.match(/\/messages\/([a-f0-9-]{36})$/i);
        if (uuidMatch) {
          messageUuid = uuidMatch[1];
        }

        // Cache message locally for reactions and offline access (only if we have a valid author ID)
        let cachedMsgId: string | null = null;
        
        if (author?.id && !author.is_bridge) {
          const messageTimestamp = note.published || new Date().toISOString();

          // Use harmony:rawContent when available (preserves emoji structure, mentions, etc.)
          let cachedContent: any[];
          if (note['harmony:rawContent'] && Array.isArray(note['harmony:rawContent'])) {
            cachedContent = normalizeInboundMentions(withoutPollParts(stripIncomingMediaPaths(note['harmony:rawContent'])), actorHostname(authorUrl));
          } else if (note.content) {
            cachedContent = [{ type: 'text', text: note.content.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').trim() }];
          } else {
            cachedContent = [];
          }

          const messageData: any = {
            channel_id: channelId,
            user_id: author.id,
            content: cachedContent,
            created_at: messageTimestamp,
            updated_at: note.updated || messageTimestamp,
            metadata: { ap_id: note.id, is_remote: true, federated: true },
            // This gets set by the trigger anyway when 'federated' key is present
            federation_status: 'skipped',
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

        // Extract custom emojis from tags (preserve URLs)
        const customEmojis = (note.tag || [])
          .filter((t: any) => t.type === 'Emoji')
          .map((t: any) => ({
            name: t.name?.replace(/:/g, '') || t.id?.split('/').pop(),
            url: t.icon?.url,
          }));

        let reactions: any[] = [];
        if (cachedMsgId) {
          const { data: rxns } = await supabase.rpc('get_message_reactions', { 
            message_id: cachedMsgId 
          });
          reactions = rxns || [];
        }

        return {
          id: cachedMsgId || messageUuid || note.id,
          content: note.content,
          created_at: note.published,
          updated_at: note.updated,
          metadata: { 
            ap_id: note.id,
            is_bridge: author?.is_bridge || false,
            customEmojis: customEmojis.length > 0 ? customEmojis : undefined,
          },
          author,
          reactions, // Include reactions with emoji URLs
        };
      }));

      return res.json({ 
        messages: messages.filter(Boolean), 
        source: 'remote' 
      });
    } catch (error: any) {
      logger.error('Error fetching remote messages:', error);
      return serveCache(error.message);
    }
  })
);

// SERVICE CLASS

export class ServerDiscoveryService {
  /**
   * Discover a server by WebFinger handle, the standard Fediverse way.
   * Formats supported:
   * - server@domain.com         (preferred - an acct: handle, like Lemmy's !community@instance)
   * - @server@domain.com        (leading @ tolerated)
   * - harmony://server@domain.com/slug   (legacy form, mapped to acct:slug@domain)
   * - https://domain.com/servers/uuid    (direct URL - short-circuits WebFinger)
   *
   * Resolution: GET https://{domain}/.well-known/webfinger?resource=acct:{slug}@{domain}
   * then follow the rel="self" application/activity+json link to the Group actor.
   */
  static async discoverByWebFinger(resource: string): Promise<any | null> {
    try {
      if (resource.startsWith('https://')) {
        return await this.fetchServerByUrl(resource);
      }

      let domain: string;
      let slug: string;

      const harmonyMatch = resource.match(/^harmony:\/\/server@([^/]+)\/(.+)$/);
      if (harmonyMatch) {
        // Legacy scheme: take the path segment as the handle slug.
        domain = harmonyMatch[1];
        slug = harmonyMatch[2];
      } else {
        // acct form: server@domain.com (tolerate a leading @ and acct: prefix)
        const normalized = resource.replace(/^@/, '').replace(/^acct:/i, '');
        const simpleMatch = normalized.match(/^([^@]+)@(.+)$/);
        if (!simpleMatch) {
          logger.warn('Invalid server handle format:', resource);
          return null;
        }
        slug = simpleMatch[1];
        domain = simpleMatch[2];
      }

      const webfingerResource = `acct:${slug}@${domain}`;
      const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(webfingerResource)}`;

      const response = await safeFetch(webfingerUrl, {
        headers: {
          'Accept': 'application/jrd+json, application/json',
        },
      });

      if (!response.ok) {
        logger.warn(`WebFinger lookup failed for ${webfingerResource}: ${response.status}`);
        return null;
      }

      const data = await response.json();

      // A handle may resolve to BOTH a user (Person) and a server (Group) when
      // they share a localpart (Lemmy-style). Pick the Group link, identified by
      // its ActivityStreams `type` property. Fall back to a plain self link only
      // when no link is type-tagged (single-actor response from older peers).
      const AS_TYPE = 'https://www.w3.org/ns/activitystreams#type';
      const selfLinks = (data.links || []).filter(
        (link: any) => link.rel === 'self' && link.type === 'application/activity+json',
      );

      const groupLink =
        selfLinks.find((link: any) => link.properties?.[AS_TYPE] === 'Group') ||
        // Only accept an untyped link if it's unambiguous (no Person sibling).
        (selfLinks.length === 1 && !selfLinks[0].properties?.[AS_TYPE]
          ? selfLinks[0]
          : undefined);

      if (!groupLink?.href) {
        logger.warn(`No Group actor in WebFinger response for ${webfingerResource}`);
        return null;
      }

      // Fetch the actor and confirm it's a Group (fetchServerByUrl rejects non-Groups).
      return await this.fetchServerByUrl(groupLink.href);
    } catch (error) {
      logger.error('Error discovering server via WebFinger:', error);
      return null;
    }
  }

  /**
   * Fetch a Group by its ActivityPub URL. With `signAs`, the GET is signed as
   * that local user, which a private server requires before it lists
   * channels; without it the instance actor signs and sees the public view.
   */
  static async fetchServerByUrl(url: string, opts: { signAs?: string } = {}): Promise<any | null> {
    try {
      logger.info(`Fetching remote server: ${url}`);

      const headers = { 'Accept': 'application/activity+json, application/ld+json' };
      const response = await SignatureService.signedApFetch(url, {
        headers,
        timeoutMs: 10000,
        ...(opts.signAs ? { signAs: opts.signAs } : {}),
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch server: ${response.status}`);
        return null;
      }

      const server = await response.json();

      if (server.type !== 'Group') {
        logger.warn(`URL does not point to a Group: ${server.type}`);
        return null;
      }

      // The reference is stored under the Group's own id, its UUID reused as
      // the local primary key, and Joins go to its inbox. A document naming
      // an id or inbox on another host is not authoritative for either.
      if (!sameOrigin(server.id, url) || !sameOrigin(server.inbox, server.id)) {
        logger.warn(`Group at ${url} names id ${server.id} / inbox ${server.inbox} on another host`);
        return null;
      }

      // Single inbound-boundary shim: older/non-compliant peers may still
      // advertise the built-in default icon sentinel. Treat it as "no icon"
      // here, once, so every discovery consumer (discover / join / sync) sees a
      // clean object and never persists or surfaces a bogus default asset URL.
      if (isDefaultServerIcon(server.icon?.url)) {
        server.icon = undefined;
      }

      logger.info(`Found remote server: ${server.name}`);
      return server;
    } catch (error) {
      logger.error('Error fetching server by URL:', error);
      return null;
    }
  }

  /**
   * Create local reference to remote server
   * @param remoteServer - The remote server ActivityPub Group object
   * @param ownerUserId - Local user ID to set as the reference owner (required by NOT NULL constraint)
   */
  static async createLocalServerReference(remoteServer: any, ownerUserId?: string): Promise<any> {
    const supabase = getSupabaseClient();

    try {
      const serverUrl = new URL(remoteServer.id);
      const hostDomain = serverUrl.hostname;

      const channels = remoteServer['harmony:channels'] || [];

      const { data: existing } = await supabase
        .from('servers')
        .select('*')
        .eq('ap_id', remoteServer.id)
        .single();

      if (existing) {
        logger.info(`Server reference already exists: ${remoteServer.name}`);
        return existing;
      }

      // Remote server references should always be owned by the instance admin
      // to prevent cascade-deletion if the joining user leaves or is deleted.
      const { data: admin } = await supabase
        .from('profiles')
        .select('id')
        .eq('is_local', true)
        .eq('is_admin', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (admin) {
        ownerUserId = admin.id;
      } else if (!ownerUserId) {
        // No admin found (shouldn't happen) - fall back to the joining user
        const { data: anyUser } = await supabase
          .from('profiles')
          .select('id')
          .eq('is_local', true)
          .limit(1)
          .maybeSingle();
        ownerUserId = anyUser?.id;
      }

      if (!ownerUserId) {
        throw new Error('No local user found to set as remote server reference owner');
      }

      // Extract server UUID from AP ID if possible
      // Format: https://instance.com/servers/{uuid}
      let serverUuid: string | undefined;
      const serverIdMatch = remoteServer.id.match(/\/servers\/([a-f0-9-]{36})$/i);
      if (serverIdMatch) {
        serverUuid = serverIdMatch[1];

        // Check if a server with this UUID already exists locally (e.g. same-instance join)
        const { data: existingById } = await supabase
          .from('servers')
          .select('*')
          .eq('id', serverUuid)
          .single();

        if (existingById) {
          // The row is this Group only for a same-instance id or a matching
          // ap_id. Otherwise the UUID is taken; the reference gets a fresh one.
          if (hostDomain.toLowerCase() === config.INSTANCE_DOMAIN.toLowerCase() || existingById.ap_id === remoteServer.id) {
            logger.info(`Server already exists locally by UUID: ${serverUuid} (${existingById.name})`);
            return existingById;
          }
          logger.warn(`Remote Group ${remoteServer.id} reuses UUID of local row ${serverUuid}; assigning a new id`);
          serverUuid = undefined;
        }
      }

      // Create server reference (use remote UUID if available to maintain consistency)
      const serverInsertData: any = {
        name: remoteServer.name,
        description: remoteServer.summary || '',
        icon: remoteServer.icon?.url ?? null,
        banner: remoteServer.image?.url || null,
        owner: ownerUserId,
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

      logger.info(`Created local reference for remote server: ${remoteServer.name} (id: ${serverRef.id})`);

      // Helper to extract UUID from AP ID
      const extractUuid = (apId: string): string | null => {
        const match = apId.match(/\/channels\/([a-f0-9-]{36})$/i);
        return match ? match[1] : null;
      };

      const categoryMap = new Map<string, string>();

      // First pass: categories go in channel_categories, not channels. Local
      // servers use channel_categories, so federated servers must match.
      // Type arrives as 'category', 2, 'harmony:Category', or channelType: 'category'.
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
          // NOTE: channel_categories has no ap_id or is_remote column; the
          // ap_id -> local id mapping is held in categoryMap for this pass only.
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
          logger.info(`Created category: ${cat.name} (id: ${catRef.id})`);
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

      const channelRows = regularChannels.map((channelData: any) => {
        const channelUuid = channelData.localId || extractUuid(channelData.id);
        const isVoice = 
          channelData.type === 'voice' || 
          channelData.type === 1 || 
          channelData.type === 'harmony:VoiceChannel' ||
          channelData.channelType === 'voice';
        const channelType = isVoice ? 1 : 0;

        let categoryId = null;
        if (channelData.category) {
          categoryId = categoryMap.get(channelData.category);
        } else if (channelData.categoryId) {
          categoryId = categoryMap.get(channelData.categoryId) || channelData.categoryId;
        }

        const row: any = {
          server_id: serverRef.id,
          name: channelData.name,
          type: channelType,
          order: channelData.order || channelData.position || 0,
          ap_id: channelData.id,
          is_remote: true,
          category: categoryId,
          description: channelData.description,
        };

        if (channelUuid) {
          row.id = channelUuid;
        }

        return row;
      });

      if (channelRows.length > 0) {
        const { error: channelError } = await supabase.from('channels').insert(channelRows);
        if (channelError) {
          logger.error(`Failed to bulk-create channels:`, channelError);
        } else {
          logger.info(`Created ${channelRows.length} channels`);
        }
      }

      logger.info(`Created ${regularChannels.length} channels and ${categories.length} categories for remote server`);

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
    logger.info(`Sent Join request to ${inboxUrl}`);
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
    logger.info(`Sent Leave request to ${inboxUrl}`);
  }

  /** The profile holds an accepted membership of the server. */
  static async isAcceptedMember(serverId: string, profileId: string): Promise<boolean> {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('user_servers')
      .select('status')
      .eq('server_id', serverId)
      .eq('user_id', profileId)
      .maybeSingle();
    return data?.status === 'accepted';
  }

  /**
   * Local user whose key signs background reads of a remote server: the
   * earliest accepted local member. Null when the server has none.
   */
  static async pickSigningMember(serverId: string): Promise<string | null> {
    const supabase = getSupabaseClient();
    const { data: memberships } = await supabase
      .from('user_servers')
      .select('user_id')
      .eq('server_id', serverId)
      .eq('status', 'accepted')
      .order('created_at', { ascending: true })
      .limit(50);

    const ids: string[] = (memberships || []).map((m: any) => m.user_id);
    if (ids.length === 0) return null;

    const { data: locals } = await supabase
      .from('profiles')
      .select('id')
      .in('id', ids)
      .eq('is_local', true);
    const localIds = new Set((locals || []).map((p: any) => p.id));
    return ids.find(id => localIds.has(id)) ?? null;
  }

  /**
   * Sync a remote server's metadata and channels. The Group is fetched signed
   * as `asUserId`, else as a local accepted member; with neither there is no
   * member to show the result to and the sync is skipped.
   */
  static async syncRemoteServer(serverId: string, opts: { asUserId?: string } = {}): Promise<void> {
    const supabase = getSupabaseClient();

    try {
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

      const signer = opts.asUserId ?? await this.pickSigningMember(serverId);
      if (!signer) {
        logger.info(`No local member of server ${serverId} to sign its sync; skipped`);
        return;
      }

      const remoteServer = await this.fetchServerByUrl(server.ap_id, { signAs: signer });

      if (!remoteServer) {
        logger.warn('Failed to fetch remote server');
        return;
      }

      if (remoteServer.id !== server.ap_id) {
        logger.warn(`Group at ${server.ap_id} names id ${remoteServer.id}; reference left unchanged`);
        return;
      }

      // The stub served to a non-member carries no channel list and no
      // artwork; applying it would blank the reference.
      if (!Array.isArray(remoteServer['harmony:channels'])) {
        logger.info(`Group ${server.ap_id} lists no channels to ${signer}; reference left unchanged`);
        return;
      }

      await supabase
        .from('servers')
        .update({
          name: remoteServer.name,
          description: remoteServer.summary,
          icon: remoteServer.icon?.url ?? null,
          banner: remoteServer.image?.url || null,
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

      await this.syncRemoteStructure(serverId, server.ap_id, remoteServer['harmony:channels']);

      logger.info(`Synced remote server: ${remoteServer.name}`);
    } catch (error) {
      logger.error('Error syncing remote server:', error);
    }
  }

  /**
   * Apply a Group's `harmony:channels` to its reference. Rows keep the remote
   * UUID as their id: pushed messages name their channel by it. Only ids
   * under this Group are accepted, and an id already held by a row of another
   * server is skipped, never re-parented. Channels absent from the list stay.
   */
  static async syncRemoteStructure(serverId: string, serverApId: string, entries: any[]): Promise<void> {
    const supabase = getSupabaseClient();
    const prefix = `${serverApId}/channels/`;
    const uuidOf = (apId: unknown): string | null => {
      if (typeof apId !== 'string' || !apId.startsWith(prefix)) return null;
      const m = apId.slice(prefix.length).match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      return m ? m[0].toLowerCase() : null;
    };
    const isCategory = (c: any) =>
      c.type === 'harmony:Category' || c.type === 'category' || c.type === 2 || c.channelType === 'category';
    const isVoice = (c: any) =>
      c.type === 'harmony:VoiceChannel' || c.type === 'voice' || c.type === 1 || c.channelType === 'voice';

    const valid = (entries || []).filter((c: any) => c && uuidOf(c.id));
    const categories = valid.filter(isCategory);
    const channels = valid.filter((c: any) => !isCategory(c));

    // channel_categories has no ap_id column; the remote UUID is the row id.
    const ownCategoryIds = new Set<string>();
    const categoryIds = categories.map((c: any) => uuidOf(c.id)!);
    if (categoryIds.length > 0) {
      const { data: existing } = await supabase
        .from('channel_categories')
        .select('id, server_id')
        .in('id', categoryIds);
      const serverOf = new Map((existing || []).map((r: any) => [r.id, r.server_id]));

      for (const cat of categories) {
        const id = uuidOf(cat.id)!;
        const fields = { name: cat.name, order: cat.order ?? cat.position ?? 0 };
        const owner = serverOf.get(id);
        if (owner === undefined) {
          const { error } = await supabase.from('channel_categories').insert({ id, server_id: serverId, ...fields });
          if (error) logger.warn(`Could not create category ${cat.id}: ${error.message}`);
          else ownCategoryIds.add(id);
        } else if (owner === serverId) {
          await supabase.from('channel_categories').update(fields).eq('id', id);
          ownCategoryIds.add(id);
        } else {
          logger.warn(`Category ${cat.id} reuses the id of another server's category; skipped`);
        }
      }
    }

    if (channels.length === 0) return;

    const [{ data: byApId }, { data: byId }] = await Promise.all([
      supabase.from('channels').select('id, server_id, ap_id').in('ap_id', channels.map((c: any) => c.id)),
      supabase.from('channels').select('id, server_id').in('id', channels.map((c: any) => uuidOf(c.id)!)),
    ]);
    const rowByApId = new Map((byApId || []).map((r: any) => [r.ap_id, r]));
    const rowById = new Map((byId || []).map((r: any) => [r.id, r]));

    for (const c of channels) {
      const id = uuidOf(c.id)!;
      const categoryId = [c.categoryId, uuidOf(c.category)]
        .map(v => (typeof v === 'string' ? v.toLowerCase() : null))
        .find((v): v is string => v !== null && ownCategoryIds.has(v));
      const fields: Record<string, unknown> = {
        name: c.name,
        type: isVoice(c) ? 1 : 0,
        order: c.order ?? c.position ?? 0,
        category: categoryId ?? null,
        ap_id: c.id,
        is_remote: true,
      };
      if (typeof c.description === 'string') fields.description = c.description;

      const existing = rowByApId.get(c.id) ?? rowById.get(id);
      if (existing) {
        if (existing.server_id !== serverId) {
          logger.warn(`Channel ${c.id} collides with a channel of another server; skipped`);
          continue;
        }
        await supabase.from('channels').update(fields).eq('id', existing.id);
      } else {
        const { error } = await supabase.from('channels').insert({ id, server_id: serverId, ...fields });
        if (error) logger.warn(`Could not create channel ${c.id}: ${error.message}`);
      }
    }
  }

  /**
   * Sync remote server members
   * Fetches the members collection and creates local profiles for remote users.
   * With `signAs`, the collection must sit on the server's host and the GET
   * is signed as that local user.
   */
  static async syncRemoteServerMembers(
    serverId: string,
    membersUrl: string,
    opts: { signAs?: string; serverApId?: string } = {},
  ): Promise<void> {
    const supabase = getSupabaseClient();

    try {
      logger.info(`Syncing remote server members from: ${membersUrl}`);

      if (opts.signAs && (!opts.serverApId || !sameOrigin(membersUrl, opts.serverApId))) {
        logger.warn(`Members collection ${membersUrl} is not on the server's host; not signing a fetch to it`);
        return;
      }

      // BUGS.md H15: membersUrl is from remote AP response.
      const headers = {
        'Accept': 'application/activity+json, application/json',
        'User-Agent': `Harmony/${config.VERSION} (+https://${config.INSTANCE_DOMAIN})`,
      };
      const response = await SignatureService.signedApFetch(membersUrl + '?page=1', {
        headers,
        timeoutMs: 10000,
        ...(opts.signAs ? { signAs: opts.signAs } : {}),
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch members collection: ${response.status}`);
        return;
      }

      const membersPage = await response.json();
      const members = membersPage.orderedItems || [];

      logger.info(`Found ${members.length} remote members`);

      const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js');

      for (const member of members) {
        try {
          // Member can be a URL string or an object with id
          const memberUrl = typeof member === 'string' ? member : (member.id || member.actor);
          
          if (!memberUrl || typeof memberUrl !== 'string') {
            continue;
          }

          // Skip members from our own instance - they're local users, not remote
          try {
            const memberHost = new URL(memberUrl).host;
            if (memberHost === config.INSTANCE_DOMAIN) {
              logger.debug(`Skipping local user in member sync: ${memberUrl}`);
              continue;
            }
          } catch {
            continue; // Invalid URL
          }

          const profile = await ActivityProcessor['ensureRemoteUser'](memberUrl);
          
          if (profile) {
            const { error } = await supabase
              .from('user_servers')
              .upsert({
                server_id: serverId,
                user_id: profile.id,
                status: 'accepted',
                member_instance: new URL(memberUrl).host,
              }, {
                onConflict: 'server_id,user_id',
                ignoreDuplicates: true,
              });

            if (!error) {
              logger.debug(`Added remote member: ${profile.username}`);
            }
          }
        } catch (memberError) {
          logger.debug(`Failed to process member:`, memberError);
        }
      }

      logger.info(`Synced remote server members for server: ${serverId}`);
    } catch (error) {
      logger.error('Error syncing remote server members:', error);
    }
  }

  /**
   * Get or create local server reference by AP ID
   */
  static async getOrCreateServerReference(apId: string): Promise<any | null> {
    const supabase = getSupabaseClient();

    const { data: existing } = await supabase
      .from('servers')
      .select('*')
      .eq('ap_id', apId)
      .single();

    if (existing) {
      return existing;
    }

    const remoteServer = await this.fetchServerByUrl(apId);
    if (!remoteServer) {
      return null;
    }

    return await this.createLocalServerReference(remoteServer);
  }
}

export default router;
