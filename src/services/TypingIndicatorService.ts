/**
 * TypingIndicatorService - Typing indicators via Supabase Realtime presence
 *
 * Supports channel, thread, and DM contexts. Multiple contexts can be active at
 * once (e.g. main channel + open thread) - each has its own Realtime channel.
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
  /** Supabase Realtime channel per context key (e.g. typing:channel:uuid) */
  private channelsByKey = new Map<string, RealtimeChannel>()
  /** In-flight subscribe for a key (avoids duplicate channels on concurrent ensureSubscribed) */
  private pendingSubscribe = new Map<string, Promise<boolean>>()
  private currentUserId: string | null = null
  private typingTimeout: number | null = null
  private isCurrentlyTyping = false
  /** Context on which we last broadcast typing (for stopTyping / track) */
  private typingBroadcastContext: TypingContext | null = null
  private readonly TYPING_TIMEOUT_MS = 3000

  private typingUsers = new Map<string, Set<TypingUser>>()
  private typingCallbacks = new Map<string, Set<(users: TypingUser[]) => void>>()
  /**
   * Per-context interval that re-evaluates `typingUsers` from `channel.presenceState()`
   * every {@link STALE_REEVAL_MS}. Supabase only emits presence `sync` when the
   * underlying state changes, so a typer whose `stopTyping()` never reached the
   * channel (network drop, race, closed tab without graceful cleanup) would stay
   * on screen forever. Periodic re-eval applies the age filter so stale typers
   * always clear within `TYPING_TIMEOUT_MS`.
   */
  private staleSweepers = new Map<string, number>()
  private readonly STALE_REEVAL_MS = 1000

  async initialize(): Promise<void> {
    if (this.currentUserId) return

    const authStore = useAuthStore()
    let user = authStore.session?.user

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

  subscribeToTyping(
    context: TypingContext,
    callback: (users: TypingUser[]) => void
  ): () => void {
    const contextKey = this.getContextKey(context)

    if (!this.typingCallbacks.has(contextKey)) {
      this.typingCallbacks.set(contextKey, new Set())
    }
    this.typingCallbacks.get(contextKey)!.add(callback)

    const wire = () => {
      this.ensureSubscribed(context).then(ok => {
        if (ok) this.handlePresenceSync(context)
      }).catch(err => {
        debug.error('❌ TypingIndicatorService: Failed to subscribe:', err)
      })
    }

    if (!this.currentUserId) {
      this.initialize().then(wire).catch(err => {
        debug.error('❌ TypingIndicatorService: Failed to initialize:', err)
      })
    } else {
      wire()
    }

    return () => {
      const callbacks = this.typingCallbacks.get(contextKey)
      if (callbacks) {
        callbacks.delete(callback)
        if (callbacks.size === 0) {
          this.typingCallbacks.delete(contextKey)
          void this.teardownContextKey(contextKey)
        }
      }
    }
  }

  async startTyping(context: TypingContext): Promise<void> {
    if (!this.currentUserId) {
      await this.initialize()
      if (!this.currentUserId) {
        debug.warn('⚠️ TypingIndicatorService: Cannot start typing, no user ID')
        return
      }
    }

    const ok = await this.ensureSubscribed(context)
    if (!ok) {
      debug.warn('⚠️ TypingIndicatorService: ensureSubscribed failed for startTyping')
      return
    }

    const contextKey = this.getContextKey(context)
    const channel = this.channelsByKey.get(contextKey)
    if (!channel) return

    if (this.isCurrentlyTyping && this.isSameContext(context, this.typingBroadcastContext)) {
      if (this.typingTimeout) clearTimeout(this.typingTimeout)
      this.typingTimeout = window.setTimeout(() => {
        void this.stopTyping()
      }, this.TYPING_TIMEOUT_MS)
      return
    }

    if (this.isCurrentlyTyping && !this.isSameContext(context, this.typingBroadcastContext)) {
      await this.stopTyping()
    }

    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout)
      this.typingTimeout = null
    }

    const userData = userDataService.getUser(this.currentUserId)
    const displayName = userData?.displayName || undefined
    const username = userData?.username || undefined

    await channel.track({
      user_id: this.currentUserId,
      typing: true,
      typing_at: new Date().toISOString(),
      display_name: displayName,
      username: username
    })
    this.isCurrentlyTyping = true
    this.typingBroadcastContext = context
    debug.log('✅ TypingIndicatorService: Typing status set to ON', contextKey)

    this.typingTimeout = window.setTimeout(() => {
      void this.stopTyping()
    }, this.TYPING_TIMEOUT_MS)
  }

  async stopTyping(): Promise<void> {
    if (!this.currentUserId || !this.isCurrentlyTyping || !this.typingBroadcastContext) return

    const contextKey = this.getContextKey(this.typingBroadcastContext)
    const channel = this.channelsByKey.get(contextKey)

    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout)
      this.typingTimeout = null
    }

    if (channel) {
      await channel.track({
        user_id: this.currentUserId,
        typing: false
      })
    }
    this.isCurrentlyTyping = false
    this.typingBroadcastContext = null
    debug.log('✅ TypingIndicatorService: Typing status set to OFF')
  }

  /**
   * Ensure a Realtime channel exists for this context (idempotent).
   */
  private async ensureSubscribed(context: TypingContext): Promise<boolean> {
    const contextKey = this.getContextKey(context)
    if (this.channelsByKey.has(contextKey)) {
      this.handlePresenceSync(context)
      return true
    }

    const inflight = this.pendingSubscribe.get(contextKey)
    if (inflight) {
      return inflight
    }

    const channelName = this.getChannelName(context)
    debug.log('🔄 TypingIndicatorService: Subscribing:', channelName)

    const MAX_RETRIES = 5
    const RETRY_DELAY_MS = 500
    const SUBSCRIBE_TIMEOUT_MS = 3000

    const work = (async (): Promise<boolean> => {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const subscribed = await this.subscribeToChannelForContext(context, channelName, SUBSCRIBE_TIMEOUT_MS)
          if (subscribed) {
            debug.log('✅ TypingIndicatorService: Subscribed to', channelName, 'attempt', attempt)
            return true
          }
        } catch {
          debug.warn(`⚠️ TypingIndicatorService: Subscription attempt ${attempt}/${MAX_RETRIES} failed`, channelName)
        }
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
        }
      }

      debug.error('❌ TypingIndicatorService: Failed to subscribe after', MAX_RETRIES, 'attempts', channelName)
      return false
    })()

    this.pendingSubscribe.set(contextKey, work)
    try {
      return await work
    } finally {
      this.pendingSubscribe.delete(contextKey)
    }
  }

  private async subscribeToChannelForContext(
    context: TypingContext,
    channelName: string,
    timeoutMs: number
  ): Promise<boolean> {
    const contextKey = this.getContextKey(context)

    return new Promise((resolve, reject) => {
      let resolved = false

      const ch = supabase
        .channel(channelName)
        .on('presence', { event: 'sync' }, () => {
          this.handlePresenceSync(context)
        })
        .on('presence', { event: 'join' }, ({ newPresences }) => {
          this.handlePresenceJoin(context, newPresences)
        })
        .on('presence', { event: 'leave' }, ({ leftPresences }) => {
          this.handlePresenceLeave(context, leftPresences)
        })

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          debug.warn('⏳ TypingIndicatorService: Subscription timed out for', channelName)
          supabase.removeChannel(ch).catch(() => {})
          resolve(false)
        }
      }, timeoutMs)

      ch.subscribe(status => {
        if (resolved) return

        if (status === 'SUBSCRIBED') {
          resolved = true
          clearTimeout(timeout)
          this.channelsByKey.set(contextKey, ch)
          this.handlePresenceSync(context)
          this.startStaleSweeper(context)
          resolve(true)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          resolved = true
          clearTimeout(timeout)
          debug.error('❌ TypingIndicatorService: Channel error for', channelName, status)
          supabase.removeChannel(ch).catch(() => {})
          reject(new Error(`Channel subscription failed: ${status}`))
        }
      })
    })
  }

  private async teardownContextKey(contextKey: string): Promise<void> {
    const ch = this.channelsByKey.get(contextKey)
    if (!ch) return

    if (
      this.isCurrentlyTyping &&
      this.typingBroadcastContext &&
      this.getContextKey(this.typingBroadcastContext) === contextKey
    ) {
      await this.stopTyping()
    }

    this.stopStaleSweeper(contextKey)
    this.channelsByKey.delete(contextKey)
    this.typingUsers.delete(contextKey)
    await supabase.removeChannel(ch)
  }

  /**
   * Start a per-context interval that re-runs `handlePresenceSync`. Idempotent.
   * The sync handler already applies the `typing_at` age filter, so stale
   * entries naturally fall off without needing a new presence event from
   * Supabase Realtime.
   */
  private startStaleSweeper(context: TypingContext): void {
    const contextKey = this.getContextKey(context)
    if (this.staleSweepers.has(contextKey)) return

    const handle = window.setInterval(() => {
      if (!this.channelsByKey.has(contextKey)) {
        this.stopStaleSweeper(contextKey)
        return
      }
      this.handlePresenceSync(context)
    }, this.STALE_REEVAL_MS)

    this.staleSweepers.set(contextKey, handle)
  }

  private stopStaleSweeper(contextKey: string): void {
    const handle = this.staleSweepers.get(contextKey)
    if (handle !== undefined) {
      clearInterval(handle)
      this.staleSweepers.delete(contextKey)
    }
  }

  private handlePresenceSync(context: TypingContext): void {
    const contextKey = this.getContextKey(context)
    const channel = this.channelsByKey.get(contextKey)
    if (!channel) return

    const presenceState = channel.presenceState()
    const typingSet = new Set<TypingUser>()

    Object.values(presenceState).forEach((presences: any[]) => {
      presences.forEach((presence: any) => {
        if (presence.typing && presence.user_id !== this.currentUserId) {
          const typingAt = presence.typing_at ? new Date(presence.typing_at) : new Date()
          const timeSinceTyping = Date.now() - typingAt.getTime()

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

    const typingArray = Array.from(typingSet).slice(0, 3)
    this.typingUsers.set(contextKey, new Set(typingArray))
    this.notifyCallbacks(context, typingArray)
  }

  private handlePresenceJoin(context: TypingContext, _newPresences: any[]): void {
    // Always rebuild from authoritative presence - incremental join updates
    // missed typing:false and left "is typing..." stuck on screen.
    this.handlePresenceSync(context)
  }

  private handlePresenceLeave(context: TypingContext, leftPresences: any[]): void {
    const contextKey = this.getContextKey(context)
    const typingSet = this.typingUsers.get(contextKey)
    if (!typingSet) return

    leftPresences.forEach((presence: any) => {
      if (presence.user_id) {
        Array.from(typingSet).forEach(user => {
          if (user.user_id === presence.user_id) {
            typingSet!.delete(user)
          }
        })
      }
    })

    this.typingUsers.set(contextKey, typingSet)
    this.notifyCallbacks(context, Array.from(typingSet))
  }

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

  private getContextKey(context: TypingContext): string {
    return this.getChannelName(context)
  }

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

  async cleanup(): Promise<void> {
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout)
      this.typingTimeout = null
    }

    await this.stopTyping()

    const keys = [...this.channelsByKey.keys()]
    for (const key of keys) {
      await this.teardownContextKey(key)
    }

    for (const handle of this.staleSweepers.values()) {
      clearInterval(handle)
    }
    this.staleSweepers.clear()

    this.typingUsers.clear()
    this.typingCallbacks.clear()
    this.currentUserId = null
    debug.log('🧹 TypingIndicatorService: Cleaned up')
  }
}

export const typingIndicatorService = new TypingIndicatorService()
