/**
 * Request Deduplicator
 * 
 * Prevents duplicate concurrent requests for the same data.
 * When multiple components request the same data simultaneously,
 * only one network request is made and all callers get the same result.
 * 
 * Usage:
 * ```ts
 * const result = await requestDeduplicator.dedupe(
 *   'user-profile-123',
 *   () => supabase.from('profiles').select('*').eq('id', '123').single()
 * )
 * ```
 */

import { debug } from '@/utils/debug'

type PendingRequest<T> = {
  promise: Promise<T>
  timestamp: number
}

class RequestDeduplicator {
  private pendingRequests = new Map<string, PendingRequest<any>>()
  private cache = new Map<string, { data: any; timestamp: number }>()
  
  // Default cache TTL: 5 seconds (for very short-lived caching)
  private defaultCacheTTL = 5000
  
  /**
   * Execute a request with deduplication
   * If the same key is already being fetched, returns the existing promise
   * 
   * @param key Unique key for this request (e.g., 'profile-{userId}')
   * @param fetcher Function that performs the actual request
   * @param options Configuration options
   */
  async dedupe<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: {
      /** Cache TTL in ms (0 = no caching beyond deduplication) */
      cacheTTL?: number
      /** Force fresh fetch, ignoring cache */
      forceRefresh?: boolean
    } = {}
  ): Promise<T> {
    const { cacheTTL = 0, forceRefresh = false } = options
    
    // Check cache first (if caching is enabled and not forcing refresh)
    if (!forceRefresh && cacheTTL > 0) {
      const cached = this.cache.get(key)
      if (cached && Date.now() - cached.timestamp < cacheTTL) {
        debug.log(`Cache hit for: ${key}`)
        return cached.data
      }
    }
    
    // Check for pending request
    const pending = this.pendingRequests.get(key)
    if (pending && !forceRefresh) {
      debug.log(`Deduplicating request: ${key}`)
      return pending.promise
    }
    
    debug.log(`New request: ${key}`)
    const promise = fetcher()
      .then((result) => {
        // Cache the result if caching is enabled
        if (cacheTTL > 0) {
          this.cache.set(key, { data: result, timestamp: Date.now() })
        }
        return result
      })
      .finally(() => {
        this.pendingRequests.delete(key)
      })
    
    this.pendingRequests.set(key, { promise, timestamp: Date.now() })
    
    return promise
  }
  
  /**
   * Clear cache for a specific key or all keys matching a pattern
   */
  clearCache(keyOrPattern?: string | RegExp): void {
    if (!keyOrPattern) {
      this.cache.clear()
      debug.log('Cleared all request cache')
      return
    }
    
    if (typeof keyOrPattern === 'string') {
      this.cache.delete(keyOrPattern)
      debug.log(`Cleared cache for: ${keyOrPattern}`)
    } else {
      // RegExp pattern
      for (const key of this.cache.keys()) {
        if (keyOrPattern.test(key)) {
          this.cache.delete(key)
        }
      }
      debug.log(`Cleared cache matching pattern: ${keyOrPattern}`)
    }
  }
  
  /**
   * Get cache statistics
   */
  getStats(): { pendingRequests: number; cachedItems: number } {
    return {
      pendingRequests: this.pendingRequests.size,
      cachedItems: this.cache.size
    }
  }
}

// Singleton instance
export const requestDeduplicator = new RequestDeduplicator()

/**
 * Commonly used cache keys
 */
export const CacheKeys = {
  authUser: () => 'auth:user',
  profileById: (id: string) => `profile:${id}`,
  profileByAuthId: (authId: string) => `profile:auth:${authId}`,
  userServers: (userId: string) => `user-servers:${userId}`,
  serverChannels: (serverId: string) => `server-channels:${serverId}`,
  serverCategories: (serverId: string) => `server-categories:${serverId}`,
  serverMembers: (serverId: string) => `server-members:${serverId}`,
  channelMessages: (channelId: string) => `channel-messages:${channelId}`,
  serverEmojis: (serverId: string) => `server-emojis:${serverId}`,
  notificationPreferences: (userId: string) => `notification-prefs:${userId}`,
  recoveryKeyMetadata: (userId: string) => `recovery-key:${userId}`,
}

