import { supabase } from '@/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { useServerChannelStore } from '@/stores/useServerChannel'

// Types for server membership events
export interface ServerMembershipEvent {
  id: string
  server_id: string
  user_id: string
  event_type: 'join' | 'leave' | 'kick' | 'ban'
  initiated_by?: string
  metadata: Record<string, any>
  created_at: string
}

export interface MembershipChangePayload {
  type: 'user_joined' | 'user_left'
  server_id: string
  user_id: string
  event_id: string
  timestamp: string
}

/**
 * Professional server membership service similar to Discord
 * Handles real-time user join/leave events, system messages, and user list updates
 */
export class ServerMembershipService {
  private static instance: ServerMembershipService
  private membershipChannels = new Map<string, RealtimeChannel>()
  private pgNotifyChannel: RealtimeChannel | null = null
  
  private constructor() {}

  static getInstance(): ServerMembershipService {
    if (!ServerMembershipService.instance) {
      ServerMembershipService.instance = new ServerMembershipService()
    }
    return ServerMembershipService.instance
  }

  /**
   * Initialize membership tracking for a server
   */
  async subscribeToServerMembership(serverId: string): Promise<void> {
    // Clean up existing subscription for this server
    const existingChannel = this.membershipChannels.get(serverId)
    if (existingChannel) {
      await supabase.removeChannel(existingChannel)
    }

    // Subscribe to membership events for this server
    const membershipChannel = supabase
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
          const event = payload.new as ServerMembershipEvent
          await this.handleMembershipEvent(event)
        }
      )
      .subscribe((status) => {
        console.log(`🔔 Server membership subscription for ${serverId}:`, status)
        
        if (status === 'CHANNEL_ERROR') {
          console.error('❌ Membership subscription error, retrying in 5s...')
          setTimeout(() => {
            this.subscribeToServerMembership(serverId)
          }, 5000)
        }
      })

    this.membershipChannels.set(serverId, membershipChannel)
  }

  /**
   * Initialize global membership notifications (PostgreSQL NOTIFY)
   */
  async subscribeToGlobalMembershipChanges(): Promise<void> {
    if (this.pgNotifyChannel) {
      await supabase.removeChannel(this.pgNotifyChannel)
    }

    this.pgNotifyChannel = supabase
      .channel('server-membership-global')
      .on('postgres_changes', 
        { 
          event: 'INSERT', 
          schema: 'public', 
          table: 'server_membership_events' 
        },
        async (payload) => {
          const event = payload.new as ServerMembershipEvent
          await this.handleRealTimeMembershipChange(event)
        }
      )
      .subscribe((status) => {
        console.log('🌐 Global membership subscription:', status)
      })
  }

  /**
   * Handle membership events (join/leave)
   */
  private async handleMembershipEvent(event: ServerMembershipEvent): Promise<void> {
    const serverUsersStore = useServerUsersStore()
    const serverChannelStore = useServerChannelStore()
    
    console.log('👥 Membership event:', event)

    try {
      switch (event.event_type) {
        case 'join':
          await this.handleUserJoined(event)
          break
        case 'leave':
          await this.handleUserLeft(event)
          break
        case 'kick':
        case 'ban':
          await this.handleUserRemoved(event)
          break
      }
    } catch (error) {
      console.error('❌ Error handling membership event:', error)
    }
  }

  /**
   * Handle real-time membership changes via PostgreSQL NOTIFY
   */
  private async handleRealTimeMembershipChange(event: ServerMembershipEvent): Promise<void> {
    const serverUsersStore = useServerUsersStore()
    
    // Fetch the user profile immediately to update the user list
    if (event.event_type === 'join') {
      try {
        await serverUsersStore.fetchUserProfiles([event.user_id])
        console.log(`✅ User profile fetched for new member: ${event.user_id}`)
      } catch (error) {
        console.error('❌ Error fetching new user profile:', error)
      }
    }
  }

  /**
   * Handle user joined event
   */
  private async handleUserJoined(event: ServerMembershipEvent): Promise<void> {
    const serverUsersStore = useServerUsersStore()
    const serverChannelStore = useServerChannelStore()
    
    // Fetch user profile and add to user list
    await serverUsersStore.fetchUserProfiles([event.user_id])
    
    // If this is the current server, refresh the server users
    if (serverChannelStore.currentServerId === event.server_id) {
      console.log(`🎉 User ${event.user_id} joined current server`)
      
      // You could add additional UI feedback here like:
      // - Show a toast notification
      // - Play a sound
      // - Add visual feedback
    }
  }

  /**
   * Handle user left event
   */
  private async handleUserLeft(event: ServerMembershipEvent): Promise<void> {
    const serverUsersStore = useServerUsersStore()
    const serverChannelStore = useServerChannelStore()
    
    // If this is the current server, we might want to remove from user list
    if (serverChannelStore.currentServerId === event.server_id) {
      console.log(`👋 User ${event.user_id} left current server`)
      
      // Clean up user from voice channels if they were in any
      await serverUsersStore.leaveAllVoiceChannels(event.server_id, event.user_id)
      
      // You could add additional cleanup here
    }
  }

  /**
   * Handle user removed (kicked/banned) event
   */
  private async handleUserRemoved(event: ServerMembershipEvent): Promise<void> {
    console.log(`🚫 User ${event.user_id} was ${event.event_type} from server ${event.server_id}`)
    
    // Handle similar to user left but with different messaging
    await this.handleUserLeft(event)
  }

  /**
   * Manually trigger a user join (for testing or manual invites)
   */
  async triggerUserJoin(serverId: string, userId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('user_servers')
        .insert([{ 
          server_id: serverId, 
          user_id: userId,
          created_at: new Date().toISOString()
        }])

      if (error) throw error
      
      console.log(`✅ User ${userId} manually added to server ${serverId}`)
      return true
    } catch (error) {
      console.error('❌ Error manually adding user to server:', error)
      return false
    }
  }

  /**
   * Manually trigger a user leave
   */
  async triggerUserLeave(serverId: string, userId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('user_servers')
        .delete()
        .eq('server_id', serverId)
        .eq('user_id', userId)

      if (error) throw error
      
      console.log(`✅ User ${userId} manually removed from server ${serverId}`)
      return true
    } catch (error) {
      console.error('❌ Error manually removing user from server:', error)
      return false
    }
  }

  /**
   * Get membership history for a server
   */
  async getMembershipHistory(serverId: string, limit: number = 50): Promise<ServerMembershipEvent[]> {
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
      console.error('❌ Error fetching membership history:', error)
      return []
    }
  }

  /**
   * Clean up subscriptions for a server
   */
  async unsubscribeFromServer(serverId: string): Promise<void> {
    const channel = this.membershipChannels.get(serverId)
    if (channel) {
      await supabase.removeChannel(channel)
      this.membershipChannels.delete(serverId)
    }
  }

  /**
   * Clean up all subscriptions
   */
  async cleanup(): Promise<void> {
    // Clean up all server membership channels
    for (const channel of this.membershipChannels.values()) {
      await supabase.removeChannel(channel)
    }
    this.membershipChannels.clear()

    // Clean up global channel
    if (this.pgNotifyChannel) {
      await supabase.removeChannel(this.pgNotifyChannel)
      this.pgNotifyChannel = null
    }
  }
}

// Export singleton instance
export const serverMembershipService = ServerMembershipService.getInstance()
