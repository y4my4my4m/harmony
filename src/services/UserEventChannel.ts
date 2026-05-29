/**
 * UserEventChannel
 *
 * Manages a single Supabase Realtime broadcast channel per authenticated user:
 *   topic: "user:{profileId}"
 *   event: "user_event"
 *
 * DB triggers call realtime.send() to push compact events into this channel,
 * replacing per-table postgres_changes subscriptions for notifications and
 * unread counts.  This dramatically reduces channel count per user.
 *
 * Consumers register typed handlers via on(type, handler).  Handlers can be
 * added/removed at any time - they are dispatched internally.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

type UserEventType =
  | 'notification:new' | 'notification:update' | 'notification:bulk_read'
  | 'unread:change'
  | 'conversation:new' | 'conversation:updated'
  | 'server:joined' | 'server:left' | 'server:updated'
  | 'preferences:updated'
  | 'post:new' | 'post:updated' | 'post:deleted' | 'post:interaction'
  // Home-timeline fan-out. `post:new` only fires on the AUTHOR's user
  // channel (see `broadcast_post_event`); this event additionally fires
  // on every home-timeline RECIPIENT's user channel so followers see the
  // post prepended in real time. Triggered by `broadcast_home_feed_entry`
  // on `timeline_entries` INSERT (timeline_type = 'home').
  | 'home_feed:new_post'
  | 'post:embeds_ready'
  | 'follow:change'
  | 'encryption:key_request' | 'encryption:key_fulfilled'
  | 'device:approval_request' | 'device:approved' | 'device:denied'
  | 'mute:insert' | 'mute:delete'
  | 'block:insert' | 'block:delete'
  | '_reconnected'
type EventHandler = (payload: Record<string, any>) => void | Promise<void>

const RECONNECT_BASE_DELAY = 2_000
const RECONNECT_MAX_DELAY = 30_000
const RECONNECT_MAX_RETRIES = 12

class UserEventChannel {
  private channel: ReturnType<typeof supabase.channel> | null = null
  private profileId: string | null = null
  private handlers = new Map<string, Set<EventHandler>>()
  private connected = false
  private retryCount = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Open (or reuse) the broadcast channel for the given user.
   * Safe to call multiple times - reconnects only if the profileId changed.
   */
  connect(profileId: string): void {
    if (this.connected && this.profileId === profileId) return

    // If switching users, full teardown (clears handlers).
    // If same user (reconnect), only tear down the channel.
    if (this.profileId && this.profileId !== profileId) {
      this.disconnect()
    } else {
      this.teardownChannel()
    }

    this.profileId = profileId
    const topic = `user:${profileId}`

    this.channel = supabase.channel(topic, { config: { private: true } })
      .on('broadcast', { event: 'user_event' }, (payload) => {
        this.dispatch(payload.payload ?? payload)
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          const wasReconnect = this.retryCount > 0
          this.connected = true
          this.retryCount = 0
          debug.log('✅ UserEventChannel connected:', topic)
          if (wasReconnect) {
            this.dispatch({ type: '_reconnected' })
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.connected = false
          debug.warn('⚠️ UserEventChannel status:', status)
          this.scheduleReconnect()
        }
      })
  }

  /**
   * Register a handler for a specific event type.
   * Returns an unsubscribe function.
   */
  on(type: UserEventType, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)
    return () => { this.handlers.get(type)?.delete(handler) }
  }

  /**
   * Remove the channel and cancel pending reconnects, but keep handlers intact.
   * Used internally during reconnect so registered handlers survive.
   */
  private teardownChannel(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.channel) {
      supabase.removeChannel(this.channel)
      this.channel = null
    }
    this.connected = false
  }

  /** Full teardown: remove the channel, clear all handlers, reset state. */
  disconnect(): void {
    this.teardownChannel()
    this.profileId = null
    this.retryCount = 0
    this.handlers.clear()
  }

  /**
   * Send a broadcast event to the user's channel (e.g. cross-tab sync).
   * Silently no-ops if the channel isn't connected.
   */
  send(type: UserEventType, data: Record<string, any> = {}): void {
    if (!this.channel || !this.connected) return

    this.channel.send({
      type: 'broadcast',
      event: 'user_event',
      payload: { type, ...data },
    }).catch((err: any) => {
      debug.warn('UserEventChannel send failed:', err)
    })
  }

  /** Whether the broadcast channel is currently connected. */
  get isConnected(): boolean {
    return this.connected
  }

  // ---- internal ----

  private dispatch(data: Record<string, any>): void {
    const type = data?.type as string | undefined
    if (!type) return

    const set = this.handlers.get(type)
    if (!set || set.size === 0) return

    for (const handler of set) {
      try {
        const result = handler(data)
        if (result instanceof Promise) {
          result.catch((err) => debug.error('UserEventChannel handler error:', err))
        }
      } catch (err) {
        debug.error('UserEventChannel handler error:', err)
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= RECONNECT_MAX_RETRIES || !this.profileId) return

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.retryCount),
      RECONNECT_MAX_DELAY
    )
    const jitter = delay * 0.2 * Math.random()

    debug.log(`🔄 UserEventChannel: reconnect in ${Math.round(delay + jitter)}ms (attempt ${this.retryCount + 1}/${RECONNECT_MAX_RETRIES})`)

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryCount++
      const pid = this.profileId
      if (!pid) return
      this.teardownChannel()
      this.connect(pid)
    }, delay + jitter)
  }
}

export const userEventChannel = new UserEventChannel()
