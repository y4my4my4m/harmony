/**
 * Presence Context Manager - Manages context-based user presence subscriptions
 * 
 * This service integrates with the unified app service to automatically manage
 * presence subscriptions based on the user's current context (server, DM, ActivityPub).
 * 
 * Features:
 * - Automatic context detection and subscription management
 * - Integration with unified app service
 * - Smart user discovery for different contexts
 * - Cleanup and transition handling
 */

import { globalPresenceService } from './globalPresenceService'
import { globalUserProfileService } from './globalUserProfileService'
// We'll define this interface since the unified app service type isn't properly exported
interface UnifiedAppService {
  currentContextInfo: any
  state: any
}

export interface ContextInfo {
  type: 'server' | 'dm' | 'activitypub' | 'unknown'
  serverId?: string
  channelId?: string
  conversationId?: string
  timeline?: string
  participants?: string[]
}

export interface ContextUserProvider {
  getServerMembers(serverId: string): Promise<string[]>
  getDMParticipants(conversationId: string): Promise<string[]>
  getActivityPubUsers(timeline?: string): Promise<string[]>
}

class PresenceContextManager {
  private currentContext: string | null = null
  private currentContextInfo: ContextInfo | null = null
  private userProvider: ContextUserProvider | null = null
  private unifiedAppService: UnifiedAppService | null = null

  /**
   * Initialize the context manager
   */
  initialize(
    unifiedAppService: UnifiedAppService,
    userProvider: ContextUserProvider
  ): void {
    this.unifiedAppService = unifiedAppService
    this.userProvider = userProvider
    
    console.log('🎯 Presence context manager initialized')
  }

  /**
   * Update context and manage subscriptions accordingly
   */
  async updateContext(contextInfo: ContextInfo): Promise<void> {
    const newContextId = this.generateContextId(contextInfo)
    
    // Skip if context hasn't changed
    if (this.currentContext === newContextId) {
      return
    }

    console.log(`🔄 Context changing: ${this.currentContext} → ${newContextId}`)

    // Unsubscribe from previous context
    if (this.currentContext) {
      globalPresenceService.unsubscribeFromContext(this.currentContext)
    }

    // Update current context
    this.currentContext = newContextId
    this.currentContextInfo = contextInfo

    // Subscribe to new context
    if (contextInfo.type !== 'unknown') {
      await this.subscribeToCurrentContext()
    }
  }

  /**
   * Get users for the current context
   */
  async getCurrentContextUsers(): Promise<string[]> {
    if (!this.currentContextInfo || !this.userProvider) {
      console.log('📭 No current context info or user provider')
      return []
    }

    const { type, serverId, conversationId, timeline } = this.currentContextInfo
    console.log(`🔍 Getting users for context: ${type}, serverId: ${serverId}, conversationId: ${conversationId}`)

    try {
      switch (type) {
        case 'server':
          if (serverId) {
            const users = await this.userProvider.getServerMembers(serverId)
            console.log(`📊 Found ${users.length} server members:`, users)
            return users
          }
          break

        case 'dm':
          if (conversationId) {
            const users = await this.userProvider.getDMParticipants(conversationId)
            console.log(`📊 Found ${users.length} DM participants:`, users)
            return users
          }
          break

        case 'activitypub': {
          const users = await this.userProvider.getActivityPubUsers(timeline)
          console.log(`📊 Found ${users.length} ActivityPub users:`, users)
          return users
        }

        default:
          console.log('❓ Unknown context type:', type)
          return []
      }
    } catch (error) {
      console.error(`Failed to get users for context ${type}:`, error)
    }

    return []
  }

  /**
   * Manually add users to current context subscription
   */
  addUsersToCurrentContext(userIds: string[]): void {
    if (!this.currentContext || userIds.length === 0) return

    // Get existing users and add new ones
    this.getCurrentContextUsers().then(existingUsers => {
      const allUsers = [...new Set([...existingUsers, ...userIds])]
      this.subscribeToUsers(allUsers)
    })
  }

  /**
   * Remove users from current context subscription
   */
  removeUsersFromCurrentContext(userIds: string[]): void {
    if (!this.currentContext || userIds.length === 0) return

    // This is handled automatically when the context is updated
    // For manual removal, we'd need to re-subscribe with filtered users
    console.log(`🗑️ Users removed from context: ${userIds.join(', ')}`)
  }

  /**
   * Refresh current context subscription
   */
  async refreshCurrentContext(): Promise<void> {
    if (this.currentContextInfo) {
      await this.subscribeToCurrentContext()
    }
  }

  /**
   * Clear all context subscriptions
   */
  clearContext(): void {
    if (this.currentContext) {
      globalPresenceService.unsubscribeFromContext(this.currentContext)
      this.currentContext = null
      this.currentContextInfo = null
    }
  }

  /**
   * Get current context information
   */
  getCurrentContext(): ContextInfo | null {
    return this.currentContextInfo
  }

  // Private methods

  private async subscribeToCurrentContext(): Promise<void> {
    if (!this.currentContext || !this.currentContextInfo) return

    const users = await this.getCurrentContextUsers()
    
    if (users.length > 0) {
      this.subscribeToUsers(users)
      
      // Also ensure we have profile data for these users
      await globalUserProfileService.ensureProfilesAvailable(users)
    }
  }

  private subscribeToUsers(userIds: string[]): void {
    if (!this.currentContext || !this.currentContextInfo) return

    const priority = this.getContextPriority(this.currentContextInfo.type)
    
    // Map 'unknown' to 'global' for the global presence service
    const contextType = this.currentContextInfo.type === 'unknown' 
      ? 'global' 
      : this.currentContextInfo.type
    
    console.log(`📡 Subscribing to ${userIds.length} users in context: ${this.currentContext}`)
    console.log(`📡 Context type: ${contextType}, user IDs:`, userIds)
    
    globalPresenceService.subscribeToContext(
      this.currentContext,
      contextType as 'server' | 'dm' | 'activitypub' | 'global',
      userIds,
      priority
    )

    console.log(`📡 Subscribed to ${userIds.length} users in context: ${this.currentContext}`)
  }

  private generateContextId(contextInfo: ContextInfo): string {
    const { type, serverId, channelId, conversationId, timeline } = contextInfo

    switch (type) {
      case 'server':
        return `server:${serverId}${channelId ? `:${channelId}` : ''}`
      
      case 'dm':
        return `dm:${conversationId}`
      
      case 'activitypub':
        return `activitypub:${timeline || 'home'}`
      
      default:
        return `unknown:${Date.now()}`
    }
  }

  private getContextPriority(type: ContextInfo['type']): number {
    switch (type) {
      case 'dm': return 3 // Highest priority - direct messages
      case 'server': return 2 // High priority - current server
      case 'activitypub': return 1 // Lower priority - social feed
      default: return 0
    }
  }
}

// Default user provider implementation
export class DefaultContextUserProvider implements ContextUserProvider {
  async getServerMembers(serverId: string): Promise<string[]> {
    // This will be implemented to use the server users service
    try {
      const { getUserIdsForServer } = await import('@/services/usersService')
      return await getUserIdsForServer(serverId)
    } catch (error) {
      console.error('Failed to get server members:', error)
      return []
    }
  }

  async getDMParticipants(conversationId: string): Promise<string[]> {
    // This will be implemented to get DM participants
    try {
      const { useDMStore } = await import('@/stores/useDM')
      const dmStore = useDMStore()
      const conversation = dmStore.conversations.find(c => c.id === conversationId)
      if (conversation) {
        // Return the participants (excluding current user)
        return [conversation.user1_id, conversation.user2_id]
      }
      return []
    } catch (error) {
      console.error('Failed to get DM participants:', error)
      return []
    }
  }

  async getActivityPubUsers(): Promise<string[]> {
    // This will be implemented to get ActivityPub users based on timeline
    try {
      const { useActivityPubStore } = await import('@/stores/useActivityPub')
      const activityPubStore = useActivityPubStore()
      
      // Return users from current feed/following list
      const followedUsers = Array.from(activityPubStore.followedUsers || [])
      return followedUsers
    } catch (error) {
      console.error('Failed to get ActivityPub users:', error)
      return []
    }
  }
}

// Export singleton instance
export const presenceContextManager = new PresenceContextManager()
