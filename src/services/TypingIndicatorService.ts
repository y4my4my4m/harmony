/**
 * TypingIndicatorService - Professional typing indicator system using Supabase Realtime presence
 * 
 * Features:
 * - Only tracks typing in current channel/thread/conversation (smart data usage)
 * - Automatically clears typing status after timeout
 * - Uses presence for efficient real-time updates
 * - DRY and reusable across channels, threads, and DMs
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { userDataService } from '@/services/userDataService'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface TypingUser {
  user_id: string
  display_name?: string
  username?: string
  typing_at: string
}

export type TypingContext = 
  | { type: 'channel'; channelId: string }
  | { type: 'thread'; threadId: string }
  | { type: 'conversation'; conversationId: string }

class TypingIndicatorService {
  private currentChannel: RealtimeChannel | null = null
  private currentContext: TypingContext | null = null
  private currentUserId: string | null = null
  private typingTimeout: number | null = null
  private isCurrentlyTyping: boolean = false // Track if we're already showing as typing
  private readonly TYPING_TIMEOUT_MS = 3000 // Clear typing after 3 seconds of inactivity

  // Track typing users per context
  private typingUsers = new Map<string, Set<TypingUser>>()
  
  // Callbacks for when typing users change
  private typingCallbacks = new Map<string, Set<(users: TypingUser[]) => void>>()

  /**
   * Initialize the service with current user ID
   * Will wait for auth session if not immediately available
   */
  async initialize(): Promise<void> {
    // If already initialized, return early
    if (this.currentUserId) {
      return
    }
    
    const authStore = useAuthStore()
    let user = authStore.session?.user
    
    // If no user yet, wait a bit for auth to initialize (up to 3 seconds)
    if (!user) {
      debug.log('⏳ TypingIndicatorService: Waiting for auth session...')
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        user = authStore.session?.user
        if (user) break
      }
    }
    
    if (!user) {
      debug.warn('⚠️ TypingIndicatorService: No user session after waiting, cannot initialize')
      return
    }
    
    this.currentUserId = user.id
    debug.log('✅ TypingIndicatorService initialized for user:', user.id)
  }

  /**
   * Subscribe to typing indicators for a specific context
   * Returns unsubscribe function
   */
  subscribeToTyping(
    context: TypingContext,
    callback: (users: TypingUser[]) => void
  ): () => void {
    const contextKey = this.getContextKey(context)
    
    if (!this.typingCallbacks.has(contextKey)) {
      this.typingCallbacks.set(contextKey, new Set())
    }
    this.typingCallbacks.get(contextKey)!.add(callback)

    // Ensure service is initialized
    if (!this.currentUserId) {
      this.initialize().then(() => {
        // Set up the context after initialization
        this.setupContext(context).then(() => {
          // Trigger initial sync to get current typing users
          this.handlePresenceSync(context)
        }).catch(err => {
          debug.error('❌ TypingIndicatorService: Failed to setup context:', err)
        })
      }).catch(err => {
        debug.error('❌ TypingIndicatorService: Failed to initialize:', err)
      })
    } else {
      // Always set up the context when subscribing (will reuse if already set up)
      this.setupContext(context).then(() => {
        // Trigger initial sync to get current typing users
        this.handlePresenceSync(context)
      }).catch(err => {
        debug.error('❌ TypingIndicatorService: Failed to setup context:', err)
      })
    }

    // Return unsubscribe function
    return () => {
      const callbacks = this.typingCallbacks.get(contextKey)
      if (callbacks) {
        callbacks.delete(callback)
        if (callbacks.size === 0) {
          this.typingCallbacks.delete(contextKey)
        }
      }
    }
  }

  /**
   * Start tracking typing in a specific context
   * Only tracks typing in the current context (smart data usage)
   */
  async startTyping(context: TypingContext): Promise<void> {
    if (!this.currentUserId) {
      await this.initialize()
      if (!this.currentUserId) {
        debug.warn('⚠️ TypingIndicatorService: Cannot start typing, no user ID')
        return
      }
    }

    // Always set up the context first (will reuse if already set up for this context)
    await this.setupContext(context)
    
    // If already typing, just reset the timeout - don't send another event
    if (this.isCurrentlyTyping && this.isSameContext(context, this.currentContext)) {
      // Clear existing timeout and reset it
      if (this.typingTimeout) {
        clearTimeout(this.typingTimeout)
      }
      this.typingTimeout = window.setTimeout(() => {
        this.stopTyping()
      }, this.TYPING_TIMEOUT_MS)
      return
    }

    // Clear existing timeout
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout)
    }

    // Get user display info for presence
    const userData = userDataService.getUser(this.currentUserId)
    const displayName = userData?.displayName || undefined
    const username = userData?.username || undefined

    // Update presence with typing status (only send once)
    if (this.currentChannel) {
      await this.currentChannel.track({
        user_id: this.currentUserId,
        typing: true,
        typing_at: new Date().toISOString(),
        display_name: displayName,
        username: username
      })
      this.isCurrentlyTyping = true
      debug.log('✅ TypingIndicatorService: Typing status set to ON')
    } else {
      debug.warn('⚠️ TypingIndicatorService: No channel available to track typing')
    }

    // Set timeout to clear typing
    this.typingTimeout = window.setTimeout(() => {
      this.stopTyping()
    }, this.TYPING_TIMEOUT_MS)
  }

  /**
   * Stop tracking typing (called automatically after timeout or when sending message)
   */
  async stopTyping(): Promise<void> {
    if (!this.currentUserId || !this.currentChannel || !this.isCurrentlyTyping) return

    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout)
      this.typingTimeout = null
    }

    // Remove typing status from presence
    await this.currentChannel.track({
      user_id: this.currentUserId,
      typing: false
    })
    this.isCurrentlyTyping = false
    debug.log('✅ TypingIndicatorService: Typing status set to OFF')
  }

  /**
   * Set up presence channel for a context
   * Waits for subscription to complete with retry logic for initial page loads
   */
  private async setupContext(context: TypingContext): Promise<void> {
    // If already set up for this context, reuse
    if (this.isSameContext(context, this.currentContext) && this.currentChannel) {
      // Still trigger sync to get current typing users (important for page refresh)
      this.handlePresenceSync(context)
      return
    }

    // Clean up previous context
    await this.cleanupContext()

    this.currentContext = context
    const channelName = this.getChannelName(context)

    debug.log('🔄 TypingIndicatorService: Setting up context:', channelName)

    // Try to subscribe with retry logic
    // On initial page load, Supabase realtime connection might not be ready yet
    const MAX_RETRIES = 5
    const RETRY_DELAY_MS = 500
    const SUBSCRIBE_TIMEOUT_MS = 3000

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const subscribed = await this.subscribeToChannel(context, channelName, SUBSCRIBE_TIMEOUT_MS)
        if (subscribed) {
          debug.log('✅ TypingIndicatorService: Subscribed to', channelName, 'on attempt', attempt)
          return
        }
      } catch (err) {
        debug.warn(`⚠️ TypingIndicatorService: Subscription attempt ${attempt}/${MAX_RETRIES} failed for ${channelName}`)
      }

      // Wait before retrying (except on last attempt)
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      }
    }

    debug.error('❌ TypingIndicatorService: Failed to subscribe after', MAX_RETRIES, 'attempts')
  }

  /**
   * Subscribe to a channel with timeout
   * Returns true if subscription succeeded, false if timed out
   */
  private async subscribeToChannel(context: TypingContext, channelName: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let resolved = false
      
      // Timeout for subscription
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          debug.warn('⏳ TypingIndicatorService: Subscription timed out for', channelName)
          // Clean up the pending channel
          if (this.currentChannel) {
            supabase.removeChannel(this.currentChannel).catch(() => {})
            this.currentChannel = null
          }
          resolve(false)
        }
      }, timeoutMs)

      this.currentChannel = supabase.channel(channelName)
        .on('presence', { event: 'sync' }, () => {
          this.handlePresenceSync(context)
        })
        .on('presence', { event: 'join' }, ({ newPresences }) => {
          this.handlePresenceJoin(context, newPresences)
        })
        .on('presence', { event: 'leave' }, ({ leftPresences }) => {
          this.handlePresenceLeave(context, leftPresences)
        })
        .subscribe((status) => {
          if (resolved) return
          
          if (status === 'SUBSCRIBED') {
            resolved = true
            clearTimeout(timeout)
            this.handlePresenceSync(context)
            resolve(true)
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            resolved = true
            clearTimeout(timeout)
            debug.error('❌ TypingIndicatorService: Channel error for', channelName, '- status:', status)
            reject(new Error(`Channel subscription failed: ${status}`))
          }
        })
    })
  }

  /**
   * Clean up current context
   */
  private async cleanupContext(): Promise<void> {
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout)
      this.typingTimeout = null
    }

    if (this.currentChannel) {
      // Clear typing status if we were typing
      if (this.isCurrentlyTyping) {
        await this.stopTyping()
      }
      await supabase.removeChannel(this.currentChannel)
      this.currentChannel = null
    }

    if (this.currentContext) {
      const contextKey = this.getContextKey(this.currentContext)
      this.typingUsers.delete(contextKey)
      this.currentContext = null
    }
    
    this.isCurrentlyTyping = false
  }

  /**
   * Handle presence sync event
   */
  private handlePresenceSync(context: TypingContext): void {
    if (!this.currentChannel) return

    const contextKey = this.getContextKey(context)
    const presenceState = this.currentChannel.presenceState()
    const typingSet = new Set<TypingUser>()

    // Extract typing users from presence state
    Object.values(presenceState).forEach((presences: any[]) => {
      presences.forEach((presence: any) => {
        if (presence.typing && presence.user_id !== this.currentUserId) {
          // Check if typing is recent (within timeout window)
          const typingAt = presence.typing_at ? new Date(presence.typing_at) : new Date()
          const now = new Date()
          const timeSinceTyping = now.getTime() - typingAt.getTime()

          if (timeSinceTyping < this.TYPING_TIMEOUT_MS) {
            typingSet.add({
              user_id: presence.user_id,
              display_name: presence.display_name,
              username: presence.username,
              typing_at: presence.typing_at || new Date().toISOString()
            })
          }
        }
      })
    })

    // Limit to 3 users max (Discord behavior)
    const typingArray = Array.from(typingSet).slice(0, 3)
    this.typingUsers.set(contextKey, new Set(typingArray))
    this.notifyCallbacks(context, typingArray)
  }

  /**
   * Handle presence join event
   */
  private handlePresenceJoin(context: TypingContext, newPresences: any[]): void {
    const contextKey = this.getContextKey(context)
    let typingSet = this.typingUsers.get(contextKey) || new Set<TypingUser>()

    newPresences.forEach((presence: any) => {
      if (presence.typing && presence.user_id !== this.currentUserId) {
        typingSet.add({
          user_id: presence.user_id,
          display_name: presence.display_name,
          username: presence.username,
          typing_at: presence.typing_at || new Date().toISOString()
        })
      }
    })

    // Limit to 3 users max (Discord behavior)
    const typingArray = Array.from(typingSet).slice(0, 3)
    this.typingUsers.set(contextKey, new Set(typingArray))
    this.notifyCallbacks(context, typingArray)
  }

  /**
   * Handle presence leave event
   */
  private handlePresenceLeave(context: TypingContext, leftPresences: any[]): void {
    const contextKey = this.getContextKey(context)
    const typingSet = this.typingUsers.get(contextKey)
    if (!typingSet) return

    leftPresences.forEach((presence: any) => {
      if (presence.user_id) {
        Array.from(typingSet).forEach(user => {
          if (user.user_id === presence.user_id) {
            typingSet.delete(user)
          }
        })
      }
    })

    this.typingUsers.set(contextKey, typingSet)
    this.notifyCallbacks(context, Array.from(typingSet))
  }

  /**
   * Notify all callbacks for a context
   */
  private notifyCallbacks(context: TypingContext, users: TypingUser[]): void {
    const contextKey = this.getContextKey(context)
    const callbacks = this.typingCallbacks.get(contextKey)
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(users)
        } catch (error) {
          debug.error('❌ TypingIndicatorService: Error in callback:', error)
        }
      })
    }
  }

  /**
   * Get channel name for a context
   */
  private getChannelName(context: TypingContext): string {
    switch (context.type) {
      case 'channel':
        return `typing:channel:${context.channelId}`
      case 'thread':
        return `typing:thread:${context.threadId}`
      case 'conversation':
        return `typing:conversation:${context.conversationId}`
    }
  }

  /**
   * Get context key for comparison
   */
  private getContextKey(context: TypingContext): string {
    return this.getChannelName(context)
  }

  /**
   * Check if two contexts are the same
   */
  private isSameContext(a: TypingContext | null, b: TypingContext | null): boolean {
    if (!a || !b) return false
    if (a.type !== b.type) return false
    
    switch (a.type) {
      case 'channel':
        return b.type === 'channel' && a.channelId === b.channelId
      case 'thread':
        return b.type === 'thread' && a.threadId === b.threadId
      case 'conversation':
        return b.type === 'conversation' && a.conversationId === b.conversationId
    }
  }

  /**
   * Cleanup on logout
   */
  async cleanup(): Promise<void> {
    await this.cleanupContext()
    this.typingUsers.clear()
    this.typingCallbacks.clear()
    this.currentUserId = null
    debug.log('🧹 TypingIndicatorService: Cleaned up')
  }
}

export const typingIndicatorService = new TypingIndicatorService()

