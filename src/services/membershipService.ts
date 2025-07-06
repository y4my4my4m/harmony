/**
 * Professional Server Membership Service
 * Handles real-time user join/leave events with Discord-like functionality
 */

import { supabase } from '@/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { getUserIdsForServer } from '@/services/usersService'

export interface MembershipEvent {
  id: string
  server_id: string
  user_id: string
  event_type: 'join' | 'leave' | 'kick' | 'ban'
  initiated_by?: string
  metadata: {
    username?: string
    display_name?: string
    joined_at?: string
    left_at?: string
    via_invite?: boolean
  }
  created_at: string
}

export interface MembershipServiceOptions {
  onUserJoin?: (event: MembershipEvent) => void
  onUserLeave?: (event: MembershipEvent) => void
  onError?: (error: Error) => void
}

export class MembershipService {
  private subscriptions: Map<string, RealtimeChannel> = new Map()
  private options: MembershipServiceOptions = {}

  constructor(options: MembershipServiceOptions = {}) {
    this.options = options
  }

  /**
   * Get the server users store instance (lazy initialization to avoid circular dependencies)
   */
  private getServerUsersStore() {
    return useServerUsersStore()
  }

  /**
   * Subscribe to membership events for a specific server
   */
  async subscribeToServer(serverId: string): Promise<void> {
    try {
      // Clean up existing subscription for this server
      this.unsubscribeFromServer(serverId)

      console.log(`🔔 Setting up membership subscription for server: ${serverId}`)

      const channel = supabase
        .channel(`server-membership-${serverId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'server_membership_events',
            filter: `server_id=eq.${serverId}`
          },
          async (payload) => {
            console.log('🚨 Membership event received:', payload)
            await this.handleMembershipEvent(payload.new as MembershipEvent)
          }
        )
        .subscribe((status) => {
          console.log(`📡 Membership subscription status for ${serverId}:`, status)
          if (status === 'SUBSCRIBED') {
            console.log(`✅ Successfully subscribed to membership events for server ${serverId}`)
          } else if (status === 'CHANNEL_ERROR') {
            console.error(`❌ Failed to subscribe to membership events for server ${serverId}`)
            this.options.onError?.(new Error(`Failed to subscribe to membership events for server ${serverId}`))
          }
        })

      this.subscriptions.set(serverId, channel)
    } catch (error) {
      console.error('❌ Error setting up membership subscription:', error)
      this.options.onError?.(error as Error)
    }
  }

  /**
   * Unsubscribe from membership events for a specific server
   */
  unsubscribeFromServer(serverId: string): void {
    const existingChannel = this.subscriptions.get(serverId)
    if (existingChannel) {
      console.log(`🧹 Cleaning up membership subscription for server: ${serverId}`)
      supabase.removeChannel(existingChannel)
      this.subscriptions.delete(serverId)
    }
  }

  /**
   * Subscribe to membership events for multiple servers
   */
  async subscribeToServers(serverIds: string[]): Promise<void> {
    for (const serverId of serverIds) {
      await this.subscribeToServer(serverId)
    }
  }

  /**
   * Unsubscribe from all membership events
   */
  cleanup(): void {
    console.log('🧹 Cleaning up all membership subscriptions')
    for (const [, channel] of this.subscriptions) {
      supabase.removeChannel(channel)
    }
    this.subscriptions.clear()
  }

  /**
   * Handle incoming membership events
   */
  private async handleMembershipEvent(event: MembershipEvent): Promise<void> {
    try {
      console.log(`👥 Processing ${event.event_type} event for user ${event.user_id} in server ${event.server_id}`)
      
      if (event.event_type === 'join') {
        await this.handleUserJoin(event)
        this.options.onUserJoin?.(event)
      } else if (event.event_type === 'leave') {
        await this.handleUserLeave(event)
        this.options.onUserLeave?.(event)
      }
    } catch (error) {
      console.error('❌ Error handling membership event:', error)
      this.options.onError?.(error as Error)
    }
  }

  /**
   * Handle user join events
   */
  private async handleUserJoin(event: MembershipEvent): Promise<void> {
    console.log(`🎉 User ${event.metadata.username || event.user_id} joined server ${event.server_id}`)
    
    // Refresh the user list to include the new member
    await this.refreshServerUserList(event.server_id)
    
    // Show a toast notification if this is for the current server
    // (This could be extended to show notifications in the UI)
  }

  /**
   * Handle user leave events
   */
  private async handleUserLeave(event: MembershipEvent): Promise<void> {
    console.log(`👋 User ${event.metadata.username || event.user_id} left server ${event.server_id}`)
    
    // Refresh the complete user list to ensure consistency
    await this.refreshServerUserList(event.server_id)
  }

  /**
   * Refresh the user list for a specific server
   */
  private async refreshServerUserList(serverId: string): Promise<void> {
    try {
      console.log(`🔄 Refreshing user list for server: ${serverId}`)
      
      // Get current server members
      const userIds = await getUserIdsForServer(serverId)
      
      // Update the store with fresh user data
      await this.getServerUsersStore().fetchUserProfiles(userIds)
      
      console.log(`✅ User list refreshed for server ${serverId}. Current members: ${userIds.length}`)
    } catch (error) {
      console.error('❌ Error refreshing server user list:', error)
      this.options.onError?.(error as Error)
    }
  }

  /**
   * Get active subscriptions (for debugging)
   */
  getActiveSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys())
  }

  /**
   * Get membership events for a server (for history/analytics)
   */
  async getMembershipHistory(serverId: string, limit: number = 50): Promise<MembershipEvent[]> {
    try {
      const { data, error } = await supabase
        .from('server_membership_events')
        .select('*')
        .eq('server_id', serverId)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) throw error
      return data || []
    } catch (error) {
      console.error('Error fetching membership history:', error)
      return []
    }
  }
}

// Singleton instance for global use - lazy initialization to prevent circular dependencies
let _membershipServiceInstance: MembershipService | null = null

export function getMembershipService(): MembershipService {
  if (!_membershipServiceInstance) {
    _membershipServiceInstance = new MembershipService({
      onUserJoin: (event) => {
        console.log(`🎉 ${event.metadata.display_name || event.metadata.username} joined the server!`)
      },
      onUserLeave: (event) => {
        console.log(`👋 ${event.metadata.display_name || event.metadata.username} left the server`)
      },
      onError: (error) => {
        console.error('🚨 Membership service error:', error)
      }
    })
  }
  return _membershipServiceInstance
}
