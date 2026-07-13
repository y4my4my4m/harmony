/**
 * Wrapper for Supabase realtime subscriptions: exponential-backoff reconnect,
 * health monitoring, centralized subscription mgmt, status callbacks,
 * multi-event (INSERT/UPDATE/DELETE), visibility + auth-token-refresh handling.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'

// Types

/** Connection status for subscriptions */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** Supported database events */
export type DatabaseEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

/** Payload handler type */
export type PayloadHandler<T extends { [key: string]: any } = any> = (payload: RealtimePostgresChangesPayload<T>) => void | Promise<void>

/** Status change handler */
export type StatusHandler = (status: ConnectionStatus, channelName: string) => void

/** Broadcast event handler (realtime.send payloads, not CDC) */
export interface BroadcastHandler {
  event: string
  handler: (payload: Record<string, any>) => void | Promise<void>
}

/**
 * Configuration for a single-event subscription (legacy API)
 */
export interface SubscriptionConfig {
  channelName: string
  table: string
  schema?: string
  event?: DatabaseEvent
  filter?: string
  onPayload: PayloadHandler
  onStatusChange?: (status: ConnectionStatus) => void
}

/**
 * Configuration for multi-event table subscription
 * Professional API supporting INSERT, UPDATE, DELETE handlers
 */
export interface TableSubscriptionConfig {
  /** Unique channel name for this subscription */
  channelName: string
  /** Database table to subscribe to */
  table: string
  /** Database schema (default: 'public') */
  schema?: string
  /** PostgREST filter (e.g., 'channel_id=eq.123') */
  filter?: string
  /** Handler for INSERT events */
  onInsert?: PayloadHandler
  /** Handler for UPDATE events */
  onUpdate?: PayloadHandler
  /** Handler for DELETE events */
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
  /** Handler for status changes */
  onStatusChange?: StatusHandler
  /**
   * Called after a successful reconnect (status goes from non-connected to SUBSCRIBED
   * with retryCount > 0). Use this to fetch messages missed during the disconnect.
   */
  onReconnected?: () => void | Promise<void>
}

/**
 * Configuration for multi-table channel subscription
 * Allows subscribing to multiple tables on a single channel
 */
export interface MultiTableSubscriptionConfig {
  /** Unique channel name for this subscription */
  channelName: string
  /** Tables to subscribe to */
  tables: Array<{
    table: string
    schema?: string
    filter?: string
    onInsert?: PayloadHandler
    onUpdate?: PayloadHandler
    onDelete?: PayloadHandler
  }>
  /** Handler for status changes */
  onStatusChange?: StatusHandler
  /** Called after a successful reconnect */
  onReconnected?: () => void | Promise<void>
}

/**
 * Configuration for a broadcast-only channel (no postgres_changes / CDC).
 * Used when a view needs realtime.send() events but has no message stream of
 * its own to piggyback on (e.g. the full-thread route listening to the parent
 * channel's reaction broadcasts).
 */
export interface BroadcastSubscriptionConfig {
  /** Unique channel name / topic */
  channelName: string
  /** Subscribe as a private channel (default true; broadcasts use private topics) */
  private?: boolean
  /** Broadcast event handlers */
  broadcasts: BroadcastHandler[]
  /** Handler for status changes */
  onStatusChange?: StatusHandler
  /** Called after a successful reconnect */
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
  // Set on any disconnect (CHANNEL_ERROR/TIMED_OUT/CLOSED/forceReconnect); cleared
  // when the next SUBSCRIBED fires onReconnected. Required for gap-fill (BUGS.md C13):
  // forceReconnect() zeroes retryCount, so the old "retryCount > 0" check missed
  // every wake-from-sleep / network-restore gap.
  pendingGapFill: boolean
}

// Configuration

const RETRY_CONFIG = {
  baseDelay: 1000,      // 1 second initial delay
  maxDelay: 30000,      // 30 seconds max delay
  multiplier: 2,        // Double delay each retry
  maxRetries: 10,       // Max retry attempts before giving up
  jitterFactor: 0.2     // Add 20% random jitter to prevent thundering herd
}

// Health check is now minimal - Supabase handles its own reconnection
const HEALTH_CHECK_INTERVAL = 60000  // 60 seconds - just a safety net, not aggressive
const STALE_CONNECTION_THRESHOLD = 5 * 60 * 1000  // 5 minutes

// RealtimeConnectionManager Service

// Hidden longer than this => a returning tab is presumed to have a silently-dead
// WebSocket (mobile freezes bg tabs ~30s, NAT/sleep sever idle TCP with no FIN, so
// the channel still reports SUBSCRIBED). 60s not 30s to avoid churn on brief alt-tabs.
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
  // ms-epoch when tab last went hidden (cleared on visible). Long absence =>
  // full reconnect (presume dead socket); short alt-tab => cheap status sweep.
  private hiddenAt: number | null = null

  // Lifecycle Methods

  /**
   * Initialize the connection manager
   * Should be called once when the app starts (e.g., in BaseLayout)
   */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    
    debug.log('RealtimeManager: Initialized - Supabase handles all connection management')
    
    // Only handle SIGNED_OUT to cleanup subscriptions
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        debug.log('RealtimeManager: User signed out, unsubscribing all')
        this.unsubscribeAll()
      }
    })
    this.authListener = { data: { subscription: authListener.subscription } }

    // Reconnect when network comes back online
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
        // Remember when we went away so the next 'visible' event can decide
        // how aggressively to reconnect. We DON'T tear down subscriptions
        // here - the user may flip back instantly.
        this.hiddenAt = Date.now()
        return
      }

      if (document.visibilityState !== 'visible' || !navigator.onLine) {
        return
      }

      const hiddenFor = this.hiddenAt ? Date.now() - this.hiddenAt : 0
      this.hiddenAt = null

      // Long absences can kill the WebSocket with no CLOSE event: channel still
      // reports SUBSCRIBED but no payloads arrive. Force a global reconnect so
      // every channel re-handshakes and gap-fill runs. Also reconnect whenever
      // the Supabase WS reports disconnected regardless of hidden duration
      // (Safari iOS freezes tabs <1s in and silently kills the socket).
      const rtClient = (supabase as any).realtime
      const wsDead = rtClient && typeof rtClient.isConnected === 'function' && !rtClient.isConnected()

      if (hiddenFor >= HIDDEN_FOR_STALE_MS || wsDead) {
        debug.log(
          `👁️ RealtimeManager: Tab visible after ${Math.round(hiddenFor / 1000)}s (wsDead=${wsDead}) - forcing per-channel reconnect to flush stale sockets`,
        )
        // Per-channel reconnect (not global): tears down + rebuilds each channel,
        // setting pendingGapFill so SUBSCRIBED fires onReconnected (stores pull
        // missed messages). Global path only bounces the socket and may not
        // surface CLOSED per sub, so gap-fill could silently skip.
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

  /**
   * Cleanup the connection manager
   * Should be called when the app unmounts
   */
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

  /**
   * Subscribe to a table with multiple event handlers.
   * Use this for most subscriptions - supports INSERT, UPDATE, DELETE
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
      // BUGS.md H29 (v2): "replace config in-place" was broken - connectTable-
      // Subscription closed over a LOCAL config, so reassigning managedSub.config
      // didn't retarget handlers, and the channel kept the OLD filter/table. Fix:
      // tear down + rebuild so the new caller gets a fresh channel with its filters.
      // Name collisions are a smell - log loudly.
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
   * Subscribe to a broadcast-only channel (no postgres_changes / CDC).
   * For features that need realtime.send() events but have no message stream
   * of their own to piggyback on.
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
   * Subscribe to multiple tables on a single channel.
   * More efficient when you need to subscribe to related tables
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

  /**
   * Legacy API - Subscribe to a single event on a table
   * Maintained for backwards compatibility
   */
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
    
    // Reconnect based on type
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
        // BUGS.md C13: gap-fill must fire whenever this subscription was
        // disconnected and is now back up - regardless of how it got back
        // (retry, forceReconnect, forceReconnectAll). The previous
        // `retryCount > 0` check missed `forceReconnect*()` because those
        // zero `retryCount` BEFORE reconnecting, so wake-from-sleep and
        // `window.online` events silently dropped missed messages.
        const shouldGapFill = managedSub.pendingGapFill
        managedSub.pendingGapFill = false
        managedSub.retryCount = 0
        managedSub.lastConnectedAt = new Date()
        managedSub.lastError = null
        this.updateSubscriptionStatus(channelName, 'connected')
        debug.log(`RealtimeManager: ${channelName} connected`)
        
        // Fire onReconnected callback so consumers can gap-fill missed events
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
              
              // If we've had 3+ rapid closes, stop retrying and wait longer
              if (managedSub.rapidCloseCount >= 3) {
                debug.error(`RealtimeManager: ${channelName} server rejecting connection, backing off for 30s`)
                managedSub.lastErrorAt = new Date()
                managedSub.lastError = 'Server rejecting connection - rapid close cycle detected'
                this.updateSubscriptionStatus(channelName, 'error')
                
                // Schedule a long delay before trying again
                if (managedSub.retryTimeoutId) clearTimeout(managedSub.retryTimeoutId)
                managedSub.retryTimeoutId = setTimeout(() => {
                  managedSub.rapidCloseCount = 0  // Reset after long wait
                  this.reconnect(channelName)
                }, 30000)  // 30 second cooldown
                break
              }
            } else {
              // Normal close after being connected for a while - reset rapid close count
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

  /**
   * Force reconnect a specific subscription
   * Has built-in deduplication - won't reconnect if already connecting
   */
  forceReconnect(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    // Skip if already connecting or reconnecting
    if (managedSub.status === 'connecting' || managedSub.status === 'reconnecting') {
      debug.log(`⏭RealtimeManager: ${channelName} already ${managedSub.status}, skipping`)
      return
    }
    
    debug.log(`RealtimeManager: Force reconnecting ${channelName}`)

    // BUGS.md C13: a forced reconnect (online / visibility / health-check)
    // means we suspect we missed events while disconnected. Flag gap-fill
    // BEFORE we zero retryCount, so the SUBSCRIBED handler still knows to
    // fire `onReconnected`.
    managedSub.pendingGapFill = true
    managedSub.retryCount = 0
    
    if (managedSub.retryTimeoutId) {
      clearTimeout(managedSub.retryTimeoutId)
      managedSub.retryTimeoutId = null
    }
    
    this.reconnect(channelName)
  }

  /**
   * Force reconnect all managed subscriptions that need it
   * Skips channels that are already connected or connecting
   */
  forceReconnectAll(): void {
    if (this.isReconnecting) {
      debug.log('⏭RealtimeManager: Already reconnecting, skipping duplicate request')
      return
    }
    
    this.isReconnecting = true
    debug.log(`RealtimeManager: Force reconnecting all managed subscriptions (${this.subscriptions.size})`)
    
    for (const channelName of this.subscriptions.keys()) {
      this.forceReconnect(channelName)
    }
    
    // Reset flag after enough time for all reconnects to start.
    // Scale with subscription count to avoid premature reset.
    const resetDelay = Math.max(5000, this.subscriptions.size * 500)
    setTimeout(() => {
      this.isReconnecting = false
    }, resetDelay)
  }

  /**
   * Force reconnect ALL Supabase realtime channels globally
   * This is a heavy operation - use sparingly
   * Has built-in deduplication to prevent simultaneous attempts
   */
  async forceGlobalReconnect(): Promise<void> {
    if (this.isReconnecting) {
      debug.log('⏭RealtimeManager: Already reconnecting globally, skipping')
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
      // Don't call forceReconnectAll here - it would cause recursion
    } finally {
      // Reset flag after a delay
      setTimeout(() => {
        this.isReconnecting = false
      }, 2000)
    }
  }

  // Unsubscription

  /**
   * Unsubscribe from a specific channel
   */
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
    
    // Now safely remove the channel (CLOSED callback won't find it in map)
    if (channel) {
      supabase.removeChannel(channel)
    }
    
    if (this.subscriptions.size === 0) {
      this.stopHealthCheck()
    }
  }

  /**
   * Unsubscribe from all channels
   */
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

    // First, the cheap global check: if the underlying Supabase WS is
    // disconnected, every "connected" channel above us is lying about its
    // state and won't deliver anything. Force per-channel reconnect so
    // each subscription's pendingGapFill flag gets set and onReconnected
    // fires when we re-handshake. This catches the case where a managed
    // sub never observed a CLOSED status (e.g. the socket was killed
    // without a FIN, common on mobile carrier NATs / OS-level sleep).
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
    // Immediately notify of current status
    listener(this.globalStatus)
    return () => this.statusListeners.delete(listener)
  }

  /**
   * Get current global connection status
   */
  getStatus(): ConnectionStatus {
    return this.globalStatus
  }

  /**
   * Get status of a specific subscription
   */
  getSubscriptionStatus(channelName: string): ConnectionStatus | null {
    return this.subscriptions.get(channelName)?.status ?? null
  }

  /**
   * Check if a subscription exists
   */
  hasSubscription(channelName: string): boolean {
    return this.subscriptions.has(channelName)
  }

  /**
   * Get count of active subscriptions
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size
  }

  /**
   * Get all subscription statuses for debugging
   */
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

  /**
   * Get comprehensive debug info
   */
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

/** Export class for testing */
export { RealtimeConnectionManagerService }
