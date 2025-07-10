/**
 * AdminService - Professional service for admin panel operations
 * Handles all admin-related database queries and operations
 */

import { supabase } from '@/supabase';

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
}

export interface AdminUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  created_at: string;
  updated_at?: string;
  domain?: string;
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
      console.error('Failed to get system stats:', error);
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
        instancesResult
      ] = await Promise.all([
        supabase.from('delivery_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('delivery_queue').select('*', { count: 'exact', head: true }).eq('status', 'delivered'),
        supabase.from('delivery_queue').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
        supabase.from('federated_instances').select('*', { count: 'exact', head: true }).eq('is_blocked', false)
      ]);

      return {
        pending_deliveries: pendingResult.count || 0,
        successful_deliveries: successfulResult.count || 0,
        failed_deliveries: failedResult.count || 0,
        active_instances: instancesResult.count || 0
      };
    } catch (error) {
      console.error('Failed to get federation stats:', error);
      // Return safe defaults on error
      return {
        pending_deliveries: 0,
        successful_deliveries: 0,
        failed_deliveries: 0,
        active_instances: 0
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
      console.error('Failed to get system health:', error);
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
          if (!user.domain || user.domain === 'har.mony.lol') {
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
            handle: user.domain && user.domain !== 'har.mony.lol' 
              ? `@${user.username}@${user.domain}` 
              : `@${user.username}`
          };
        })
      );

      return usersWithCounts;
    } catch (error) {
      console.error('Failed to get users:', error);
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
      console.error('Failed to get recent activity:', error);
      return [];
    }
  }

  /**
   * Moderate a user (suspend, unsuspend, delete)
   */
  async moderateUser(
    userId: string, 
    action: 'suspend' | 'unsuspend' | 'delete', 
    reason: string,
    adminId: string
  ): Promise<void> {
    try {
      // Handle user moderation using direct queries
      switch (action) {
        case 'suspend': {
          const { error: suspendError } = await supabase
            .from('profiles')
            .update({
              is_suspended: true,
              suspended_at: new Date().toISOString(),
              suspension_reason: reason
            })
            .eq('id', userId);
          
          if (suspendError) throw suspendError;
          break;
        }

        case 'unsuspend': {
          const { error: unsuspendError } = await supabase
            .from('profiles')
            .update({
              is_suspended: false,
              suspended_at: null,
              suspension_reason: null
            })
            .eq('id', userId);
          
          if (unsuspendError) throw unsuspendError;
          break;
        }

        case 'delete': {
          // Soft delete - mark as deleted but don't actually remove
          const { error: deleteError } = await supabase
            .from('profiles')
            .update({
              is_suspended: true,
              suspended_at: new Date().toISOString(),
              suspension_reason: `DELETED: ${reason}`
            })
            .eq('id', userId);
          
          if (deleteError) throw deleteError;
          break;
        }

        default:
          throw new Error(`Unknown moderation action: ${action}`);
      }
    } catch (error) {
      console.error('Failed to moderate user:', error);
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
      console.error('Failed to moderate instance:', error);
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
      console.error('Failed to get blocked instances:', error);
      return [];
    }
  }

  /**
   * Get instance configuration
   */
  async getInstanceConfig(): Promise<any> {
    try {
      // For now, return default configuration since we don't have a config table yet
      // In the future, this would query an instance_config table
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
        instance: {
          name: 'Harmony Instance',
          description: 'A federated social platform',
          domain: 'har.mony.lol',
          registrationOpen: true,
          requiresApproval: false
        }
      };
    } catch (error) {
      console.error('Failed to get instance config:', error);
      return null;
    }
  }

  /**
   * Set instance configuration key-value pair
   */
  async setInstanceConfig(
    key: string, 
    value: any, 
    adminId: string, 
    description?: string
  ): Promise<void> {
    try {
      // For now, log the config change since we don't have a config table yet
      console.log(`Config update request: ${key} = ${value} by ${adminId}`);
      
      // In the future, this would update an instance_config table
      // await supabase.from('instance_config').upsert({
      //   config_key: key,
      //   config_value: value,
      //   updated_by: adminId,
      //   description
      // }, { onConflict: 'config_key' });
      
      // For now, just succeed silently
    } catch (error) {
      console.error('Failed to set instance config:', error);
      throw error;
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
      console.error('Failed to set instance configs:', error);
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
      console.error('Failed to check admin permissions:', error);
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
      console.error('Failed to export logs:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const adminService = new AdminService(); 