/**
 * RealtimeConnectionManager
 *
 * Wrapper over Supabase realtime subscriptions providing:
 * - reconnection with exponential backoff and jitter
 * - connection health monitoring
 * - one registry of subscriptions keyed by channel name
 * - status tracking and callbacks
 * - INSERT / UPDATE / DELETE handlers per channel
 * - reconnect on visibility change, network online, and sign-out teardown
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'

// Types

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export type DatabaseEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

export type PayloadHandler<T extends { [key: string]: any } = any> = (payload: RealtimePostgresChangesPayload<T>) => void | Promise<void>

export type StatusHandler = (status: ConnectionStatus, channelName: string) => void

/** Broadcast event handler (realtime.send payloads, not CDC) */
export interface BroadcastHandler {
  event: string
  handler: (payload: Record<string, any>) => void | Promise<void>
}

/** Single-event subscription config (legacy API). */
export interface SubscriptionConfig {
  channelName: string
  table: string
  schema?: string
  event?: DatabaseEvent
  filter?: string
  onPayload: PayloadHandler
  onStatusChange?: (status: ConnectionStatus) => void
}

/** Table subscription config with per-event INSERT / UPDATE / DELETE handlers. */
export interface TableSubscriptionConfig {
  /** Unique channel name for this subscription */
  channelName: string
  table: string
  /** Database schema (default: 'public') */
  schema?: string
  /** PostgREST filter (e.g., 'channel_id=eq.123') */
  filter?: string
  onInsert?: PayloadHandler
  onUpdate?: PayloadHandler
  onDelete?: PayloadHandler
  /**
   * Subscribe the channel as private (config: { private: true }). Required to
   * receive server-side realtime.send(..., private => true) broadcasts on the
   * same channel as the postgres_changes (CDC) stream.
   */
  private?: boolean
  /**
   * Broadcast event handlers delivered on the same channel via realtime.send().
   * Lets a feature piggyback broadcast events on the message channel a client
   * already has open instead of opening a second channel.
   */
  broadcasts?: BroadcastHandler[]
  onStatusChange?: StatusHandler
  /**
   * Fired when a subscription that was disconnected reaches SUBSCRIBED again.
   * Hook for fetching messages missed during the gap.
   */
  onReconnected?: () => void | Promise<void>
}

/** Several tables multiplexed onto one channel. */
export interface MultiTableSubscriptionConfig {
  /** Unique channel name for this subscription */
  channelName: string
  tables: Array<{
    table: string
    schema?: string
    filter?: string
    onInsert?: PayloadHandler
    onUpdate?: PayloadHandler
    onDelete?: PayloadHandler
  }>
  onStatusChange?: StatusHandler
  onReconnected?: () => void | Promise<void>
}

/**
 * Broadcast-only channel, no postgres_changes / CDC. For views that need
 * realtime.send() events but have no message stream of their own to piggyback
 * on, such as the full-thread route listening to the parent channel's reaction
 * broadcasts.
 */
export interface BroadcastSubscriptionConfig {
  /** Unique channel name / topic */
  channelName: string
  /** Subscribe as a private channel (default true; broadcasts use private topics) */
  private?: boolean
  broadcasts: BroadcastHandler[]
  onStatusChange?: StatusHandler
  onReconnected?: () => void | Promise<void>
}

/** Internal managed subscription state */
interface ManagedSubscription {
  config: SubscriptionConfig | TableSubscriptionConfig | MultiTableSubscriptionConfig | BroadcastSubscriptionConfig
  configType: 'single' | 'table' | 'multi' | 'broadcast'
  channel: RealtimeChannel | null
  status: ConnectionStatus
  retryCount: number
  retryTimeoutId: ReturnType<typeof setTimeout> | null
  lastConnectedAt: Date | null
  lastErrorAt: Date | null
  lastError: string | null
  rapidCloseCount: number
  lastClosedAt: Date | null
  /**
   * Set whenever a subscription becomes disconnected for any reason
   * (CHANNEL_ERROR / TIMED_OUT / CLOSED / `forceReconnect[All]` triggered by
   * `online` / `visibilitychange`). Cleared when the next SUBSCRIBED event
   * fires `onReconnected`. Required for gap-fill correctness (BUGS.md C13):
   * `forceReconnect()` zeroes `retryCount` before reconnecting, so a
   * `retryCount > 0` test misses every wake-from-sleep / network-restore gap.
   */
  pendingGapFill: boolean
}

// Configuration

const RETRY_CONFIG = {
  baseDelay: 1000,      // ms
  maxDelay: 30000,      // ms
  multiplier: 2,
  maxRetries: 10,
  jitterFactor: 0.2     // 20% random jitter, spreads reconnect storms
}

// Supabase drives its own reconnection; this sweep is a backstop.
const HEALTH_CHECK_INTERVAL = 60000  // ms
const STALE_CONNECTION_THRESHOLD = 5 * 60 * 1000  // ms

// RealtimeConnectionManager Service

/**
 * Hidden duration above which a returning-to-foreground tab is presumed to hold
 * a silently-dead WebSocket. Chrome on Android freezes background tabs after
 * ~30s, and carrier NATs / sleep states drop idle TCP without a FIN, so the
 * channel keeps reporting `SUBSCRIBED` after delivery has stopped.
 *
 * 60s rather than the 30s freeze floor, to avoid churn on brief alt-tabs.
 */
const HIDDEN_FOR_STALE_MS = 60 * 1000

class RealtimeConnectionManagerService {
  private subscriptions = new Map<string, ManagedSubscription>()
  private globalStatus: ConnectionStatus = 'disconnected'
  private statusListeners = new Set<(status: ConnectionStatus) => void>()
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null
  private authListener: { data: { subscription: { unsubscribe: () => void } } } | null = null
  private initialized = false
  private isReconnecting = false
  private onlineHandler: (() => void) | null = null
  private offlineHandler: (() => void) | null = null
  private visibilityHandler: (() => void) | null = null
  /**
   * Epoch ms of the last transition to `hidden`; cleared on `visible`. Selects
   * between a full reconnect (long absence, sockets presumed dead) and a cheap
   * status sweep (short alt-tab).
   */
  private hiddenAt: number | null = null

  // Lifecycle Methods

  /** Called once at app start, from BaseLayout. Repeat calls are no-ops. */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    
    debug.log('RealtimeManager: Initialized - Supabase handles all connection management')
    
    // SIGNED_OUT is the only auth event that matters here.
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        debug.log('RealtimeManager: User signed out, unsubscribing all')
        this.unsubscribeAll()
      }
    })
    this.authListener = { data: { subscription: authListener.subscription } }

    this.onlineHandler = () => {
      debug.log('RealtimeManager: Network online, reconnecting subscriptions')
      this.forceReconnectAll()
    }
    this.offlineHandler = () => {
      debug.log('RealtimeManager: Network offline')
      this.globalStatus = 'disconnected'
      this.notifyStatusListeners()
    }
    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        // Record the departure so the next 'visible' event can pick a
        // strategy. Subscriptions are left up; the tab may return instantly.
        this.hiddenAt = Date.now()
        return
      }

      if (document.visibilityState !== 'visible' || !navigator.onLine) {
        return
      }

      const hiddenFor = this.hiddenAt ? Date.now() - this.hiddenAt : 0
      this.hiddenAt = null

      // Long absences (mobile OS tab freeze, laptop sleep, carrier NAT
      // timeout) usually mean the WebSocket died without a CLOSE reaching the
      // socket-state observer: the channel still reports SUBSCRIBED and no
      // payloads arrive. Reconnecting every managed channel re-handshakes and
      // fires onReconnected gap-fill.
      //
      // Also reconnect when the Supabase WS itself reports disconnected,
      // whatever the hidden duration - Safari iOS freezes tabs under a second
      // in and kills the socket.
      const rtClient = (supabase as any).realtime
      const wsDead = rtClient && typeof rtClient.isConnected === 'function' && !rtClient.isConnected()

      if (hiddenFor >= HIDDEN_FOR_STALE_MS || wsDead) {
        debug.log(
          `👁️ RealtimeManager: Tab visible after ${Math.round(hiddenFor / 1000)}s (wsDead=${wsDead}) - forcing per-channel reconnect to flush stale sockets`,
        )
        // Per-channel reconnect, not the global path: forceReconnect() tears
        // down and rebuilds each channel through handleSubscriptionStatus,
        // setting `pendingGapFill` so the SUBSCRIBED handler fires
        // `onReconnected`, which the DM/channel stores use to pull missed
        // messages. The global path only bounces the underlying socket and may
        // not surface CLOSED to each managed sub, skipping gap-fill.
        this.forceReconnectAll()
        return
      }

      debug.log('RealtimeManager: Tab visible again, checking connections')
      this.performHealthCheck()
    }

    window.addEventListener('online', this.onlineHandler)
    window.addEventListener('offline', this.offlineHandler)
    document.addEventListener('visibilitychange', this.visibilityHandler)
  }

  /** Called on app unmount. */
  cleanup(): void {
    debug.log('RealtimeManager: Cleaning up')
    
    if (this.authListener) {
      this.authListener.data.subscription.unsubscribe()
      this.authListener = null
    }

    if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler)
    if (this.offlineHandler) window.removeEventListener('offline', this.offlineHandler)
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler)
    this.onlineHandler = null
    this.offlineHandler = null
    this.visibilityHandler = null
    
    this.unsubscribeAll()
    this.initialized = false
  }

  // Subscription Methods

  /**
   * Primary subscription entry point: one channel, INSERT/UPDATE/DELETE handlers.
   * 
   * @example
   * const unsubscribe = realtimeConnectionManager.subscribeToTable({
   *   channelName: 'channel-messages-123',
   *   table: 'messages',
   *   filter: 'channel_id=eq.123',
   *   onInsert: (payload) => handleNewMessage(payload.new),
   *   onUpdate: (payload) => handleEditedMessage(payload.new),
   *   onDelete: (payload) => handleDeletedMessage(payload.old),
   *   onStatusChange: (status, name) => console.log(`${name}: ${status}`)
   * })
   */
  subscribeToTable(config: TableSubscriptionConfig): () => void {
    if (!this.initialized) this.initialize()
    
    const { channelName } = config
    
    if (this.subscriptions.has(channelName)) {
      // BUGS.md H29: a name collision tears the channel down and rebuilds it.
      // Replacing `managedSub.config` in place does not work:
      // `connectTableSubscription` closes over a local `config` reference, so
      // the handlers stay bound to the old config, and the Supabase channel
      // still carries the old filter/table targets. Collisions are logged
      // loudly so they surface in dev/staging.
      debug.warn(
        `⚠️ RealtimeManager: duplicate subscription ${channelName} - tearing down and rebuilding with the new caller's handlers (BUGS.md H29). Callers should use unique channel names.`,
      )
      this.unsubscribe(channelName)
    }
    
    const managedSub: ManagedSubscription = {
      config,
      configType: 'table',
      channel: null,
      status: 'disconnected',
      retryCount: 0,
      retryTimeoutId: null,
      lastConnectedAt: null,
      lastErrorAt: null,
      lastError: null,
      rapidCloseCount: 0,
      lastClosedAt: null,
      pendingGapFill: false
    }
    
    this.subscriptions.set(channelName, managedSub)
    this.connectTableSubscription(channelName)
    this.startHealthCheck()
    
    return () => this.unsubscribe(channelName)
  }

  /**
   * Broadcast-only channel, no postgres_changes / CDC. For features needing
   * realtime.send() events with no message stream of their own to piggyback on.
   */
  subscribeBroadcast(config: BroadcastSubscriptionConfig): () => void {
    if (!this.initialized) this.initialize()

    const { channelName } = config

    if (this.subscriptions.has(channelName)) {
      // See BUGS.md H29 in subscribeToTable() for context.
      debug.warn(
        `⚠️ RealtimeManager: duplicate subscription ${channelName} - tearing down and rebuilding (BUGS.md H29).`,
      )
      this.unsubscribe(channelName)
    }

    const managedSub: ManagedSubscription = {
      config,
      configType: 'broadcast',
      channel: null,
      status: 'disconnected',
      retryCount: 0,
      retryTimeoutId: null,
      lastConnectedAt: null,
      lastErrorAt: null,
      lastError: null,
      rapidCloseCount: 0,
      lastClosedAt: null,
      pendingGapFill: false,
    }

    this.subscriptions.set(channelName, managedSub)
    this.connectBroadcastSubscription(channelName)
    this.startHealthCheck()

    return () => this.unsubscribe(channelName)
  }

  /**
   * Several related tables on one channel, one WebSocket topic instead of many.
   * 
   * @example
   * const unsubscribe = realtimeConnectionManager.subscribeToMultipleTables({
   *   channelName: 'dm-conversation-123',
   *   tables: [
   *     { table: 'messages', filter: 'conversation_id=eq.123', onInsert: handleMessage },
   *     { table: 'message_edits', filter: 'conversation_id=eq.123', onInsert: handleEdit }
   *   ]
   * })
   */
  subscribeToMultipleTables(config: MultiTableSubscriptionConfig): () => void {
    if (!this.initialized) this.initialize()
    
    const { channelName } = config
    
    if (this.subscriptions.has(channelName)) {
      // See BUGS.md H29 in subscribeToTable() for context.
      debug.warn(
        `⚠️ RealtimeManager: duplicate subscription ${channelName} - tearing down and rebuilding (BUGS.md H29).`,
      )
      this.unsubscribe(channelName)
    }
    
    const managedSub: ManagedSubscription = {
      config,
      configType: 'multi',
      channel: null,
      status: 'disconnected',
      retryCount: 0,
      retryTimeoutId: null,
      lastConnectedAt: null,
      lastErrorAt: null,
      lastError: null,
      rapidCloseCount: 0,
      lastClosedAt: null,
      pendingGapFill: false
    }
    
    this.subscriptions.set(channelName, managedSub)
    this.connectMultiTableSubscription(channelName)
    this.startHealthCheck()
    
    return () => this.unsubscribe(channelName)
  }

  /** Legacy single-event API, kept for existing callers. */
  subscribe(config: SubscriptionConfig): () => void {
    if (!this.initialized) this.initialize()
    
    const { channelName } = config
    
    if (this.subscriptions.has(channelName)) {
      // See BUGS.md H29 in subscribeToTable() for context.
      debug.warn(
        `⚠️ RealtimeManager: duplicate subscription ${channelName} - tearing down and rebuilding (BUGS.md H29).`,
      )
      this.unsubscribe(channelName)
    }
    
    const managedSub: ManagedSubscription = {
      config,
      configType: 'single',
      channel: null,
      status: 'disconnected',
      retryCount: 0,
      retryTimeoutId: null,
      lastConnectedAt: null,
      lastErrorAt: null,
      lastError: null,
      rapidCloseCount: 0,
      lastClosedAt: null,
      pendingGapFill: false
    }
    
    this.subscriptions.set(channelName, managedSub)
    this.connectSingleSubscription(channelName)
    this.startHealthCheck()
    
    return () => this.unsubscribe(channelName)
  }

  // Connection Methods

  private connectTableSubscription(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub || managedSub.configType !== 'table') return
    
    const config = managedSub.config as TableSubscriptionConfig
    this.updateSubscriptionStatus(channelName, 'connecting')
    
    debug.log(`RealtimeManager: Connecting ${channelName} (table subscription)...`)
    
    let channel = supabase.channel(
      channelName,
      config.private ? { config: { private: true } } : undefined,
    )
    const schema = config.schema || 'public'
    
    if (config.onInsert) {
      channel = channel.on(
        'postgres_changes' as const,
        { event: 'INSERT', schema, table: config.table, filter: config.filter } as any,
        async (payload: RealtimePostgresChangesPayload<any>) => {
          try {
            await config.onInsert!(payload)
          } catch (error) {
            debug.error(`RealtimeManager: Error in INSERT handler for ${channelName}:`, error)
          }
        }
      )
    }
    
    if (config.onUpdate) {
      channel = channel.on(
        'postgres_changes' as const,
        { event: 'UPDATE', schema, table: config.table, filter: config.filter } as any,
        async (payload: RealtimePostgresChangesPayload<any>) => {
          try {
            await config.onUpdate!(payload)
          } catch (error) {
            debug.error(`RealtimeManager: Error in UPDATE handler for ${channelName}:`, error)
          }
        }
      )
    }
    
    if (config.onDelete) {
      channel = channel.on(
        'postgres_changes' as const,
        { event: 'DELETE', schema, table: config.table, filter: config.filter } as any,
        async (payload: RealtimePostgresChangesPayload<any>) => {
          try {
            await config.onDelete!(payload)
          } catch (error) {
            debug.error(`RealtimeManager: Error in DELETE handler for ${channelName}:`, error)
          }
        }
      )
    }

    // Broadcast handlers (realtime.send events piggybacked on this channel)
    channel = this.attachBroadcastHandlers(channel, channelName, config.broadcasts)
    
    channel.subscribe((status, err) => {
      this.handleSubscriptionStatus(channelName, status, err)
    })
    
    managedSub.channel = channel
  }

  /** Attach broadcast event listeners to a channel. Returns the channel for chaining. */
  private attachBroadcastHandlers(
    channel: RealtimeChannel,
    channelName: string,
    broadcasts?: BroadcastHandler[],
  ): RealtimeChannel {
    if (!broadcasts?.length) return channel
    for (const { event, handler } of broadcasts) {
      channel = channel.on('broadcast', { event } as any, async (message: any) => {
        try {
          await handler(message?.payload ?? message)
        } catch (error) {
          debug.error(`RealtimeManager: Error in broadcast handler '${event}' for ${channelName}:`, error)
        }
      })
    }
    return channel
  }

  private connectBroadcastSubscription(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub || managedSub.configType !== 'broadcast') return

    const config = managedSub.config as BroadcastSubscriptionConfig
    this.updateSubscriptionStatus(channelName, 'connecting')

    debug.log(`RealtimeManager: Connecting ${channelName} (broadcast subscription)...`)

    const isPrivate = config.private !== false
    let channel = supabase.channel(
      channelName,
      isPrivate ? { config: { private: true } } : undefined,
    )
    channel = this.attachBroadcastHandlers(channel, channelName, config.broadcasts)

    channel.subscribe((status, err) => {
      this.handleSubscriptionStatus(channelName, status, err)
    })

    managedSub.channel = channel
  }

  private connectMultiTableSubscription(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub || managedSub.configType !== 'multi') return
    
    const config = managedSub.config as MultiTableSubscriptionConfig
    this.updateSubscriptionStatus(channelName, 'connecting')
    
    debug.log(`RealtimeManager: Connecting ${channelName} (multi-table subscription)...`)
    
    let channel = supabase.channel(channelName)
    
    for (const tableConfig of config.tables) {
      const schema = tableConfig.schema || 'public'
      
      if (tableConfig.onInsert) {
        channel = channel.on(
          'postgres_changes' as const,
          { event: 'INSERT', schema, table: tableConfig.table, filter: tableConfig.filter } as any,
          async (payload: RealtimePostgresChangesPayload<any>) => {
            try {
              await tableConfig.onInsert!(payload)
            } catch (error) {
              debug.error(`RealtimeManager: Error in INSERT handler for ${channelName}/${tableConfig.table}:`, error)
            }
          }
        )
      }
      
      if (tableConfig.onUpdate) {
        channel = channel.on(
          'postgres_changes' as const,
          { event: 'UPDATE', schema, table: tableConfig.table, filter: tableConfig.filter } as any,
          async (payload: RealtimePostgresChangesPayload<any>) => {
            try {
              await tableConfig.onUpdate!(payload)
            } catch (error) {
              debug.error(`RealtimeManager: Error in UPDATE handler for ${channelName}/${tableConfig.table}:`, error)
            }
          }
        )
      }
      
      if (tableConfig.onDelete) {
        channel = channel.on(
          'postgres_changes' as const,
          { event: 'DELETE', schema, table: tableConfig.table, filter: tableConfig.filter } as any,
          async (payload: RealtimePostgresChangesPayload<any>) => {
            try {
              await tableConfig.onDelete!(payload)
            } catch (error) {
              debug.error(`RealtimeManager: Error in DELETE handler for ${channelName}/${tableConfig.table}:`, error)
            }
          }
        )
      }
    }
    
    channel.subscribe((status, err) => {
      this.handleSubscriptionStatus(channelName, status, err)
    })
    
    managedSub.channel = channel
  }

  private connectSingleSubscription(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub || managedSub.configType !== 'single') return
    
    const config = managedSub.config as SubscriptionConfig
    this.updateSubscriptionStatus(channelName, 'connecting')
    
    debug.log(`RealtimeManager: Connecting ${channelName} (single subscription)...`)
    
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes' as const,
        {
          event: config.event || '*',
          schema: config.schema || 'public',
          table: config.table,
          filter: config.filter
        } as any,
        async (payload: RealtimePostgresChangesPayload<any>) => {
          try {
            await config.onPayload(payload)
          } catch (error) {
            debug.error(`RealtimeManager: Error in payload handler for ${channelName}:`, error)
          }
        }
      )
      .subscribe((status, err) => {
        this.handleSubscriptionStatus(channelName, status, err)
      })
    
    managedSub.channel = channel
  }

  private reconnect(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    if (managedSub.channel) {
      supabase.removeChannel(managedSub.channel)
      managedSub.channel = null
    }
    
    switch (managedSub.configType) {
      case 'table':
        this.connectTableSubscription(channelName)
        break
      case 'multi':
        this.connectMultiTableSubscription(channelName)
        break
      case 'single':
        this.connectSingleSubscription(channelName)
        break
      case 'broadcast':
        this.connectBroadcastSubscription(channelName)
        break
    }
  }

  // Status Management

  private handleSubscriptionStatus(channelName: string, status: string, err?: Error): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    debug.log(`RealtimeManager: ${channelName} status: ${status}`)
    
    switch (status) {
      case 'SUBSCRIBED': {
        // BUGS.md C13: gap-fill fires whenever this subscription was
        // disconnected and is back up, by any route (retry, forceReconnect,
        // forceReconnectAll). Keyed off pendingGapFill, not `retryCount > 0`:
        // forceReconnect*() zeroes retryCount before reconnecting.
        const shouldGapFill = managedSub.pendingGapFill
        managedSub.pendingGapFill = false
        managedSub.retryCount = 0
        managedSub.lastConnectedAt = new Date()
        managedSub.lastError = null
        this.updateSubscriptionStatus(channelName, 'connected')
        debug.log(`RealtimeManager: ${channelName} connected`)
        
        if (shouldGapFill) {
          const config = managedSub.config
          if ('onReconnected' in config && typeof config.onReconnected === 'function') {
            try {
              debug.log(`RealtimeManager: Firing onReconnected for ${channelName}`)
              Promise.resolve(config.onReconnected()).catch(err => {
                debug.error(`RealtimeManager: onReconnected error for ${channelName}:`, err)
              })
            } catch (err) {
              debug.error(`RealtimeManager: onReconnected sync error for ${channelName}:`, err)
            }
          }
        }
        break
      }
        
      case 'CHANNEL_ERROR':
        managedSub.lastErrorAt = new Date()
        managedSub.lastError = err?.message || 'Channel error'
        managedSub.pendingGapFill = true
        this.updateSubscriptionStatus(channelName, 'error')
        debug.error(`RealtimeManager: ${channelName} error:`, err)
        this.scheduleReconnect(channelName)
        break
        
      case 'TIMED_OUT':
        managedSub.lastErrorAt = new Date()
        managedSub.lastError = 'Connection timed out'
        managedSub.pendingGapFill = true
        this.updateSubscriptionStatus(channelName, 'error')
        debug.warn(`⏰ RealtimeManager: ${channelName} timed out`)
        this.scheduleReconnect(channelName)
        break
        
      case 'CLOSED':
        managedSub.pendingGapFill = true
        this.updateSubscriptionStatus(channelName, 'disconnected')
        debug.log(`RealtimeManager: ${channelName} closed`)
        
        if (this.subscriptions.has(channelName)) {
          const now = Date.now()
          
          // Detect rapid close cycle (connected then closed within 5 seconds)
          if (managedSub.lastConnectedAt) {
            const timeSinceConnect = now - managedSub.lastConnectedAt.getTime()
            if (timeSinceConnect < 5000) {
              managedSub.rapidCloseCount++
              debug.warn(`RealtimeManager: ${channelName} rapid close detected (${managedSub.rapidCloseCount} times)`)
              
              // 3+ rapid closes: stop the retry ladder, cool down instead.
              if (managedSub.rapidCloseCount >= 3) {
                debug.error(`RealtimeManager: ${channelName} server rejecting connection, backing off for 30s`)
                managedSub.lastErrorAt = new Date()
                managedSub.lastError = 'Server rejecting connection - rapid close cycle detected'
                this.updateSubscriptionStatus(channelName, 'error')
                
                if (managedSub.retryTimeoutId) clearTimeout(managedSub.retryTimeoutId)
                managedSub.retryTimeoutId = setTimeout(() => {
                  managedSub.rapidCloseCount = 0
                  this.reconnect(channelName)
                }, 30000)  // 30 second cooldown
                break
              }
            } else {
              // Close after a healthy session; clear the rapid-close counter.
              managedSub.rapidCloseCount = 0
            }
          }
          
          managedSub.lastClosedAt = new Date()
          this.scheduleReconnect(channelName)
        }
        break
    }
  }

  private updateSubscriptionStatus(channelName: string, status: ConnectionStatus): void {
    const managedSub = this.subscriptions.get(channelName)
    if (managedSub) {
      managedSub.status = status
      
      const config = managedSub.config
      if ('onStatusChange' in config && config.onStatusChange) {
        if (managedSub.configType === 'single') {
          (config as SubscriptionConfig).onStatusChange?.(status)
        } else {
          (config as TableSubscriptionConfig | MultiTableSubscriptionConfig).onStatusChange?.(status, channelName)
        }
      }
    }
    
    this.updateGlobalStatus()
  }

  private updateGlobalStatus(): void {
    let hasConnected = false
    let hasConnecting = false
    let hasReconnecting = false
    let hasError = false
    
    for (const sub of this.subscriptions.values()) {
      switch (sub.status) {
        case 'connected': hasConnected = true; break
        case 'connecting': hasConnecting = true; break
        case 'reconnecting': hasReconnecting = true; break
        case 'error': hasError = true; break
      }
    }
    
    let newStatus: ConnectionStatus
    if (hasError && !hasConnected) {
      newStatus = 'error'
    } else if (hasReconnecting) {
      newStatus = 'reconnecting'
    } else if (hasConnecting) {
      newStatus = 'connecting'
    } else if (hasConnected) {
      newStatus = 'connected'
    } else {
      newStatus = 'disconnected'
    }
    
    if (newStatus !== this.globalStatus) {
      this.globalStatus = newStatus
      this.notifyStatusListeners()
    }
  }

  private notifyStatusListeners(): void {
    for (const listener of this.statusListeners) {
      try {
        listener(this.globalStatus)
      } catch (error) {
        debug.error('RealtimeManager: Error in status listener:', error)
      }
    }
  }

  // Reconnection Logic

  private scheduleReconnect(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return

    if (!navigator.onLine) {
      debug.log(`RealtimeManager: Offline, deferring reconnect for ${channelName}`)
      this.updateSubscriptionStatus(channelName, 'disconnected')
      return
    }
    
    if (managedSub.retryTimeoutId) {
      clearTimeout(managedSub.retryTimeoutId)
    }
    
    if (managedSub.retryCount >= RETRY_CONFIG.maxRetries) {
      debug.error(`RealtimeManager: ${channelName} max retries exceeded (${RETRY_CONFIG.maxRetries})`)
      this.updateSubscriptionStatus(channelName, 'error')
      return
    }
    
    const baseDelay = Math.min(
      RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.multiplier, managedSub.retryCount),
      RETRY_CONFIG.maxDelay
    )
    const jitter = baseDelay * RETRY_CONFIG.jitterFactor * Math.random()
    const delay = Math.floor(baseDelay + jitter)
    
    managedSub.retryCount++
    this.updateSubscriptionStatus(channelName, 'reconnecting')
    
    debug.log(`RealtimeManager: Scheduling reconnect for ${channelName} in ${delay}ms (attempt ${managedSub.retryCount}/${RETRY_CONFIG.maxRetries})`)
    
    managedSub.retryTimeoutId = setTimeout(() => {
      this.reconnect(channelName)
    }, delay)
  }

  /** No-op when the subscription is already connecting or reconnecting. */
  forceReconnect(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    if (managedSub.status === 'connecting' || managedSub.status === 'reconnecting') {
      debug.log(`RealtimeManager: ${channelName} already ${managedSub.status}, skipping`)
      return
    }
    
    debug.log(`RealtimeManager: Force reconnecting ${channelName}`)

    // BUGS.md C13: a forced reconnect (online / visibility / health-check)
    // implies events were missed while disconnected. Flag gap-fill before
    // zeroing retryCount so the SUBSCRIBED handler fires `onReconnected`.
    managedSub.pendingGapFill = true
    managedSub.retryCount = 0
    
    if (managedSub.retryTimeoutId) {
      clearTimeout(managedSub.retryTimeoutId)
      managedSub.retryTimeoutId = null
    }
    
    this.reconnect(channelName)
  }

  /** Skips channels already connected or connecting. */
  forceReconnectAll(): void {
    if (this.isReconnecting) {
      debug.log('RealtimeManager: Already reconnecting, skipping duplicate request')
      return
    }
    
    this.isReconnecting = true
    debug.log(`RealtimeManager: Force reconnecting all managed subscriptions (${this.subscriptions.size})`)
    
    for (const channelName of this.subscriptions.keys()) {
      this.forceReconnect(channelName)
    }
    
    // Hold the guard long enough for every reconnect to start; scales with
    // subscription count.
    const resetDelay = Math.max(5000, this.subscriptions.size * 500)
    setTimeout(() => {
      this.isReconnecting = false
    }, resetDelay)
  }

  /**
   * Bounces the underlying Supabase socket, affecting every realtime channel in
   * the app, not only managed ones. Deduplicated against concurrent attempts.
   */
  async forceGlobalReconnect(): Promise<void> {
    if (this.isReconnecting) {
      debug.log('RealtimeManager: Already reconnecting globally, skipping')
      return
    }
    
    this.isReconnecting = true
    debug.log('RealtimeManager: Force reconnecting ALL Supabase realtime channels globally')
    
    try {
      const realtimeClient = (supabase as any).realtime
      
      if (realtimeClient) {
        debug.log('RealtimeManager: Disconnecting realtime client...')
        
        if (realtimeClient.disconnect) {
          await realtimeClient.disconnect()
        }
        
        await new Promise(resolve => setTimeout(resolve, 100))
        
        debug.log('RealtimeManager: Reconnecting realtime client...')
        if (realtimeClient.connect) {
          await realtimeClient.connect()
        }
        
        debug.log('RealtimeManager: Global reconnect complete')
      } else {
        debug.warn('RealtimeManager: Could not access realtime client, falling back to managed reconnect')
        this.forceReconnectAll()
      }
    } catch (error) {
      debug.error('RealtimeManager: Global reconnect failed:', error)
      // forceReconnectAll() is not called here; it recurses back into this path.
    } finally {
      setTimeout(() => {
        this.isReconnecting = false
      }, 2000)
    }
  }

  // Unsubscription

  unsubscribe(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    debug.log(`RealtimeManager: Unsubscribing ${channelName}`)
    
    if (managedSub.retryTimeoutId) {
      clearTimeout(managedSub.retryTimeoutId)
    }
    
    // Remove from map BEFORE calling removeChannel
    const channel = managedSub.channel
    this.subscriptions.delete(channelName)
    
    // Safe now: the CLOSED callback will not find the entry in the map.
    if (channel) {
      supabase.removeChannel(channel)
    }
    
    if (this.subscriptions.size === 0) {
      this.stopHealthCheck()
    }
  }

  unsubscribeAll(): void {
    debug.log(`RealtimeManager: Unsubscribing all (${this.subscriptions.size} subscriptions)`)
    
    for (const channelName of Array.from(this.subscriptions.keys())) {
      this.unsubscribe(channelName)
    }
  }

  // Health Check

  private startHealthCheck(): void {
    if (this.healthCheckInterval) return
    
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck()
    }, HEALTH_CHECK_INTERVAL)
    
    debug.log(`RealtimeManager: Health check started (${HEALTH_CHECK_INTERVAL / 1000}s interval)`)
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
  }

  private performHealthCheck(): void {
    const now = new Date()

    // Cheap global check first: if the underlying Supabase WS is disconnected,
    // every channel reporting "connected" is stale and delivers nothing.
    // Per-channel reconnect sets each pendingGapFill and fires onReconnected on
    // re-handshake. Covers managed subs that never observed a CLOSED status,
    // e.g. a socket killed without a FIN on mobile carrier NATs or OS sleep.
    const rtClient = (supabase as any).realtime
    const wsDead = rtClient && typeof rtClient.isConnected === 'function' && !rtClient.isConnected()
    if (wsDead && this.subscriptions.size > 0) {
      const anyClaimingConnected = Array.from(this.subscriptions.values()).some(s => s.status === 'connected')
      if (anyClaimingConnected) {
        debug.warn('RealtimeManager: WS is disconnected but channels claim connected - reconnecting all')
        this.forceReconnectAll()
        return
      }
    }

    for (const [channelName, sub] of this.subscriptions) {
      // Fix stuck error states
      if (sub.status === 'error' && sub.lastErrorAt) {
        const timeSinceError = now.getTime() - sub.lastErrorAt.getTime()
        if (timeSinceError > 3 * 60 * 1000 && sub.retryCount >= RETRY_CONFIG.maxRetries) {
          debug.log(`RealtimeManager: Resetting ${channelName} after prolonged error`)
          sub.retryCount = 0
          this.scheduleReconnect(channelName)
        }
      }
      
      // Fix subscriptions stuck in connecting/reconnecting for too long
      if ((sub.status === 'connecting' || sub.status === 'reconnecting') && sub.lastErrorAt) {
        const stuckDuration = now.getTime() - sub.lastErrorAt.getTime()
        if (stuckDuration > STALE_CONNECTION_THRESHOLD) {
          debug.warn(`RealtimeManager: ${channelName} stuck in ${sub.status} for ${Math.round(stuckDuration / 1000)}s, forcing reconnect`)
          sub.retryCount = 0
          this.reconnect(channelName)
        }
      }
    }
  }

  // Public Status API

  /**
   * Add a global status change listener
   * @returns Unsubscribe function
   */
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    // Emit current status synchronously.
    listener(this.globalStatus)
    return () => this.statusListeners.delete(listener)
  }

  getStatus(): ConnectionStatus {
    return this.globalStatus
  }

  getSubscriptionStatus(channelName: string): ConnectionStatus | null {
    return this.subscriptions.get(channelName)?.status ?? null
  }

  hasSubscription(channelName: string): boolean {
    return this.subscriptions.has(channelName)
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size
  }

  getAllStatuses(): Map<string, { status: ConnectionStatus; retryCount: number; lastError: string | null }> {
    const statuses = new Map()
    for (const [name, sub] of this.subscriptions) {
      statuses.set(name, {
        status: sub.status,
        retryCount: sub.retryCount,
        lastError: sub.lastError
      })
    }
    return statuses
  }

  getDebugInfo(): object {
    const subscriptions: any[] = []
    
    for (const [name, sub] of this.subscriptions) {
      subscriptions.push({
        name,
        type: sub.configType,
        status: sub.status,
        retryCount: sub.retryCount,
        lastConnectedAt: sub.lastConnectedAt?.toISOString(),
        lastErrorAt: sub.lastErrorAt?.toISOString(),
        lastError: sub.lastError,
        channelState: sub.channel ? (sub.channel as any).state : null
      })
    }
    
    return {
      initialized: this.initialized,
      globalStatus: this.globalStatus,
      subscriptionCount: this.subscriptions.size,
      healthCheckRunning: !!this.healthCheckInterval,
      subscriptions
    }
  }
}

// Export

/** Singleton instance - use this for all realtime subscriptions */
export const realtimeConnectionManager = new RealtimeConnectionManagerService()

export { RealtimeConnectionManagerService }
