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

export interface AdminUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  created_at: string;
  updated_at?: string;
  domain?: string;
  is_local?: boolean; // Indicates if the user is local or remote
  is_admin: boolean;
  is_suspended: boolean;
  suspended_at?: string;
  suspension_reason?: string;
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

      return {
        database: { 
          responseTime: dbResponseTime, 
          connections: 25 // Mock - would come from DB monitoring
        },
        federation: { 
          pending: federationStats.pending_deliveries, 
          status: federationStats.pending_deliveries > 100 ? 'warning' : 'healthy' 
        },
        storage: { used: 45, total: '100GB' }, // Mock
        memory: { used: 72, total: '16GB' } // Mock
      };
    } catch (error) {
      debug.error('Failed to get system health:', error);
      throw error;
    }
  }

  /**
   * Get users with admin-relevant information
   */
  async getUsers(limit: number = 100): Promise<AdminUser[]> {
    try {
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
          is_suspended,
          suspended_at,
          suspension_reason,
          federated_id
        `)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      // Transform data to include post and server counts
      const usersWithCounts = await Promise.all(
        (data || []).map(async (user) => {
          // Get user's post count
          const { count: postCount } = await supabase
            .from('posts')
            .select('*', { count: 'exact', head: true })
            .eq('author_id', user.id);

          // Get user's server count (for local users)
          let serverCount = 0;
          if (user.is_local) {
            const { count } = await supabase
              .from('user_servers')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', user.id);
            serverCount = count || 0;
          }

          return {
            ...user,
            ap_actor_id: undefined, // Not available in current schema
            postCount: postCount || 0,
            serverCount,
            handle: !user.is_local
              ? `@${user.username}@${user.domain}` 
              : `@${user.username}`
          };
        })
      );

      return usersWithCounts;
    } catch (error) {
      debug.error('Failed to get users:', error);
      throw error;
    }
  }

  /**
   * Get recent admin activity
   */
  async getRecentActivity(limit: number = 20): Promise<AdminActivity[]> {
    try {
      // For now, simulate recent activity from various system events
      // In a real system, this would come from an admin_logs table
      const mockActivity: AdminActivity[] = [
        {
          id: '1',
          admin_id: 'admin-1',
          admin_username: 'admin',
          action_type: 'user_moderation',
          target_type: 'user',
          target_id: undefined,
          details: 'System initialized',
          metadata: {},
          ip_address: '127.0.0.1',
          user_agent: 'Harmony Admin Panel',
          created_at: new Date().toISOString()
        }
      ];

      return mockActivity.slice(0, limit);
    } catch (error) {
      debug.error('Failed to get recent activity:', error);
      return [];
    }
  }

  /**
   * Moderate a user (suspend, unsuspend, delete)
   * Uses the moderate_user RPC function which has SECURITY DEFINER
   * to bypass RLS policies and allow admins to moderate other users
   */
  async moderateUser(
    userId: string, 
    action: 'suspend' | 'unsuspend' | 'delete', 
    reason: string,
    adminId: string
  ): Promise<void> {
    try {
      // Use the RPC function which has SECURITY DEFINER to bypass RLS
      // The moderate_user function checks admin permissions internally
      let rpcAction = action;
      let rpcReason = reason;

      // Handle delete as a special case of suspend with DELETED prefix
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
    } catch (error) {
      debug.error('Failed to moderate user:', error);
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

      try {
        const { data: configData } = await supabase
          .from('instance_config')
          .select('config_key, config_value')
          .in('config_key', ['instance_name', 'instance_description', 'domain', 'open_registration', 'approval_required'])

        if (configData) {
          configData.forEach((config) => {
            try {
              // Parse JSONB value - it may be a string with quotes or already parsed
              let value = config.config_value
              if (typeof value === 'string') {
                // Try to parse if it's a JSON string
                try {
                  value = JSON.parse(value)
                } catch {
                  // If parsing fails, use the string as-is (remove quotes if present)
                  value = value.replace(/^"|"$/g, '')
                }
              }

              switch (config.config_key) {
                case 'instance_name':
                  instanceName = value || 'Harmony Instance'
                  break
                case 'instance_description':
                  instanceDescription = value || 'A federated social platform'
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
          maxServerSize: 1000,
          maxMessageLength: 2000,
          allowFileUploads: true,
          enableVoiceChannels: true
        },
        federation: {
          maxPostLength: 500,
          retryAttempts: 3,
          enableOutbound: true,
          enableInbound: true
        },
        webrtc: webrtcSettings,
        instance: {
          name: instanceName,
          description: instanceDescription,
          domain: domain,
          registrationOpen: registrationOpen,
          requiresApproval: requiresApproval
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
      const { error } = await supabase
        .from('instance_webrtc_settings')
        .upsert({
          webrtc_mode: settings.mode,
          livekit_url: settings.livekitUrl,
          allow_federated_voice: settings.allowFederatedVoice,
          max_stage_listeners: settings.maxStageListeners,
          updated_at: new Date().toISOString()
        });
      
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
      // If it's already a string, wrap it in quotes for JSONB
      // Otherwise, stringify it
      let jsonbValue: any
      if (typeof value === 'string') {
        // Store as JSON string (with quotes)
        jsonbValue = JSON.stringify(value)
      } else {
        // Store as JSON value
        jsonbValue = value
      }

      const { data, error } = await supabase.rpc('set_instance_config', {
        p_admin_id: adminId,
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
   * Set multiple instance configuration values
   */
  async setInstanceConfigs(configs: Record<string, any>, adminId: string): Promise<void> {
    try {
      // Set each config key-value pair
      for (const [key, value] of Object.entries(configs)) {
        await this.setInstanceConfig(key, value, adminId);
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
      const { data, error } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', userId)
        .single();

      if (error) throw error;

      return data?.is_admin || false;
    } catch (error) {
      debug.error('Failed to check admin permissions:', error);
      return false;
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
      const { error } = await supabase
        .from('federated_instances')
        .update({ 
          is_trusted: trusted,
          metadata: {
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
      const metadata = blocked ? {
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
          metadata
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
  async deleteInstance(instanceId: string, adminId: string): Promise<void> {
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
      // First try to discover instance info
      const instanceInfo = await this.fetchInstanceInfo(domain);
      
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
   * Discover ActivityPub instance by domain
   */
  async discoverInstance(domain: string): Promise<InstanceSearchResult | null> {
    try {
      // Clean up the domain
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
      
      // Try to fetch nodeinfo or instance information
      const instanceInfo = await this.fetchInstanceInfo(cleanDomain);
      
      return instanceInfo;
    } catch (error) {
      debug.error(`Failed to discover instance ${domain}:`, error);
      return null;
    }
  }

  /**
   * Fetch instance information via nodeinfo or mastodon API
   */
  private async fetchInstanceInfo(domain: string): Promise<InstanceSearchResult | null> {
    try {
      // Try nodeinfo 2.0 first (standard)
      const nodeinfoResponse = await fetch(`https://${domain}/.well-known/nodeinfo`);
      if (nodeinfoResponse.ok) {
        const nodeinfo = await nodeinfoResponse.json();
        const links = nodeinfo.links || [];
        
        // Find nodeinfo 2.0 or 2.1 link
        const nodeinfoLink = links.find((link: any) => 
          link.rel === 'http://nodeinfo.diaspora.software/ns/schema/2.0' ||
          link.rel === 'http://nodeinfo.diaspora.software/ns/schema/2.1'
        );
        
        if (nodeinfoLink) {
          // Ensure HTTPS to avoid mixed content issues
          const secureNodeinfoUrl = nodeinfoLink.href.replace(/^http:/, 'https:');
          const infoResponse = await fetch(secureNodeinfoUrl);
          if (infoResponse.ok) {
            const info = await infoResponse.json();
            return {
              domain,
              software: info.software?.name,
              version: info.software?.version,
              description: info.metadata?.description || info.metadata?.shortDescription,
              user_count: info.usage?.users?.total || 0,
              status_count: info.usage?.localPosts || 0,
              admin_contact: info.metadata?.admin?.email,
              api_available: true,
              federation_enabled: true
            };
          }
        }
      }

      // Fallback: Try Mastodon API
      const mastodonResponse = await fetch(`https://${domain}/api/v1/instance`);
      if (mastodonResponse.ok) {
        const instance = await mastodonResponse.json();
        return {
          domain,
          software: 'mastodon',
          version: instance.version,
          description: instance.description,
          user_count: instance.stats?.user_count || 0,
          status_count: instance.stats?.status_count || 0,
          admin_contact: instance.contact_account?.acct,
          api_available: true,
          federation_enabled: true
        };
      }

      // Basic ActivityPub check
      const actorResponse = await fetch(`https://${domain}/actor`, {
        headers: { 'Accept': 'application/activity+json' }
      });
      
      if (actorResponse.ok) {
        return {
          domain,
          software: 'unknown',
          api_available: true,
          federation_enabled: true
        };
      }

      return null;
    } catch (error) {
      debug.error(`Failed to fetch instance info for ${domain}:`, error);
      return null;
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
          federation_enabled: instanceInfo?.federation_enabled || false
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
   * Search for ActivityPub instances online
   */
  async searchActivityPubInstances(query: string): Promise<InstanceSearchResult[]> {
    try {
      // This would integrate with instance discovery services
      // For now, return empty array as this requires external APIs
      
      // TODO: Integrate with:
      // - instances.social API
      // - fediverse.info API
      // - Manual domain validation
      
      debug.log(`Searching for instances matching: ${query}`);
      return [];
    } catch (error) {
      debug.error('Failed to search ActivityPub instances:', error);
      return [];
    }
  }

  /**
   * Get instances from user interactions (follows, posts, etc.)
   */
  async getDiscoveredInstances(limit: number = 20): Promise<{ domain: string; user_count: number; interaction_count: number }[]> {
    try {
      // Get instances that users have interacted with
      const { data, error } = await supabase
        .from('profiles')
        .select('domain')
        .not('domain', 'is', null)
        .neq('domain', import.meta.env.VITE_DOMAIN as string) // Exclude local domain
        
      if (error) throw error;

      // Count instances and interactions
      const instanceCounts = new Map<string, number>();
      
      data?.forEach(profile => {
        if (profile.domain) {
          instanceCounts.set(profile.domain, (instanceCounts.get(profile.domain) || 0) + 1);
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
      const updatedInfo = await this.fetchInstanceInfo(instance.domain);
      
      if (updatedInfo) {
        // Update the instance
        const { data, error } = await supabase
          .from('federated_instances')
          .update({
            software: updatedInfo.software || instance.software,
            version: updatedInfo.version || instance.version,
            description: updatedInfo.description || instance.description,
            admin_contact: updatedInfo.admin_contact || instance.admin_contact,
            user_count: updatedInfo.user_count || instance.user_count,
            status_count: updatedInfo.status_count || instance.status_count,
            last_seen_at: new Date().toISOString(),
            metadata: {
              ...instance.metadata,
              last_refresh: new Date().toISOString(),
              api_available: updatedInfo.api_available
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

      // Get member counts for each server
      const serversWithCounts = await Promise.all(
        (data || []).map(async (membership: any) => {
          const server = membership.servers;
          if (!server) return null;

          // Get member count
          const { count } = await supabase
            .from('user_servers')
            .select('*', { count: 'exact', head: true })
            .eq('server_id', server.id);

          return {
            id: server.id,
            name: server.name,
            icon_url: server.icon, // servers table uses 'icon' not 'icon_url'
            member_count: count || 0,
            owner_id: server.owner, // servers table uses 'owner' not 'owner_id'
            is_owner: server.owner === userId,
            joined_at: membership.created_at // user_servers uses 'created_at' not 'joined_at'
          };
        })
      );

      return serversWithCounts.filter(Boolean) as any[];
    } catch (error) {
      debug.error('Failed to get user servers:', error);
      return [];
    }
  }
}

// Export singleton instance
export const adminService = new AdminService(); 