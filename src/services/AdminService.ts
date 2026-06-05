/**
 * AdminService - Professional service for admin panel operations
 * Handles all admin-related database queries and operations
 */

import { supabase } from '@/supabase';
import { debug } from '@/utils/debug'

export interface SystemStats {
  total_users: number;
  total_servers: number;
  active_servers: number;
  total_posts: number;
  federated_instances: number;
  uptime?: number;
  newUsersToday?: number;
  postsToday?: number;
}

export interface FederationStats {
  pending_deliveries: number;
  successful_deliveries: number;
  failed_deliveries: number;
  active_instances: number;
  endpoint_health: {
    total_endpoints: number;
    dead_endpoints: number;
    healthy_endpoints: number;
    endpoints_with_failures: number;
    total_failures: number;
    total_successes: number;
    success_rate: number;
  };
}

export interface DeadEndpoint {
  id: string;
  endpoint_url: string;
  domain: string;
  consecutive_failures: number;
  total_failures: number;
  last_failure_at: string | null;
  last_success_at: string | null;
  last_http_status: number | null;
  last_error_message: string | null;
  first_failure_at: string | null;
}

export interface AdminUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  created_at: string;
  updated_at?: string;
  domain?: string;
  is_local?: boolean;
  is_admin: boolean;
  is_moderator: boolean;
  is_suspended: boolean;
  suspended_at?: string;
  suspension_reason?: string;
  force_sensitive: boolean;
  is_silenced: boolean;
  silenced_at?: string;
  silenced_reason?: string;
  federated_id?: string;
  ap_actor_id?: string;
  postCount: number;
  serverCount: number;
  handle: string;
}

export interface AdminActivity {
  id: string;
  admin_id: string;
  admin_username: string;
  action_type: string;
  target_type: string;
  target_id?: string;
  target_username?: string;
  details: string;
  metadata?: any;
  ip_address?: string;
  user_agent?: string;
  created_at: string;
}

export interface SystemHealth {
  database: {
    responseTime: number;
    connections: number;
  };
  federation: {
    pending: number;
    status: 'healthy' | 'warning' | 'error';
  };
  storage: {
    used: number;
    total: string;
  };
  memory: {
    used: number;
    total: string;
  };
}

export interface BlockedInstance {
  domain: string;
  reason: string;
  blocked_at?: string;
  blocked_by?: string;
}

export interface FederatedInstance {
  id: string;
  domain: string;
  software?: string;
  version?: string;
  description?: string;
  admin_contact?: string;
  is_blocked: boolean;
  is_trusted: boolean;
  last_seen_at: string;
  user_count: number;
  status_count: number;
  connection_count: number;
  metadata: any;
  created_at: string;
  updated_at: string;
}

export interface InstanceSearchResult {
  domain: string;
  software?: string;
  version?: string;
  description?: string;
  user_count?: number;
  status_count?: number;
  admin_contact?: string;
  api_available: boolean;
  federation_enabled: boolean;
  icon_url?: string;
  banner_url?: string;
}

export interface InstanceStats {
  total_instances: number;
  blocked_instances: number;
  trusted_instances: number;
  active_instances: number;
  recently_discovered: number;
}

class AdminService {
  /**
   * Get comprehensive system statistics
   */
  async getSystemStats(): Promise<SystemStats> {
    try {
      // Get all stats in parallel using direct queries
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const [
        usersResult,
        postsResult,
        serversResult,
        federatedInstancesResult,
        newUsersResult,
        newPostsResult
      ] = await Promise.all([
        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('posts').select('*', { count: 'exact', head: true }).eq('is_deleted', false),
        supabase.from('servers').select('*', { count: 'exact', head: true }),
        supabase.from('federated_instances').select('*', { count: 'exact', head: true }),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
        supabase.from('posts').select('*', { count: 'exact', head: true }).gte('created_at', today.toISOString())
      ]);

      return {
        total_users: usersResult.count || 0,
        total_servers: serversResult.count || 0,
        active_servers: serversResult.count || 0, // For now, assume all servers are active
        total_posts: postsResult.count || 0,
        federated_instances: federatedInstancesResult.count || 0,
        uptime: Date.now() - (7 * 24 * 60 * 60 * 1000), // Mock uptime for now
        newUsersToday: newUsersResult.count || 0,
        postsToday: newPostsResult.count || 0
      };
    } catch (error) {
      debug.error('Failed to get system stats:', error);
      // Return safe defaults on error
      return {
        total_users: 0,
        total_servers: 0,
        active_servers: 0,
        total_posts: 0,
        federated_instances: 0,
        uptime: 0,
        newUsersToday: 0,
        postsToday: 0
      };
    }
  }

  /**
   * Get federation health statistics
   */
  async getFederationStats(): Promise<FederationStats> {
    try {
      // Get federation stats using direct queries
      const [
        pendingResult,
        successfulResult,
        failedResult,
        instancesResult,
        endpointHealthResult
      ] = await Promise.all([
        supabase.from('federation_delivery_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('federation_delivery_queue').select('*', { count: 'exact', head: true }).eq('status', 'delivered'),
        supabase.from('federation_delivery_queue').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
        supabase.from('federated_instances').select('*', { count: 'exact', head: true }).eq('is_blocked', false),
        supabase.from('federation_endpoint_health').select('*')
      ]);

      // Calculate endpoint health metrics
      const endpoints = endpointHealthResult.data || [];
      const totalEndpoints = endpoints.length;
      const deadEndpoints = endpoints.filter(e => e.is_dead).length;
      const healthyEndpoints = endpoints.filter(e => !e.is_dead && e.consecutive_failures === 0).length;
      const endpointsWithFailures = endpoints.filter(e => e.consecutive_failures > 0).length;
      const totalFailures = endpoints.reduce((sum, e) => sum + (e.total_failures || 0), 0);
      const totalSuccesses = endpoints.reduce((sum, e) => sum + (e.total_successes || 0), 0);
      const totalAttempts = totalFailures + totalSuccesses;
      const successRate = totalAttempts > 0 ? Math.round((totalSuccesses / totalAttempts) * 100) : 100;

      return {
        pending_deliveries: pendingResult.count || 0,
        successful_deliveries: successfulResult.count || 0,
        failed_deliveries: failedResult.count || 0,
        active_instances: instancesResult.count || 0,
        endpoint_health: {
          total_endpoints: totalEndpoints,
          dead_endpoints: deadEndpoints,
          healthy_endpoints: healthyEndpoints,
          endpoints_with_failures: endpointsWithFailures,
          total_failures: totalFailures,
          total_successes: totalSuccesses,
          success_rate: successRate
        }
      };
    } catch (error) {
      debug.error('Failed to get federation stats:', error);
      // Return safe defaults on error
      return {
        pending_deliveries: 0,
        successful_deliveries: 0,
        failed_deliveries: 0,
        active_instances: 0,
        endpoint_health: {
          total_endpoints: 0,
          dead_endpoints: 0,
          healthy_endpoints: 0,
          endpoints_with_failures: 0,
          total_failures: 0,
          total_successes: 0,
          success_rate: 100
        }
      };
    }
  }

  /**
   * Permanently delete all dead endpoints and their failed delivery queue entries
   */
  async purgeDeadEndpoints(): Promise<{ purgedEndpoints: number; purgedDeliveries: number }> {
    try {
      const { data: deadEndpoints, error: fetchError } = await supabase
        .from('federation_endpoint_health')
        .select('endpoint_url')
        .eq('is_dead', true);

      if (fetchError) throw fetchError;
      if (!deadEndpoints || deadEndpoints.length === 0) {
        return { purgedEndpoints: 0, purgedDeliveries: 0 };
      }

      const deadUrls = deadEndpoints.map(e => e.endpoint_url);

      const { count: deliveryCount, error: deliveryError } = await supabase
        .from('federation_delivery_queue')
        .delete({ count: 'exact' })
        .in('target_inbox_url', deadUrls)
        .in('status', ['dead', 'failed']);

      if (deliveryError) {
        debug.error('Failed to purge dead deliveries:', deliveryError);
      }

      const { count: endpointCount, error: endpointError } = await supabase
        .from('federation_endpoint_health')
        .delete({ count: 'exact' })
        .eq('is_dead', true);

      if (endpointError) throw endpointError;

      return {
        purgedEndpoints: endpointCount || 0,
        purgedDeliveries: deliveryCount || 0
      };
    } catch (error) {
      debug.error('Failed to purge dead endpoints:', error);
      throw error;
    }
  }

  /**
   * Fetch all dead endpoints with details for the admin UI
   */
  async getDeadEndpoints(): Promise<DeadEndpoint[]> {
    try {
      const { data, error } = await supabase
        .from('federation_endpoint_health')
        .select('id, endpoint_url, domain, consecutive_failures, total_failures, last_failure_at, last_success_at, last_http_status, last_error_message, first_failure_at')
        .eq('is_dead', true)
        .order('last_failure_at', { ascending: false });

      if (error) throw error;
      return (data as DeadEndpoint[]) || [];
    } catch (error) {
      debug.error('Failed to get dead endpoints:', error);
      return [];
    }
  }

  /**
   * Purge a single dead endpoint by ID and its failed deliveries
   */
  async purgeSingleEndpoint(endpointId: string, endpointUrl: string): Promise<void> {
    try {
      await supabase
        .from('federation_delivery_queue')
        .delete()
        .eq('target_inbox_url', endpointUrl)
        .in('status', ['dead', 'failed']);

      const { error } = await supabase
        .from('federation_endpoint_health')
        .delete()
        .eq('id', endpointId);

      if (error) throw error;
    } catch (error) {
      debug.error('Failed to purge endpoint:', error);
      throw error;
    }
  }

  /**
   * Get system health metrics
   */
  async getSystemHealth(): Promise<SystemHealth> {
    try {
      // Get federation stats for health calculation
      const federationStats = await this.getFederationStats();
      
      // Measure database response time
      const start = Date.now();
      await supabase.from('profiles').select('id').limit(1);
      const dbResponseTime = Date.now() - start;

      // Get real DB connection count
      let connections = 0;
      try {
        const { data: connData } = await supabase.rpc('get_db_connection_count');
        connections = connData || 0;
      } catch { /* RPC may not exist yet */ }

      // Get real DB size
      let dbSize = '--';
      try {
        const { data: sizeData } = await supabase.rpc('get_db_size');
        dbSize = sizeData || '--';
      } catch { /* RPC may not exist yet */ }

      return {
        database: { 
          responseTime: dbResponseTime, 
          connections
        },
        federation: { 
          pending: federationStats.pending_deliveries, 
          status: federationStats.pending_deliveries > 100 ? 'warning' : 'healthy' 
        },
        storage: { used: 0, total: dbSize },
        memory: { used: 0, total: '--' }
      };
    } catch (error) {
      debug.error('Failed to get system health:', error);
      throw error;
    }
  }

  /**
   * Get users with admin-relevant information (paginated)
   */
  async getUsers(limit: number = 25, offset: number = 0): Promise<{ users: AdminUser[]; total: number }> {
    try {
      const { count: total } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true });

      const { data, error } = await supabase
        .from('profiles')
        .select(`
          id,
          username,
          display_name,
          avatar_url,
          created_at,
          updated_at,
          domain,
          is_local,
          is_admin,
          is_moderator,
          is_suspended,
          suspended_at,
          suspension_reason,
          force_sensitive,
          is_silenced,
          silenced_at,
          silenced_reason,
          federated_id
        `)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      const users = data || [];
      if (users.length === 0) {
        return { users: [], total: total || 0 };
      }

      // Batch-fetch post and server counts (avoids N+1)
      const userIds = users.map((u) => u.id);
      const { data: countRows, error: countsError } = await supabase.rpc('get_admin_user_counts', {
        p_user_ids: userIds
      });

      const countMap = new Map<string, { postCount: number; serverCount: number }>();
      if (!countsError && countRows) {
        for (const row of countRows as { user_id: string; post_count: string; server_count: string }[]) {
          countMap.set(row.user_id, {
            postCount: Number(row.post_count) || 0,
            serverCount: Number(row.server_count) || 0
          });
        }
      }

      const usersWithCounts = users.map((user) => {
        const counts = countMap.get(user.id) ?? { postCount: 0, serverCount: 0 };
        return {
          ...user,
          ap_actor_id: undefined, // Not available in current schema
          postCount: counts.postCount,
          serverCount: user.is_local ? counts.serverCount : 0,
          handle: !user.is_local
            ? `@${user.username}@${user.domain}`
            : `@${user.username}`
        };
      });

      return { users: usersWithCounts, total: total || 0 };
    } catch (error) {
      debug.error('Failed to get users:', error);
      throw error;
    }
  }

  /**
   * Get total user counts by category (for admin User Management filter stats)
   */
  async getUserCounts(): Promise<{ total: number; local: number; federated: number; suspended: number }> {
    try {
      const [totalRes, localRes, federatedRes, suspendedRes] = await Promise.all([
        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('is_local', true),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).or('is_local.eq.false,is_local.is.null'),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('is_suspended', true)
      ]);

      return {
        total: totalRes.count ?? 0,
        local: localRes.count ?? 0,
        federated: federatedRes.count ?? 0,
        suspended: suspendedRes.count ?? 0
      };
    } catch (error) {
      debug.error('Failed to get user counts:', error);
      return { total: 0, local: 0, federated: 0, suspended: 0 };
    }
  }

  /**
   * Get recent admin activity from audit log
   */
  async getRecentActivity(limit: number = 20): Promise<AdminActivity[]> {
    try {
      const { data, error } = await supabase
        .from('admin_audit_log')
        .select(`
          *,
          admin:profiles!admin_id(username, display_name)
        `)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        debug.warn('admin_audit_log query failed, falling back to empty:', error);
        return [];
      }

      const entries = (data || []).map((entry: any) => ({
        id: entry.id,
        admin_id: entry.admin_id,
        admin_username: entry.admin?.username || 'Unknown',
        action_type: entry.action_type || 'unknown',
        target_type: entry.target_type || 'system',
        target_id: entry.target_id,
        details: entry.action_details ? (typeof entry.action_details === 'string' ? entry.action_details : JSON.stringify(entry.action_details)) : '',
        metadata: entry.action_details || {},
        ip_address: entry.ip_address,
        user_agent: entry.user_agent || '',
        created_at: entry.created_at
      }));

      // Resolve target usernames for user moderation actions
      const userTargetIds = entries
        .filter((e: AdminActivity) => e.target_type === 'user' && e.target_id)
        .map((e: AdminActivity) => e.target_id!)
        .filter((id, i, arr) => arr.indexOf(id) === i);

      if (userTargetIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username')
          .in('id', userTargetIds);

        const idToUsername = new Map((profiles || []).map((p: { id: string; username: string }) => [p.id, p.username || 'unknown']));

        for (const entry of entries) {
          if (entry.target_type === 'user' && entry.target_id) {
            (entry as any).target_username = idToUsername.get(entry.target_id) || `user:${entry.target_id.slice(0, 8)}...`;
          }
        }
      }

      return entries;
    } catch (error) {
      debug.error('Failed to get recent activity:', error);
      return [];
    }
  }

  /**
   * Log an admin action to the audit log
   */
  async logAdminAction(params: {
    action: string;
    targetType: string;
    targetId?: string;
    details?: Record<string, any>;
  }): Promise<void> {
    try {
      // BUGS.md Pattern A: `admin_audit_log.admin_id` references
      // `profiles(id)`, not auth.users(id). Inserting `user.id` (auth UUID)
      // produced audit rows with broken FK references / wrong-user
      // attribution. Resolve to profile id before insert.
      const { authContextService } = await import('@/services/AuthContextService');
      let adminProfileId: string;
      try {
        adminProfileId = await authContextService.getCurrentProfileId();
      } catch {
        return;
      }

      await supabase
        .from('admin_audit_log')
        .insert({
          admin_id: adminProfileId,
          action_type: params.action,
          target_type: params.targetType,
          target_id: params.targetId,
          action_details: params.details || {}
        });
    } catch (error) {
      debug.error('Failed to log admin action:', error);
    }
  }

  /**
   * Moderate a user (suspend, unsuspend, delete)
   * Uses the moderate_user RPC function which has SECURITY DEFINER
   * to bypass RLS policies and allow admins to moderate other users
   */
  async moderateUser(
    userId: string, 
    action: 'suspend' | 'unsuspend' | 'delete' | 'force_sensitive' | 'unforce_sensitive' | 'silence' | 'unsilence', 
    reason: string,
    adminId: string
  ): Promise<void> {
    try {
      let rpcAction: string = action;
      let rpcReason = reason;

      if (action === 'delete') {
        rpcAction = 'suspend';
        rpcReason = `DELETED: ${reason}`;
      }

      const { data, error } = await supabase.rpc('moderate_user', {
        p_admin_id: adminId,
        p_target_user_id: userId,
        p_action: rpcAction,
        p_reason: rpcReason
      });

      if (error) {
        debug.error('RPC moderate_user failed:', error);
        throw new Error(error.message || 'Failed to moderate user');
      }

      if (data === false) {
        throw new Error('Moderation action failed - insufficient permissions or user not found');
      }

      debug.log(`User ${userId} ${action}ed successfully by admin ${adminId}`);

      await this.logAdminAction({
        action: `user_${action}`,
        targetType: 'user',
        targetId: userId,
        details: { reason, action }
      });
    } catch (error) {
      debug.error('Failed to moderate user:', error);
      throw error;
    }
  }

  async moderatePost(
    postId: string,
    action: 'mark_sensitive' | 'unmark_sensitive' | 'set_cw' | 'remove_cw' | 'delete',
    value?: string
  ): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('admin_moderate_post', {
        p_post_id: postId,
        p_action: action,
        p_value: value ?? null
      });

      if (error) {
        debug.error('RPC admin_moderate_post failed:', error);
        throw new Error(error.message || 'Failed to moderate post');
      }

      if (data === false) {
        throw new Error('Post moderation failed - insufficient permissions or post not found');
      }

      debug.log(`Post ${postId} action=${action} succeeded`);
    } catch (error) {
      debug.error('Failed to moderate post:', error);
      throw error;
    }
  }

  /**
   * Moderate an instance (block, unblock)
   */
  async moderateInstance(
    domain: string,
    action: 'block' | 'unblock',
    reason: string,
    adminId: string
  ): Promise<void> {
    try {
      // Handle instance moderation using direct queries
      switch (action) {
        case 'block': {
          // Update or insert federated instance as blocked
          const { error } = await supabase
            .from('federated_instances')
            .upsert({
              domain,
              is_blocked: true,
              metadata: { blocked_reason: reason, blocked_by: adminId, blocked_at: new Date().toISOString() }
            }, { onConflict: 'domain' });
          
          if (error) throw error;
          break;
        }

        case 'unblock': {
          const { error } = await supabase
            .from('federated_instances')
            .update({
              is_blocked: false,
              metadata: { unblocked_reason: reason, unblocked_by: adminId, unblocked_at: new Date().toISOString() }
            })
            .eq('domain', domain);
          
          if (error) throw error;
          break;
        }

        default:
          throw new Error(`Unknown instance moderation action: ${action}`);
      }
    } catch (error) {
      debug.error('Failed to moderate instance:', error);
      throw error;
    }
  }

  /**
   * Get blocked instances
   */
  async getBlockedInstances(): Promise<BlockedInstance[]> {
    try {
      const { data, error } = await supabase
        .from('federated_instances')
        .select('domain, metadata')
        .eq('is_blocked', true)
        .order('created_at', { ascending: false });

      if (error) throw error;

      return (data || []).map(instance => ({
        domain: instance.domain,
        reason: instance.metadata?.blocked_reason || 'No reason provided',
        blocked_at: instance.metadata?.blocked_at,
        blocked_by: instance.metadata?.blocked_by
      }));
    } catch (error) {
      debug.error('Failed to get blocked instances:', error);
      return [];
    }
  }

  /**
   * Get instance configuration
   */
  async getInstanceConfig(): Promise<any> {
    try {
      // Try to fetch WebRTC settings from database
      let webrtcSettings = {
        mode: 'hybrid' as 'sfu' | 'p2p' | 'hybrid',
        livekitUrl: '',
        allowFederatedVoice: true,
        maxStageListeners: 100000
      };
      
      // Use maybeSingle() instead of single() to handle cases where no row exists
      // Also, don't use .single() as it can fail with RLS if the policy doesn't allow it
      const { data: webrtcData, error: webrtcError } = await supabase
        .from('instance_webrtc_settings')
        .select('*')
        .limit(1)
        .maybeSingle();
      
      // If there's an RLS error, log it but continue with defaults
      if (webrtcError && webrtcError.code !== 'PGRST116') {
        debug.warn('Failed to fetch WebRTC settings (may be RLS issue):', webrtcError)
      }
      
      if (webrtcData) {
        webrtcSettings = {
          mode: webrtcData.webrtc_mode || 'hybrid',
          livekitUrl: webrtcData.livekit_url || '',
          allowFederatedVoice: webrtcData.allow_federated_voice ?? true,
          maxStageListeners: webrtcData.max_stage_listeners || 100000
        };
      }

      // Fetch instance config from instance_config table
      let instanceName = 'Harmony Instance'
      let instanceDescription = 'A federated social platform'
      let domain = import.meta.env.VITE_DOMAIN as string
      let registrationOpen = true
      let requiresApproval = false
      let oauthProviders: string[] | Record<string, boolean> = []
      let termsUrl = ''
      let privacyUrl = ''
      let instanceIconUrl = ''
      let instanceBannerUrl = ''
      let themeColor = ''
      let maintainerName = ''
      let maintainerEmail = ''

      let maxServerSize = 1000
      let maxMessageLength = 2000
      let maxMediaAttachmentsPerPost = 20
      let allowFileUploads = true
      let enableVoiceChannels = true
      let gifAdsEnabled = true
      let gifKlipyBrandingEnabled = true
      let maxPostLength = 500
      let retryAttempts = 3
      let maxCustomEmojisPerServer = 0
      let customEmojiTransformQuality = 80
      let allowCustomEmojisInDisplayNames = true
      const enableOutbound = true
      const enableInbound = true

      try {
        const { data: configData } = await supabase
          .from('instance_config')
          .select('config_key, config_value')
          .in('config_key', ['instance_name', 'instance_description', 'domain', 'open_registration', 'approval_required', 'oauth_providers', 'terms_url', 'privacy_url', 'max_server_size', 'max_message_length', 'max_media_attachments_per_post', 'allow_file_uploads', 'enable_voice_channels', 'gif_ads_enabled', 'gif_klipy_branding_enabled', 'max_post_length', 'federation_retry_attempts', 'max_custom_emojis_per_server', 'custom_emoji_transform_quality', 'allow_custom_emojis_in_display_names', 'instance_icon', 'instance_banner', 'theme_color', 'maintainer_name', 'maintainer_email'])

        if (configData) {
          configData.forEach((config) => {
            try {
              // Parse JSONB value - it may be a string with quotes or already parsed
              let value = config.config_value
              
              // Handle JSONB string values
              if (typeof value === 'string') {
                // Try to parse if it's a JSON string (might be double-quoted)
                try {
                  const parsed = JSON.parse(value)
                  // Always use the parsed value if parsing succeeds
                  value = parsed
                } catch {
                  // If parsing fails, remove surrounding quotes if present
                  // Handle both "string" and \"string\" cases
                  value = value.replace(/^\\?"|\\?"$/g, '').replace(/\\"/g, '"')
                }
              }
              
              // Ensure we have a clean string value (not double-quoted)
              if (typeof value === 'string') {
                // Remove any remaining escaped quotes
                value = value.replace(/\\"/g, '"')
              }

              switch (config.config_key) {
                case 'instance_name':
                  instanceName = (typeof value === 'string' ? value : String(value)) || 'Harmony Instance'
                  break
                case 'instance_description':
                  instanceDescription = (typeof value === 'string' ? value : String(value)) || 'A federated social platform'
                  break
                case 'domain':
                  domain = value || import.meta.env.VITE_DOMAIN as string
                  break
                case 'open_registration':
                  registrationOpen = value === true || value === 'true'
                  break
                case 'approval_required':
                  requiresApproval = value === true || value === 'true'
                  break
                case 'oauth_providers':
                  oauthProviders = value
                  break
                case 'terms_url':
                  termsUrl = (typeof value === 'string' ? value : String(value)) || ''
                  break
                case 'privacy_url':
                  privacyUrl = (typeof value === 'string' ? value : String(value)) || ''
                  break
                case 'max_server_size':
                  maxServerSize = typeof value === 'number' ? value : parseInt(String(value), 10) || 1000
                  break
                case 'max_message_length':
                  maxMessageLength = typeof value === 'number' ? value : parseInt(String(value), 10) || 2000
                  break
                case 'max_media_attachments_per_post':
                  maxMediaAttachmentsPerPost = typeof value === 'number' ? value : parseInt(String(value), 10) || 20
                  break
                case 'allow_file_uploads':
                  allowFileUploads = value === true || value === 'true'
                  break
                case 'enable_voice_channels':
                  enableVoiceChannels = value === true || value === 'true'
                  break
                case 'gif_ads_enabled':
                  gifAdsEnabled = value === true || value === 'true'
                  break
                case 'gif_klipy_branding_enabled':
                  gifKlipyBrandingEnabled = value === true || value === 'true'
                  break
                case 'max_post_length':
                  maxPostLength = typeof value === 'number' ? value : parseInt(String(value), 10) || 500
                  break
                case 'federation_retry_attempts':
                  retryAttempts = typeof value === 'number' ? value : parseInt(String(value), 10) || 3
                  break
                case 'max_custom_emojis_per_server':
                  maxCustomEmojisPerServer = typeof value === 'number' ? value : parseInt(String(value), 10) || 0
                  break
                case 'custom_emoji_transform_quality': {
                  const q = typeof value === 'number' ? value : parseInt(String(value), 10)
                  if (!Number.isNaN(q)) {
                    customEmojiTransformQuality = Math.min(100, Math.max(1, q))
                  }
                  break
                }
                case 'allow_custom_emojis_in_display_names':
                  allowCustomEmojisInDisplayNames = value === true || value === 'true'
                  break
                case 'instance_icon':
                  instanceIconUrl = (typeof value === 'string' ? value : String(value)) || ''
                  break
                case 'instance_banner':
                  instanceBannerUrl = (typeof value === 'string' ? value : String(value)) || ''
                  break
                case 'theme_color':
                  themeColor = (typeof value === 'string' ? value : String(value)) || ''
                  break
                case 'maintainer_name':
                  maintainerName = (typeof value === 'string' ? value : String(value)) || ''
                  break
                case 'maintainer_email':
                  maintainerEmail = (typeof value === 'string' ? value : String(value)) || ''
                  break
              }
            } catch (parseError) {
              debug.warn(`Failed to parse config value for ${config.config_key}:`, parseError)
            }
          })
        }
      } catch (configError) {
        debug.warn('Failed to fetch instance config from database, using defaults:', configError)
      }
      
      return {
        chat: {
          maxServerSize,
          maxMessageLength,
          maxMediaAttachmentsPerPost,
          allowFileUploads,
          enableVoiceChannels,
          gifAdsEnabled,
          gifKlipyBrandingEnabled,
        },
        federation: {
          maxPostLength,
          retryAttempts,
          maxCustomEmojisPerServer,
          customEmojiTransformQuality,
          allowCustomEmojisInDisplayNames,
          enableOutbound,
          enableInbound
        },
        webrtc: webrtcSettings,
        instance: {
          name: instanceName,
          description: instanceDescription,
          domain: domain,
          registrationOpen: registrationOpen,
          requiresApproval: requiresApproval,
          oauthProviders: oauthProviders,
          termsUrl: termsUrl,
          privacyUrl: privacyUrl,
          iconUrl: instanceIconUrl,
          bannerUrl: instanceBannerUrl,
          themeColor: themeColor,
          maintainerName: maintainerName,
          maintainerEmail: maintainerEmail,
        }
      };
    } catch (error) {
      debug.error('Failed to get instance config:', error);
      return null;
    }
  }
  
  /**
   * Update WebRTC settings
   */
  async updateWebRTCSettings(settings: {
    mode?: 'sfu' | 'p2p' | 'hybrid';
    livekitUrl?: string;
    allowFederatedVoice?: boolean;
    maxStageListeners?: number;
  }): Promise<boolean> {
    try {
      const payload = {
        webrtc_mode: settings.mode,
        livekit_url: settings.livekitUrl,
        allow_federated_voice: settings.allowFederatedVoice,
        max_stage_listeners: settings.maxStageListeners,
        updated_at: new Date().toISOString()
      };

      // Singleton table - fetch the existing row and update, or insert if empty
      const { data: existing } = await supabase
        .from('instance_webrtc_settings')
        .select('id')
        .limit(1)
        .maybeSingle();

      let error;
      if (existing?.id) {
        ({ error } = await supabase
          .from('instance_webrtc_settings')
          .update(payload)
          .eq('id', existing.id));
      } else {
        ({ error } = await supabase
          .from('instance_webrtc_settings')
          .insert(payload));
      }

      if (error) {
        debug.error('Failed to update WebRTC settings:', error);
        return false;
      }
      
      debug.log('WebRTC settings updated successfully');
      return true;
    } catch (error) {
      debug.error('Failed to update WebRTC settings:', error);
      return false;
    }
  }

  /**
   * Update federation settings
   * Uses the update_federation_settings RPC function
   */
  async updateFederationSettings(settings: {
    userId: string;
    federationEnabled?: boolean;
    inboundEnabled?: boolean;
    outboundEnabled?: boolean;
    autoAcceptFollows?: boolean;
  }): Promise<boolean> {
    try {
      const { error } = await supabase.rpc('update_federation_settings', {
        p_user_id: settings.userId,
        p_federation_enabled: settings.federationEnabled ?? null,
        p_inbound_enabled: settings.inboundEnabled ?? null,
        p_outbound_enabled: settings.outboundEnabled ?? null,
        p_auto_accept_follows: settings.autoAcceptFollows ?? null
      });

      if (error) {
        debug.error('Failed to update federation settings:', error);
        return false;
      }

      debug.log('Federation settings updated successfully');
      return true;
    } catch (error) {
      debug.error('Failed to update federation settings:', error);
      return false;
    }
  }

  /**
   * Set instance configuration key-value pair
   * Uses the set_instance_config RPC function which requires admin permissions
   */
  async setInstanceConfig(
    key: string, 
    value: any, 
    adminId: string, 
    description?: string
  ): Promise<void> {
    try {
      // Convert value to JSONB format
      // The RPC function expects JSONB, which Supabase will convert automatically
      // For strings, pass directly - Supabase will convert to JSONB string (with quotes)
      // For arrays/objects, pass as-is - Supabase will convert to JSONB
      // DO NOT JSON.stringify strings as that causes double-quoting
      const jsonbValue: any = value

      const { data, error } = await supabase.rpc('set_instance_config', {
        p_key: key,
        p_value: jsonbValue,
        p_description: description || null
      })

      if (error) {
        debug.error('RPC set_instance_config failed:', error)
        throw new Error(error.message || 'Failed to set instance config')
      }

      if (data === false) {
        throw new Error('Failed to set instance config - insufficient permissions or invalid data')
      }

      debug.log(`Instance config updated: ${key} = ${JSON.stringify(value)} by ${adminId}`)
    } catch (error) {
      debug.error('Failed to set instance config:', error)
      throw error
    }
  }

  /**
   * Set multiple instance configuration values in a single RPC call.
   * Falls back to sequential calls if the batch RPC is not available.
   */
  async setInstanceConfigs(configs: Record<string, any>, adminId: string): Promise<void> {
    const entries = Object.entries(configs)
    if (!entries.length) return

    try {
      const keys = entries.map(([k]) => k)
      const values = entries.map(([, v]) => {
        if (v === null || v === undefined) return null
        if (typeof v === 'object') return v
        return v
      })

      const { error } = await supabase.rpc('batch_set_instance_config', {
        p_keys: keys,
        p_values: values,
      })

      if (error) {
        if (error.message?.includes('function') || error.code === '42883') {
          debug.warn('batch_set_instance_config not available, falling back to sequential calls')
          await Promise.all(entries.map(([key, value]) => this.setInstanceConfig(key, value, adminId)))
          return
        }
        throw error
      }
    } catch (error) {
      debug.error('Failed to set instance configs:', error);
      throw error;
    }
  }

  /**
   * Check if user is admin
   */
  async checkAdminPermissions(userId: string): Promise<boolean> {
    try {
      // BUGS.md Pattern A: the existing callers (e.g. router admin guard,
      // AdminPanel.vue) pass `authStore.session?.user?.id` here - that's
      // the Supabase auth.users UUID, not `profiles.id`. The previous
      // `.eq('id', userId)` filter therefore matched zero rows and admin
      // detection was always false on direct calls. Match on
      // `auth_user_id` so the same call site works correctly.
      const { data, error } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('auth_user_id', userId)
        .maybeSingle();

      if (error) throw error;

      return data?.is_admin || false;
    } catch (error) {
      debug.error('Failed to check admin permissions:', error);
      return false;
    }
  }

  /**
   * Check if user is instance moderator
   */
  async checkModeratorPermissions(userId: string): Promise<boolean> {
    try {
      // BUGS.md Pattern A: same fix as checkAdminPermissions - callers pass
      // the auth.users UUID, so we match `auth_user_id`.
      const { data, error } = await supabase
        .from('profiles')
        .select('is_moderator')
        .eq('auth_user_id', userId)
        .maybeSingle();

      if (error) throw error;

      return data?.is_moderator || false;
    } catch (error) {
      debug.error('Failed to check moderator permissions:', error);
      return false;
    }
  }

  /**
   * Check if user is admin or moderator
   */
  async checkAdminOrModPermissions(userId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('is_admin, is_moderator')
        .eq('id', userId)
        .single();

      if (error) throw error;

      return data?.is_admin || data?.is_moderator || false;
    } catch (error) {
      debug.error('Failed to check admin/mod permissions:', error);
      return false;
    }
  }

  /**
   * Set moderator status for a user (admin only)
   */
  async setModeratorStatus(userId: string, isModerator: boolean): Promise<void> {
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ is_moderator: isModerator })
        .eq('id', userId);

      if (error) throw error;
    } catch (error) {
      debug.error('Failed to set moderator status:', error);
      throw error;
    }
  }

  /**
   * Export system logs (placeholder for now)
   */
  async exportLogs(): Promise<Blob> {
    try {
      // Get recent admin activity
      const activity = await this.getRecentActivity(1000);
      
      // Convert to CSV format
      const headers = ['Timestamp', 'Admin', 'Action', 'Target', 'Details', 'IP Address'];
      const csvContent = [
        headers.join(','),
        ...activity.map(event => [
          event.created_at,
          event.admin_username,
          event.action_type,
          event.target_type,
          `"${event.details.replace(/"/g, '""')}"`,
          event.ip_address || 'N/A'
        ].join(','))
      ].join('\n');

      return new Blob([csvContent], { type: 'text/csv' });
    } catch (error) {
      debug.error('Failed to export logs:', error);
      throw error;
    }
  }

  /**
   * Update instance trust status
   */
  async updateInstanceTrust(instanceId: string, trusted: boolean, adminId: string): Promise<void> {
    try {
      const { data: instance } = await supabase
        .from('federated_instances')
        .select('metadata')
        .eq('id', instanceId)
        .single();

      const { error } = await supabase
        .from('federated_instances')
        .update({
          is_trusted: trusted,
          metadata: {
            ...(instance?.metadata || {}),
            trust_updated_by: adminId,
            trust_updated_at: new Date().toISOString()
          }
        })
        .eq('id', instanceId);

      if (error) throw error;
    } catch (error) {
      debug.error('Failed to update instance trust:', error);
      throw error;
    }
  }

  /**
   * Update instance block status
   */
  async updateInstanceBlock(instanceId: string, blocked: boolean, reason: string, adminId: string): Promise<void> {
    try {
      const { data: instance } = await supabase
        .from('federated_instances')
        .select('metadata')
        .eq('id', instanceId)
        .single();

      const blockFields = blocked ? {
        blocked_reason: reason,
        blocked_by: adminId,
        blocked_at: new Date().toISOString()
      } : {
        unblocked_reason: reason,
        unblocked_by: adminId,
        unblocked_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('federated_instances')
        .update({ 
          is_blocked: blocked,
          metadata: {
            ...(instance?.metadata || {}),
            ...blockFields
          }
        })
        .eq('id', instanceId);

      if (error) throw error;
    } catch (error) {
      debug.error('Failed to update instance block status:', error);
      throw error;
    }
  }

  /**
   * Delete instance
   */
  async deleteInstance(instanceId: string, _adminId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('federated_instances')
        .delete()
        .eq('id', instanceId);

      if (error) throw error;
    } catch (error) {
      debug.error('Failed to delete instance:', error);
      throw error;
    }
  }

  /**
   * Add instance from domain
   */
  async addInstanceFromDomain(domain: string, trusted: boolean, adminId: string): Promise<void> {
    try {
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

      const { data: existing } = await supabase
        .from('federated_instances')
        .select('id')
        .eq('domain', cleanDomain)
        .maybeSingle();

      if (existing) {
        throw new Error(`Instance "${cleanDomain}" is already added`);
      }

      const instanceInfo = await this.discoverInstance(cleanDomain);
      
      const { error } = await supabase
        .from('federated_instances')
        .upsert({
          domain,
          software: instanceInfo?.software,
          version: instanceInfo?.version,
          description: instanceInfo?.description,
          admin_contact: instanceInfo?.admin_contact,
          user_count: instanceInfo?.user_count || 0,
          status_count: instanceInfo?.status_count || 0,
          is_trusted: trusted,
          is_blocked: false,
          last_seen_at: new Date().toISOString(),
          metadata: {
            added_by: adminId,
            added_at: new Date().toISOString(),
            api_available: instanceInfo?.api_available || false,
            federation_enabled: instanceInfo?.federation_enabled || false
          }
        }, { onConflict: 'domain' });

      if (error) throw error;
    } catch (error) {
      debug.error('Failed to add instance from domain:', error);
      throw error;
    }
  }

  /**
   * Get all federated instances with optional filtering
   */
  async getFederatedInstances(options: {
    limit?: number;
    offset?: number;
    filter?: 'all' | 'blocked' | 'trusted' | 'active';
    search?: string;
  } = {}): Promise<{ instances: FederatedInstance[]; total: number }> {
    try {
      const { limit = 50, offset = 0, filter = 'all', search } = options;
      
      let query = supabase
        .from('federated_instances')
        .select('*', { count: 'exact' })
        .order('last_seen_at', { ascending: false });

      // Apply filters
      switch (filter) {
        case 'blocked':
          query = query.eq('is_blocked', true);
          break;
        case 'trusted':
          query = query.eq('is_trusted', true);
          break;
        case 'active':
          query = query.gte('last_seen_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
          break;
      }

      // Apply search
      if (search) {
        query = query.or(`domain.ilike.%${search}%,description.ilike.%${search}%,software.ilike.%${search}%`);
      }

      // Apply pagination
      query = query.range(offset, offset + limit - 1);

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        instances: data || [],
        total: count || 0
      };
    } catch (error) {
      debug.error('Failed to get federated instances:', error);
      throw error;
    }
  }

  /**
   * Get federated instance statistics
   */
  async getInstanceStats(): Promise<InstanceStats> {
    try {
      const [totalResult, blockedResult, trustedResult, activeResult, recentResult] = await Promise.all([
        supabase.from('federated_instances').select('*', { count: 'exact', head: true }),
        supabase.from('federated_instances').select('*', { count: 'exact', head: true }).eq('is_blocked', true),
        supabase.from('federated_instances').select('*', { count: 'exact', head: true }).eq('is_trusted', true),
        supabase.from('federated_instances').select('*', { count: 'exact', head: true })
          .gte('last_seen_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
        supabase.from('federated_instances').select('*', { count: 'exact', head: true })
          .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      ]);

      return {
        total_instances: totalResult.count || 0,
        blocked_instances: blockedResult.count || 0,
        trusted_instances: trustedResult.count || 0,
        active_instances: activeResult.count || 0,
        recently_discovered: recentResult.count || 0
      };
    } catch (error) {
      debug.error('Failed to get instance stats:', error);
      return {
        total_instances: 0,
        blocked_instances: 0,
        trusted_instances: 0,
        active_instances: 0,
        recently_discovered: 0
      };
    }
  }

  /**
   * Add a new federated instance manually
   */
  async addFederatedInstance(
    domain: string, 
    adminId: string,
    options: {
      trusted?: boolean;
      forceAdd?: boolean;
    } = {}
  ): Promise<FederatedInstance> {
    try {
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
      
      // Check if instance already exists
      const { data: existing } = await supabase
        .from('federated_instances')
        .select('*')
        .eq('domain', cleanDomain)
        .single();

      if (existing && !options.forceAdd) {
        throw new Error('Instance already exists');
      }

      // Discover instance info
      const instanceInfo = await this.discoverInstance(cleanDomain);
      
      if (!instanceInfo && !options.forceAdd) {
        throw new Error('Could not discover instance information');
      }

      // Insert or update the instance
      const instanceData = {
        domain: cleanDomain,
        software: instanceInfo?.software || 'unknown',
        version: instanceInfo?.version,
        description: instanceInfo?.description,
        admin_contact: instanceInfo?.admin_contact,
        is_blocked: false,
        is_trusted: options.trusted || false,
        user_count: instanceInfo?.user_count || 0,
        status_count: instanceInfo?.status_count || 0,
        connection_count: 0,
        metadata: {
          added_by: adminId,
          discovery_method: instanceInfo ? 'api' : 'manual',
          federation_enabled: instanceInfo?.federation_enabled || false,
          ...(instanceInfo?.icon_url && { icon_url: instanceInfo.icon_url }),
          ...(instanceInfo?.banner_url && { banner_url: instanceInfo.banner_url }),
        }
      };

      const { data, error } = existing
        ? await supabase
            .from('federated_instances')
            .update(instanceData)
            .eq('id', existing.id)
            .select()
            .single()
        : await supabase
            .from('federated_instances')
            .insert(instanceData)
            .select()
            .single();

      if (error) throw error;

      // Log admin activity
      debug.log(`Instance ${cleanDomain} ${existing ? 'updated' : 'added'} by admin ${adminId}`);

      return data;
    } catch (error) {
      debug.error('Failed to add federated instance:', error);
      throw error;
    }
  }

  /**
   * Re-probe an existing instance to enrich its metadata with icon/banner URLs.
   * Returns the updated metadata or null on failure. Updates the DB row in-place.
   */
  async enrichInstanceMetadata(instance: { id: string; domain: string; metadata?: any }): Promise<{ icon_url?: string; banner_url?: string } | null> {
    try {
      const discovered = await this.discoverInstance(instance.domain);
      if (!discovered) return null;

      const newIcon = discovered.icon_url;
      const newBanner = discovered.banner_url;

      if (!newIcon && !newBanner) return null;

      const updatedMetadata = {
        ...(instance.metadata || {}),
        ...(newIcon && { icon_url: newIcon }),
        ...(newBanner && { banner_url: newBanner }),
      };

      await supabase
        .from('federated_instances')
        .update({ metadata: updatedMetadata })
        .eq('id', instance.id);

      return { icon_url: newIcon, banner_url: newBanner };
    } catch {
      return null;
    }
  }

  /**
   * Update federated instance settings
   */
  async updateFederatedInstance(
    instanceId: string,
    updates: {
      is_blocked?: boolean;
      is_trusted?: boolean;
      admin_contact?: string;
      description?: string;
    },
    adminId: string
  ): Promise<FederatedInstance> {
    try {
      const { data, error } = await supabase
        .from('federated_instances')
        .update({
          ...updates,
        })
        .eq('id', instanceId)
        .select()
        .single();

      if (error) throw error;

      // Log admin activity
      debug.log(`Instance ${data.domain} updated by admin ${adminId}:`, updates);

      return data;
    } catch (error) {
      debug.error('Failed to update federated instance:', error);
      throw error;
    }
  }

  /**
   * Delete/remove a federated instance
   */
  async deleteFederatedInstance(instanceId: string, adminId: string): Promise<void> {
    try {
      // Get instance info first for logging
      const { data: instance } = await supabase
        .from('federated_instances')
        .select('domain')
        .eq('id', instanceId)
        .single();

      const { error } = await supabase
        .from('federated_instances')
        .delete()
        .eq('id', instanceId);

      if (error) throw error;

      // Log admin activity
      debug.log(`Instance ${instance?.domain} deleted by admin ${adminId}`);
    } catch (error) {
      debug.error('Failed to delete federated instance:', error);
      throw error;
    }
  }

  /**
   * Search for ActivityPub instances using DIRECT probing
   * No 3rd party APIs - we query the instances directly using standard ActivityPub/Nodeinfo endpoints
   * 
   * User must enter a full domain name (e.g., "mastodon.social", "fosstodon.org")
   */
  async searchActivityPubInstances(query: string): Promise<InstanceSearchResult[]> {
    try {
      const domain = query.trim().toLowerCase();
      
      // Validate domain format
      if (!domain.includes('.') || domain.includes(' ')) {
        debug.log(`Invalid domain format: "${query}". User must enter a full domain like "mastodon.social"`);
        return [];
      }
      
      debug.log(`Probing instance directly: ${domain}`);
      
      const result = await this.discoverInstance(domain);
      
      if (result) {
        debug.log(`✅ Successfully discovered instance: ${domain}`);
        return [result];
      }
      
      debug.log(`❌ Could not discover instance at: ${domain}`);
      return [];
    } catch (error) {
      debug.error('Failed to probe ActivityPub instance:', error);
      return [];
    }
  }

  /**
   * Discover an instance by proxying through the federation backend.
   * This avoids CORS issues - browsers block direct cross-origin requests
   * to remote fediverse servers that don't set Access-Control-Allow-Origin.
   */
  async discoverInstance(domain: string): Promise<InstanceSearchResult | null> {
    try {
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
      debug.log(`Probing instance via backend proxy: ${cleanDomain}`);

      const response = await fetch(`/api/federation/instances/probe?domain=${encodeURIComponent(cleanDomain)}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        if (response.status === 404) {
          debug.log(`Could not discover instance: ${cleanDomain}`);
          return null;
        }
        throw new Error(`Probe failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      debug.warn(`Instance discovery failed for ${domain}:`, error);
      return null;
    }
  }

  /**
   * Get popular/recommended instances (now returns empty - use direct discovery)
   * Previously used 3rd party APIs which we've removed
   */
  async getPopularInstances(limit: number = 20): Promise<InstanceSearchResult[]> {
    try {
      debug.log('Fetching popular instances...');
      
      // Try to get popular instances from fediverse.observer
      const response = await fetch('https://api.fediverse.observer/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query: `
            query PopularInstances {
              nodes(softwarename: "mastodon") {
                domain
                softwarename
                version
                active_users_monthly
                total_users
                local_posts
                name
              }
            }
          `
        })
      });

      if (!response.ok) {
        debug.warn('Failed to fetch popular instances');
        return [];
      }

      const data = await response.json();
      
      if (!data.data?.nodes || !Array.isArray(data.data.nodes)) {
        return [];
      }

      // Sort by active users and return top instances
      const sorted = data.data.nodes
        .filter((node: any) => node.active_users_monthly > 100) // Only active instances
        .sort((a: any, b: any) => (b.active_users_monthly || 0) - (a.active_users_monthly || 0))
        .slice(0, limit);

      return sorted.map((node: any) => ({
        domain: node.domain,
        software: node.softwarename,
        version: node.version,
        description: node.name,
        user_count: node.total_users || node.active_users_monthly || 0,
        status_count: node.local_posts || 0,
        api_available: true,
        federation_enabled: true
      }));
    } catch (error) {
      debug.error('Failed to get popular instances:', error);
      return [];
    }
  }

  /**
   * Get instances by software type (mastodon, pleroma, misskey, etc.)
   */
  async getInstancesBySoftware(software: string, limit: number = 20): Promise<InstanceSearchResult[]> {
    try {
      debug.log(`Fetching ${software} instances...`);
      
      const response = await fetch('https://api.fediverse.observer/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query: `
            query InstancesBySoftware($software: String!) {
              nodes(softwarename: $software) {
                domain
                softwarename
                version
                active_users_monthly
                total_users
                local_posts
                name
              }
            }
          `,
          variables: { software: software.toLowerCase() }
        })
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      
      if (!data.data?.nodes || !Array.isArray(data.data.nodes)) {
        return [];
      }

      return data.data.nodes
        .slice(0, limit)
        .map((node: any) => ({
          domain: node.domain,
          software: node.softwarename,
          version: node.version,
          description: node.name,
          user_count: node.total_users || node.active_users_monthly || 0,
          status_count: node.local_posts || 0,
          api_available: true,
          federation_enabled: true
        }));
    } catch (error) {
      debug.error(`Failed to get ${software} instances:`, error);
      return [];
    }
  }

  /**
   * Get instances from user interactions (follows, posts, etc.)
   * Excludes instances already in federated_instances (approved/known).
   */
  async getDiscoveredInstances(limit: number = 20): Promise<{ domain: string; user_count: number; interaction_count: number }[]> {
    try {
      // Get domains already in federated_instances (approved/known) to exclude
      const { data: knownData } = await supabase
        .from('federated_instances')
        .select('domain');
      const knownDomains = new Set((knownData || []).map((r: { domain: string }) => r.domain?.toLowerCase()).filter(Boolean));

      // Get instances that users have interacted with
      const { data, error } = await supabase
        .from('profiles')
        .select('domain')
        .not('domain', 'is', null)
        .neq('domain', import.meta.env.VITE_DOMAIN as string) // Exclude local domain
        
      if (error) throw error;

      // Count instances and interactions, excluding already-known
      const instanceCounts = new Map<string, number>();
      
      data?.forEach(profile => {
        if (profile.domain) {
          const domain = profile.domain.toLowerCase();
          if (!knownDomains.has(domain)) {
            instanceCounts.set(domain, (instanceCounts.get(domain) || 0) + 1);
          }
        }
      });

      // Convert to array and sort by interaction count
      const discovered = Array.from(instanceCounts.entries())
        .map(([domain, count]) => ({
          domain,
          user_count: 0, // Would need to fetch from instance
          interaction_count: count
        }))
        .sort((a, b) => b.interaction_count - a.interaction_count)
        .slice(0, limit);

      return discovered;
    } catch (error) {
      debug.error('Failed to get discovered instances:', error);
      return [];
    }
  }

  /**
   * Refresh instance information
   */
  async refreshInstanceInfo(instanceId: string): Promise<FederatedInstance> {
    try {
      // Get current instance
      const { data: instance, error: fetchError } = await supabase
        .from('federated_instances')
        .select('*')
        .eq('id', instanceId)
        .single();

      if (fetchError) throw fetchError;

      // Fetch updated info
      const updatedInfo = await this.discoverInstance(instance.domain);
      
      if (updatedInfo) {
        const { data: connectionRows } = await supabase.rpc(
          'get_federated_instance_connection_counts',
          { p_domains: [instance.domain] }
        );
        const connectionCount = Number(connectionRows?.[0]?.connection_count) || 0;

        const { data, error } = await supabase
          .from('federated_instances')
          .update({
            software: updatedInfo.software || instance.software,
            version: updatedInfo.version || instance.version,
            description: updatedInfo.description || instance.description,
            admin_contact: updatedInfo.admin_contact || instance.admin_contact,
            user_count: updatedInfo.user_count || instance.user_count,
            status_count: updatedInfo.status_count || instance.status_count,
            connection_count: connectionCount,
            last_seen_at: new Date().toISOString(),
            metadata: {
              ...instance.metadata,
              last_refresh: new Date().toISOString(),
              api_available: updatedInfo.api_available,
              federation_enabled: updatedInfo.federation_enabled ?? instance.metadata?.federation_enabled,
              ...(updatedInfo.icon_url && { icon_url: updatedInfo.icon_url }),
              ...(updatedInfo.banner_url && { banner_url: updatedInfo.banner_url }),
            }
          })
          .eq('id', instanceId)
          .select()
          .single();

        if (error) throw error;
        return data;
      }

      return instance;
    } catch (error) {
      debug.error('Failed to refresh instance info:', error);
      throw error;
    }
  }

  /**
   * Get servers that a user is a member of
   */
  async getUserServers(userId: string): Promise<{
    id: string;
    name: string;
    icon_url: string | null;
    member_count: number;
    owner_id: string;
    is_owner: boolean;
    joined_at: string;
  }[]> {
    try {
      // Get user's server memberships with server details
      const { data, error } = await supabase
        .from('user_servers')
        .select(`
          created_at,
          server_id,
          servers (
            id,
            name,
            icon,
            owner
          )
        `)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const memberships = (data || []) as unknown as Array<{ created_at: string; server_id: string; servers: { id: string; name: string; icon: string | null; owner: string } | null }>;
      const servers = memberships.map((m) => m.servers).filter(Boolean) as Array<{ id: string; name: string; icon: string | null; owner: string }>;
      if (servers.length === 0) return [];

      // Batch-fetch member counts (avoids N+1)
      const serverIds = servers.map((s) => s.id);
      const { data: countRows } = await supabase.rpc('get_server_member_counts', {
        p_server_ids: serverIds
      });
      const countMap = new Map<string, number>();
      if (countRows) {
        for (const row of countRows as { server_id: string; member_count: string }[]) {
          countMap.set(row.server_id, Number(row.member_count) || 0);
        }
      }

      return memberships
        .filter((m) => m.servers)
        .map((membership) => {
          const server = membership.servers!;
          return {
            id: server.id,
            name: server.name,
            icon_url: server.icon,
            member_count: countMap.get(server.id) ?? 0,
            owner_id: server.owner,
            is_owner: server.owner === userId,
            joined_at: membership.created_at
          };
        });
    } catch (error) {
      debug.error('Failed to get user servers:', error);
      return [];
    }
  }

  /**
   * Get public servers for admin (featured communities management)
   */
  async getPublicServersForAdmin(): Promise<Array<{
    id: string;
    name: string;
    description?: string;
    icon?: string;
    is_featured: boolean;
    featured_order: number;
    member_count?: number;
  }>> {
    try {
      const { data: servers, error } = await supabase
        .from('servers')
        .select('id, name, description, icon, is_featured, featured_order')
        .eq('public', true)
        .neq('is_local_server', false)
        .order('is_featured', { ascending: false })
        .order('featured_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      const list = servers || [];
      if (list.length === 0) return [];

      // Batch-fetch member counts (avoids N+1)
      const serverIds = list.map((s) => s.id);
      const { data: countRows } = await supabase.rpc('get_server_member_counts', {
        p_server_ids: serverIds
      });
      const countMap = new Map<string, number>();
      if (countRows) {
        for (const row of countRows as { server_id: string; member_count: string }[]) {
          countMap.set(row.server_id, Number(row.member_count) || 0);
        }
      }

      return list.map((s) => ({ ...s, member_count: countMap.get(s.id) ?? 0 }));
    } catch (error) {
      debug.error('Failed to get public servers for admin:', error);
      return [];
    }
  }

  /**
   * Set server featured status (instance admin only)
   */
  async setServerFeatured(
    serverId: string,
    isFeatured: boolean,
    order = 0
  ): Promise<void> {
    const { error } = await supabase.rpc('set_server_featured', {
      p_server_id: serverId,
      p_is_featured: isFeatured,
      p_order: order,
    });
    if (error) throw error;
  }

  // ============================================================================
  // FEDERATION MAINTENANCE
  // ============================================================================

  /**
   * Get key consistency report for local users
   * Returns users with missing or inconsistent key pairs
   */
  async getKeyConsistencyReport(): Promise<{
    users_missing_keys: number;
    users_with_inconsistent_keys: number;
    inconsistent_users: Array<{
      user_id: string;
      username: string;
      has_public_key: boolean;
      has_private_key: boolean;
    }>;
    status: 'ok' | 'needs_attention';
  }> {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Not authenticated');
      }
      const response = await fetch('/api/federation/health/key-consistency', {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch key consistency: ${response.statusText}`);
      }

      const data = await response.json();
      
      return {
        users_missing_keys: data.users_missing_keys || 0,
        users_with_inconsistent_keys: data.users_with_inconsistent_keys || 0,
        inconsistent_users: data.inconsistent_users || [],
        status: (data.users_missing_keys === 0 && data.users_with_inconsistent_keys === 0) 
          ? 'ok' 
          : 'needs_attention',
      };
    } catch (error) {
      debug.error('Failed to get key consistency report:', error);
      throw error;
    }
  }

  /**
   * Trigger a maintenance task via the federation backend
   * @param task - The maintenance task to run
   */
  async triggerMaintenanceTask(
    task: 'keygen-sweep' | 'cleanup-orphans'
  ): Promise<{ success: boolean; job_id?: string; message: string }> {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return { success: false, message: 'Not authenticated' };
      }
      const response = await fetch('/api/federation/health/maintenance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ task }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to trigger maintenance: ${response.statusText}`);
      }

      const data = await response.json();
      
      debug.log(`Maintenance task '${task}' triggered:`, data);
      
      return {
        success: true,
        job_id: data.job_id,
        message: data.message || `Maintenance task '${task}' has been queued`,
      };
    } catch (error) {
      debug.error('Failed to trigger maintenance task:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Run key generation sweep - generates missing keys for local users
   */
  async runKeyGenerationSweep(): Promise<{ success: boolean; message: string }> {
    return this.triggerMaintenanceTask('keygen-sweep');
  }

  /**
   * Run orphan cleanup - fixes inconsistent key states
   */
  async runOrphanedKeyCleanup(): Promise<{ success: boolean; message: string }> {
    return this.triggerMaintenanceTask('cleanup-orphans');
  }
}

// Export singleton instance
export const adminService = new AdminService(); 