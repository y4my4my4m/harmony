/**
 * ServerDiscoveryService - Discover and fetch remote Harmony servers
 * 
 * Enables users to find and join servers on other Harmony instances
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

export class ServerDiscoveryService {
  /**
   * Discover server by WebFinger
   * Format: harmony://server@domain.com/server-name
   */
  static async discoverByWebFinger(resource: string): Promise<any | null> {
    try {
      // Parse resource
      const match = resource.match(/^harmony:\/\/server@([^/]+)\/(.+)$/);
      if (!match) {
        logger.warn('Invalid Harmony server resource format');
        return null;
      }

      const [, domain, serverName] = match;

      // WebFinger lookup
      const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;

      const response = await fetch(webfingerUrl, {
        headers: {
          'Accept': 'application/jrd+json',
        },
      });

      if (!response.ok) {
        logger.warn(`WebFinger lookup failed for ${resource}`);
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
        await supabase.from('channels').insert({
          server_id: serverRef.id,
          name: channelData.name,
          type: channelData.type === 'TextChannel' ? 'text' : 'voice',
          position: channelData.position || 0,
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
   * Search for public servers across instances
   */
  static async searchRemoteServers(query: string): Promise<any[]> {
    // TODO: Implement server search
    // Could use:
    // - Known instances list
    // - Relay servers
    // - Direct instance queries

    logger.info(`🔍 Searching for remote servers: ${query}`);
    return [];
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
        })
        .eq('id', serverId);

      logger.info(`✅ Synced remote server: ${remoteServer.name}`);
    } catch (error) {
      logger.error('Error syncing remote server:', error);
    }
  }
}

