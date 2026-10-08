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
  | 'notification:new' | 'notification:update' | 'notification:bulk_read' | 'notification:deleted'
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
  | 'device:approval_request' | 'device:approved' | 'device:denied' | 'device:approval_expired'
  | 'mute:insert' | 'mute:delete'
  | 'block:insert' | 'block:delete'
  | 'ai_emoji:generated' | 'ai_emoji:failed'
  // Answer of a remote server to a federated voice channel join (VoiceActivityHandler).
  | 'federated_voice:token' | 'federated_voice:rejected'
  // Federated DM call signalling (VoiceActivityHandler).
  | 'federated_call:incoming' | 'federated_call:accepted' | 'federated_call:rejected' | 'federated_call:ended'
  // A DM partner's presence change (presence_publish).
  | 'presence:update'
  | '_reconnected'
type EventHandler = (payload: Record<string, any>) => void | Promise<void>

const RECONNECT_BASE_DELAY = 2_000
const RECONNECT_MAX_DELAY = 30_000
/**
 * Hidden duration after which a returning tab rebuilds the channel. Matches
 * HIDDEN_FOR_STALE_MS in RealtimeConnectionManager: a frozen tab or a NAT drop
 * leaves the socket dead while the channel still reports SUBSCRIBED.
 */
const HIDDEN_FOR_STALE_MS = 60_000

class UserEventChannel {
  private channel: ReturnType<typeof supabase.channel> | null = null
  private profileId: string | null = null
  private handlers = new Map<string, Set<EventHandler>>()
  private connected = false
  private retryCount = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Set by any drop; the next SUBSCRIBED dispatches `_reconnected`. */
  private needsResync = false
  private lifecycleBound = false
  private hiddenAt: number | null = null

  /**
   * Open the broadcast channel for the given user. A call for the user whose
   * channel is already open or joining is a no-op; failures are retried
   * without limit, and `online` / a long-hidden tab turning visible rebuild it.
   */
  connect(profileId: string): void {
    if (this.profileId === profileId && this.channel) return

    // Switching users clears handlers; the same user keeps them.
    if (this.profileId && this.profileId !== profileId) {
      this.disconnect()
    } else {
      this.teardownChannel()
    }

    this.profileId = profileId
    this.bindLifecycle()
    this.open()
  }

  private open(): void {
    const profileId = this.profileId
    if (!profileId) return
    const topic = `user:${profileId}`

    const channel = supabase.channel(topic, { config: { private: true } })
    this.channel = channel
    channel
      .on('broadcast', { event: 'user_event' }, (payload) => {
        this.dispatch(payload.payload ?? payload)
      })
      .subscribe((status) => {
        // removeChannel() closes a replaced channel later, sometimes after its
        // successor joined; its callbacks must not touch the live state.
        if (this.channel !== channel) return
        if (status === 'SUBSCRIBED') {
          this.connected = true
          this.retryCount = 0
          if (this.retryTimer) {
            clearTimeout(this.retryTimer)
            this.retryTimer = null
          }
          debug.log('UserEventChannel connected:', topic)
          // realtime-js also rejoins an errored channel on its own timer; that
          // SUBSCRIBED arrives here with retryCount still 0.
          if (this.needsResync) {
            this.needsResync = false
            this.dispatch({ type: '_reconnected' })
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.connected = false
          this.needsResync = true
          debug.warn('UserEventChannel status:', status)
          this.scheduleReconnect()
        }
      })
  }

  /** Rebuilds the channel now, dropping any pending backoff. */
  private reconnectNow(): void {
    if (!this.profileId) return
    this.needsResync = true
    this.retryCount = 0
    this.teardownChannel()
    this.open()
  }

  private bindLifecycle(): void {
    if (this.lifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') return
    this.lifecycleBound = true
    window.addEventListener('online', () => {
      if (this.profileId) this.reconnectNow()
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt = Date.now()
        return
      }
      if (document.visibilityState !== 'visible') return
      const hiddenFor = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt
      this.hiddenAt = null
      if (!this.profileId) return
      if (!this.connected || hiddenFor >= HIDDEN_FOR_STALE_MS) this.reconnectNow()
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
    const channel = this.channel
    this.channel = null
    this.connected = false
    if (channel) supabase.removeChannel(channel)
  }

  /** Full teardown: remove the channel, clear all handlers, reset state. */
  disconnect(): void {
    this.teardownChannel()
    this.profileId = null
    this.retryCount = 0
    this.needsResync = false
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
    if (!this.profileId || this.retryTimer) return

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.retryCount),
      RECONNECT_MAX_DELAY
    )
    const jitter = delay * 0.2 * Math.random()

    debug.log(`UserEventChannel: reconnect in ${Math.round(delay + jitter)}ms (attempt ${this.retryCount + 1})`)

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryCount++
      if (!this.profileId) return
      this.teardownChannel()
      this.open()
    }, delay + jitter)
  }
}

export const userEventChannel = new UserEventChannel()
