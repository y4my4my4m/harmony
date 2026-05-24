/**
 * Professional Server Membership Service
 * Handles real-time user join/leave events with Discord-like functionality
 */

import { supabase } from '@/supabase'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { getUserIdsForServer } from '@/services/usersService'
import { debug } from '@/utils/debug'

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
  onUserKick?: (event: MembershipEvent) => void
  onUserBan?: (event: MembershipEvent) => void
  onError?: (error: Error) => void
}

export class MembershipService {
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
   * Handle a membership event from the server-structure broadcast channel.
   * Called by useServerChannel when it receives a membership:event broadcast.
   */
  async handleBroadcastEvent(event: MembershipEvent): Promise<void> {
    await this.handleMembershipEvent(event)
  }

  /**
   * Cleanup (no-op - CDC subscriptions removed, events come via server-structure broadcast)
   */
  cleanup(): void {
    // No CDC channels to clean up
  }

  /**
   * Handle incoming membership events
   */
  private async handleMembershipEvent(event: MembershipEvent): Promise<void> {
    try {
      debug.log(`👥 Processing ${event.event_type} event for user ${event.user_id} in server ${event.server_id}`)
      
      if (event.event_type === 'join') {
        await this.handleUserJoin(event)
        this.options.onUserJoin?.(event)
      } else if (event.event_type === 'leave') {
        await this.handleUserLeave(event)
        this.options.onUserLeave?.(event)
      } else if (event.event_type === 'kick') {
        await this.handleUserRemoved(event)
        this.options.onUserKick?.(event)
      } else if (event.event_type === 'ban') {
        await this.handleUserRemoved(event)
        this.options.onUserBan?.(event)
      }
    } catch (error) {
      debug.error('❌ Error handling membership event:', error)
      this.options.onError?.(error as Error)
    }
  }

  /**
   * Handle user join events
   */
  private async handleUserJoin(event: MembershipEvent): Promise<void> {
    debug.log(`🎉 User ${event.metadata.username || event.user_id} joined server ${event.server_id}`)
    
    // Refresh the user list to include the new member
    await this.refreshServerUserList(event.server_id)
    
    // Show a toast notification if this is for the current server
    // (This could be extended to show notifications in the UI)
  }

  /**
   * Handle user leave events
   */
  private async handleUserLeave(event: MembershipEvent): Promise<void> {
    debug.log(`👋 User ${event.metadata.username || event.user_id} left server ${event.server_id}`)
    
    // Refresh the complete user list to ensure consistency
    await this.refreshServerUserList(event.server_id)
  }

  private async handleUserRemoved(event: MembershipEvent): Promise<void> {
    const action = event.event_type === 'ban' ? 'banned from' : 'kicked from'
    debug.log(`🔨 User ${event.user_id} ${action} server ${event.server_id}`)
    await this.refreshServerUserList(event.server_id)
  }

  /**
   * Refresh the user list for a specific server
   */
  private async refreshServerUserList(serverId: string): Promise<void> {
    try {
      debug.log(`🔄 Refreshing user list for server: ${serverId}`)
      
      // Get current server members
      const userIds = await getUserIdsForServer(serverId)
      
      // Update the store with fresh user data
      await this.getServerUsersStore().fetchUserProfiles(userIds)
      
      debug.log(`✅ User list refreshed for server ${serverId}. Current members: ${userIds.length}`)
    } catch (error) {
      debug.error('❌ Error refreshing server user list:', error)
      this.options.onError?.(error as Error)
    }
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
      debug.error('Error fetching membership history:', error)
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
        debug.log(`🎉 ${event.metadata.display_name || event.metadata.username} joined the server!`)
      },
      onUserLeave: (event) => {
        debug.log(`👋 ${event.metadata.display_name || event.metadata.username} left the server`)
      },
      onError: (error) => {
        debug.error('🚨 Membership service error:', error)
      }
    })
  }
  return _membershipServiceInstance
}
