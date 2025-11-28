/**
 * RealtimeConnectionManager
 * 
 * Professional-grade wrapper for Supabase realtime subscriptions with:
 * - Automatic reconnection with exponential backoff
 * - Connection health monitoring
 * - Centralized subscription management
 * - Status tracking and callbacks
 * 
 * Replaces fragile direct Supabase channel usage across the app.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'

// Connection status types
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

// Subscription configuration
export interface SubscriptionConfig {
  channelName: string
  table: string
  schema?: string
  event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*'
  filter?: string
  onPayload: (payload: RealtimePostgresChangesPayload<any>) => void | Promise<void>
  onStatusChange?: (status: ConnectionStatus) => void
}

// Managed subscription state
interface ManagedSubscription {
  config: SubscriptionConfig
  channel: RealtimeChannel | null
  status: ConnectionStatus
  retryCount: number
  retryTimeoutId: ReturnType<typeof setTimeout> | null
  lastConnectedAt: Date | null
  lastErrorAt: Date | null
  lastError: string | null
}

// Retry configuration
const RETRY_CONFIG = {
  baseDelay: 1000,      // 1 second initial delay
  maxDelay: 30000,      // 30 seconds max delay
  multiplier: 2,        // Double delay each retry
  maxRetries: 10,       // Max retry attempts before giving up
  jitterFactor: 0.2     // Add 20% random jitter to prevent thundering herd
}

class RealtimeConnectionManagerService {
  private subscriptions = new Map<string, ManagedSubscription>()
  private globalStatus: ConnectionStatus = 'disconnected'
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set()
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null
  private visibilityHandler: (() => void) | null = null
  private authListener: { data: { subscription: { unsubscribe: () => void } } } | null = null
  private lastVisibleTime: Date = new Date()
  private initialized: boolean = false
  
  /**
   * Initialize the connection manager with visibility and auth listeners
   * Should be called once when the app starts
   */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    
    debug.log('🚀 RealtimeManager: Initializing with visibility and auth listeners')
    
    // Handle page visibility changes - reconnect when tab becomes visible
    this.visibilityHandler = () => {
      if (!document.hidden) {
        const now = new Date()
        const timeSinceVisible = now.getTime() - this.lastVisibleTime.getTime()
        
        // If tab was hidden for more than 30 seconds, force reconnect all
        if (timeSinceVisible > 30 * 1000) {
          debug.log(`🔄 RealtimeManager: Tab visible after ${Math.round(timeSinceVisible / 1000)}s, reconnecting ALL channels`)
          this.forceGlobalReconnect()
        }
        
        this.lastVisibleTime = now
      } else {
        this.lastVisibleTime = new Date()
      }
    }
    document.addEventListener('visibilitychange', this.visibilityHandler)
    
    // Handle auth token refresh - reconnect when token changes
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED') {
        debug.log('🔑 RealtimeManager: Auth token refreshed, reconnecting ALL channels')
        // Small delay to ensure new token is ready
        setTimeout(() => {
          this.forceGlobalReconnect()
        }, 100)
      } else if (event === 'SIGNED_OUT') {
        debug.log('🚪 RealtimeManager: User signed out, unsubscribing all')
        this.unsubscribeAll()
      }
    })
    this.authListener = { data: { subscription: authListener.subscription } }
  }
  
  /**
   * Cleanup the connection manager
   */
  cleanup(): void {
    debug.log('🧹 RealtimeManager: Cleaning up')
    
    // Remove visibility handler
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    
    // Remove auth listener
    if (this.authListener) {
      this.authListener.data.subscription.unsubscribe()
      this.authListener = null
    }
    
    // Unsubscribe all
    this.unsubscribeAll()
    
    this.initialized = false
  }
  
  /**
   * Subscribe to a Postgres table with automatic reconnection
   */
  subscribe(config: SubscriptionConfig): () => void {
    // Auto-initialize if not done yet
    if (!this.initialized) {
      this.initialize()
    }
    const { channelName } = config
    
    // Check for existing subscription
    if (this.subscriptions.has(channelName)) {
      debug.warn(`⚠️ RealtimeManager: Subscription ${channelName} already exists, reusing`)
      return () => this.unsubscribe(channelName)
    }
    
    // Create managed subscription
    const managedSub: ManagedSubscription = {
      config,
      channel: null,
      status: 'disconnected',
      retryCount: 0,
      retryTimeoutId: null,
      lastConnectedAt: null,
      lastErrorAt: null,
      lastError: null
    }
    
    this.subscriptions.set(channelName, managedSub)
    
    // Start connection
    this.connect(channelName)
    
    // Start health check if not running
    this.startHealthCheck()
    
    // Return unsubscribe function
    return () => this.unsubscribe(channelName)
  }
  
  /**
   * Connect a subscription
   */
  private connect(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    const { config } = managedSub
    
    // Update status
    this.updateSubscriptionStatus(channelName, 'connecting')
    
    debug.log(`🔄 RealtimeManager: Connecting ${channelName}...`)
    
    // Create the channel
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
            debug.error(`❌ RealtimeManager: Error in payload handler for ${channelName}:`, error)
          }
        }
      )
      .subscribe((status, err) => {
        this.handleSubscriptionStatus(channelName, status, err)
      })
    
    managedSub.channel = channel
  }
  
  /**
   * Handle subscription status changes
   */
  private handleSubscriptionStatus(
    channelName: string,
    status: string,
    err?: Error
  ): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    debug.log(`📡 RealtimeManager: ${channelName} status: ${status}`)
    
    switch (status) {
      case 'SUBSCRIBED':
        managedSub.retryCount = 0
        managedSub.lastConnectedAt = new Date()
        managedSub.lastError = null
        this.updateSubscriptionStatus(channelName, 'connected')
        debug.log(`✅ RealtimeManager: ${channelName} connected`)
        break
        
      case 'CHANNEL_ERROR':
        managedSub.lastErrorAt = new Date()
        managedSub.lastError = err?.message || 'Channel error'
        this.updateSubscriptionStatus(channelName, 'error')
        debug.error(`❌ RealtimeManager: ${channelName} error:`, err)
        this.scheduleReconnect(channelName)
        break
        
      case 'TIMED_OUT':
        managedSub.lastErrorAt = new Date()
        managedSub.lastError = 'Connection timed out'
        this.updateSubscriptionStatus(channelName, 'error')
        debug.warn(`⏰ RealtimeManager: ${channelName} timed out`)
        this.scheduleReconnect(channelName)
        break
        
      case 'CLOSED':
        this.updateSubscriptionStatus(channelName, 'disconnected')
        debug.log(`🔒 RealtimeManager: ${channelName} closed`)
        // Only reconnect if we didn't intentionally close it
        if (this.subscriptions.has(channelName)) {
          this.scheduleReconnect(channelName)
        }
        break
    }
  }
  
  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    // Clear any existing retry timeout
    if (managedSub.retryTimeoutId) {
      clearTimeout(managedSub.retryTimeoutId)
    }
    
    // Check if max retries exceeded
    if (managedSub.retryCount >= RETRY_CONFIG.maxRetries) {
      debug.error(`❌ RealtimeManager: ${channelName} max retries exceeded (${RETRY_CONFIG.maxRetries})`)
      this.updateSubscriptionStatus(channelName, 'error')
      return
    }
    
    // Calculate delay with exponential backoff and jitter
    const baseDelay = Math.min(
      RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.multiplier, managedSub.retryCount),
      RETRY_CONFIG.maxDelay
    )
    const jitter = baseDelay * RETRY_CONFIG.jitterFactor * Math.random()
    const delay = Math.floor(baseDelay + jitter)
    
    managedSub.retryCount++
    this.updateSubscriptionStatus(channelName, 'reconnecting')
    
    debug.log(`🔄 RealtimeManager: Scheduling reconnect for ${channelName} in ${delay}ms (attempt ${managedSub.retryCount}/${RETRY_CONFIG.maxRetries})`)
    
    managedSub.retryTimeoutId = setTimeout(() => {
      // Clean up old channel
      if (managedSub.channel) {
        supabase.removeChannel(managedSub.channel)
        managedSub.channel = null
      }
      
      // Reconnect
      this.connect(channelName)
    }, delay)
  }
  
  /**
   * Unsubscribe from a channel
   */
  unsubscribe(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    debug.log(`🗑️ RealtimeManager: Unsubscribing ${channelName}`)
    
    // Clear retry timeout
    if (managedSub.retryTimeoutId) {
      clearTimeout(managedSub.retryTimeoutId)
    }
    
    // Remove channel
    if (managedSub.channel) {
      supabase.removeChannel(managedSub.channel)
    }
    
    // Remove from map
    this.subscriptions.delete(channelName)
    
    // Stop health check if no more subscriptions
    if (this.subscriptions.size === 0) {
      this.stopHealthCheck()
    }
  }
  
  /**
   * Unsubscribe from all channels
   */
  unsubscribeAll(): void {
    debug.log(`🧹 RealtimeManager: Unsubscribing all (${this.subscriptions.size} subscriptions)`)
    
    for (const channelName of this.subscriptions.keys()) {
      this.unsubscribe(channelName)
    }
  }
  
  /**
   * Update subscription status and notify listeners
   */
  private updateSubscriptionStatus(channelName: string, status: ConnectionStatus): void {
    const managedSub = this.subscriptions.get(channelName)
    if (managedSub) {
      managedSub.status = status
      managedSub.config.onStatusChange?.(status)
    }
    
    // Update global status
    this.updateGlobalStatus()
  }
  
  /**
   * Update global connection status based on all subscriptions
   */
  private updateGlobalStatus(): void {
    let hasConnected = false
    let hasConnecting = false
    let hasReconnecting = false
    let hasError = false
    
    for (const sub of this.subscriptions.values()) {
      switch (sub.status) {
        case 'connected':
          hasConnected = true
          break
        case 'connecting':
          hasConnecting = true
          break
        case 'reconnecting':
          hasReconnecting = true
          break
        case 'error':
          hasError = true
          break
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
  
  /**
   * Notify global status listeners
   */
  private notifyStatusListeners(): void {
    for (const listener of this.statusListeners) {
      try {
        listener(this.globalStatus)
      } catch (error) {
        debug.error('❌ RealtimeManager: Error in status listener:', error)
      }
    }
  }
  
  /**
   * Add global status listener
   */
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }
  
  /**
   * Get current global status
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
   * Get all subscription statuses
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
   * Force reconnect a specific subscription
   */
  forceReconnect(channelName: string): void {
    const managedSub = this.subscriptions.get(channelName)
    if (!managedSub) return
    
    debug.log(`🔄 RealtimeManager: Force reconnecting ${channelName}`)
    
    // Reset retry count for manual reconnect
    managedSub.retryCount = 0
    
    // Clean up old channel
    if (managedSub.channel) {
      supabase.removeChannel(managedSub.channel)
      managedSub.channel = null
    }
    
    // Clear any pending retry
    if (managedSub.retryTimeoutId) {
      clearTimeout(managedSub.retryTimeoutId)
      managedSub.retryTimeoutId = null
    }
    
    // Reconnect
    this.connect(channelName)
  }
  
  /**
   * Force reconnect all subscriptions (managed by this service)
   */
  forceReconnectAll(): void {
    debug.log(`🔄 RealtimeManager: Force reconnecting all managed subscriptions`)
    for (const channelName of this.subscriptions.keys()) {
      this.forceReconnect(channelName)
    }
  }
  
  /**
   * Force reconnect ALL Supabase realtime channels globally
   * This includes both managed channels and raw supabase.channel() calls
   * Used when visibility changes or auth token refreshes
   */
  async forceGlobalReconnect(): Promise<void> {
    debug.log('🔄 RealtimeManager: Force reconnecting ALL Supabase realtime channels globally')
    
    try {
      // Get the realtime client from Supabase
      const realtimeClient = (supabase as any).realtime
      
      if (realtimeClient) {
        // Disconnect and reconnect the entire realtime client
        // This will force all channels (managed and raw) to reconnect with fresh auth
        debug.log('🔌 RealtimeManager: Disconnecting realtime client...')
        
        // Set reconnect flag so channels auto-reconnect
        if (realtimeClient.disconnect) {
          await realtimeClient.disconnect()
        }
        
        // Small delay to ensure clean disconnect
        await new Promise(resolve => setTimeout(resolve, 100))
        
        // Reconnect
        debug.log('🔌 RealtimeManager: Reconnecting realtime client...')
        if (realtimeClient.connect) {
          await realtimeClient.connect()
        }
        
        debug.log('✅ RealtimeManager: Global reconnect complete')
      } else {
        // Fallback: just reconnect managed subscriptions
        debug.warn('⚠️ RealtimeManager: Could not access realtime client, falling back to managed reconnect')
        this.forceReconnectAll()
      }
    } catch (error) {
      debug.error('❌ RealtimeManager: Global reconnect failed:', error)
      // Fallback to managed reconnect
      this.forceReconnectAll()
    }
  }
  
  /**
   * Start health check interval
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) return
    
    // Check connection health every 15 seconds (more aggressive)
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck()
    }, 15000)
    
    debug.log(`💓 RealtimeManager: Health check started (15s interval)`)
  }
  
  /**
   * Stop health check interval
   */
  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
      debug.log(`💔 RealtimeManager: Health check stopped`)
    }
  }
  
  /**
   * Perform health check on all subscriptions
   */
  private performHealthCheck(): void {
    const now = new Date()
    
    for (const [channelName, sub] of this.subscriptions) {
      // Check for stale connections (connected but no activity for 2 minutes)
      if (sub.status === 'connected' && sub.lastConnectedAt) {
        const timeSinceConnect = now.getTime() - sub.lastConnectedAt.getTime()
        
        // If connected for more than 2 minutes, verify the connection is alive
        if (timeSinceConnect > 2 * 60 * 1000) {
          // Check channel state
          if (sub.channel) {
            const state = (sub.channel as any).state
            const socket = (sub.channel as any).socket
            
            // Check multiple indicators of connection health
            const isSocketConnected = socket?.isConnected?.() ?? false
            const isJoined = state === 'joined'
            
            if (!isJoined || !isSocketConnected) {
              debug.warn(`⚠️ RealtimeManager: ${channelName} appears stale (state: ${state}, socket: ${isSocketConnected}), reconnecting`)
              this.forceReconnect(channelName)
            }
          } else {
            // No channel object - definitely need to reconnect
            debug.warn(`⚠️ RealtimeManager: ${channelName} has no channel, reconnecting`)
            this.forceReconnect(channelName)
          }
        }
      }
      
      // Check for subscriptions stuck in error state for too long
      if (sub.status === 'error' && sub.lastErrorAt) {
        const timeSinceError = now.getTime() - sub.lastErrorAt.getTime()
        
        // If in error state for more than 1 minute with max retries, try again
        if (timeSinceError > 60 * 1000 && sub.retryCount >= RETRY_CONFIG.maxRetries) {
          debug.log(`🔄 RealtimeManager: Resetting ${channelName} after extended error state`)
          sub.retryCount = 0
          this.scheduleReconnect(channelName)
        }
      }
      
      // Check for subscriptions stuck in connecting state
      if (sub.status === 'connecting' || sub.status === 'reconnecting') {
        // If stuck in connecting state for more than 30 seconds, force reconnect
        const stuckTimeout = 30 * 1000
        if (sub.lastConnectedAt) {
          const timeSinceLastConnect = now.getTime() - sub.lastConnectedAt.getTime()
          if (timeSinceLastConnect > stuckTimeout) {
            debug.warn(`⚠️ RealtimeManager: ${channelName} stuck in ${sub.status} state, forcing reconnect`)
            this.forceReconnect(channelName)
          }
        }
      }
    }
  }
  
  /**
   * Get debug info for troubleshooting
   */
  getDebugInfo(): object {
    const subscriptions: any[] = []
    
    for (const [name, sub] of this.subscriptions) {
      subscriptions.push({
        name,
        status: sub.status,
        retryCount: sub.retryCount,
        lastConnectedAt: sub.lastConnectedAt?.toISOString(),
        lastErrorAt: sub.lastErrorAt?.toISOString(),
        lastError: sub.lastError,
        channelState: sub.channel ? (sub.channel as any).state : null
      })
    }
    
    return {
      globalStatus: this.globalStatus,
      subscriptionCount: this.subscriptions.size,
      healthCheckRunning: !!this.healthCheckInterval,
      subscriptions
    }
  }
}

// Export singleton instance
export const realtimeConnectionManager = new RealtimeConnectionManagerService()

// Export class for testing
export { RealtimeConnectionManagerService }

