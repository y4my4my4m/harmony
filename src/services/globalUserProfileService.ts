/**
 * Global User Profile Service - Centralized user profile management
 * 
 * This service provides a single source of truth for all user profile data,
 * handling caching, fetching, and synchronization across the application.
 * 
 * Features:
 * - Centralized user profile caching
 * - Intelligent cache management with LRU eviction
 * - Batch fetching optimization
 * - Event-driven profile updates
 * - Integration with global presence service
 */

import type { User } from '@/types'
import { UserStatus } from '@/types'
import { getProfilesWithAvatarUrls } from '@/services/usersService'
import { globalPresenceService } from './globalPresenceService'

export interface UserProfileEvents {
  'profile-updated': { userId: string; profile: User; timestamp: string }
  'profile-cached': { userId: string; timestamp: string }
  'cache-evicted': { userIds: string[]; timestamp: string }
}

interface UserProfileCache {
  profile: User
  lastFetched: Date
  hits: number
  lastAccessed: Date
}

class GlobalUserProfileService {
  // Core cache
  private profileCache = new Map<string, UserProfileCache>()
  
  // Cache configuration
  private readonly cacheValidityDuration = 10 * 60 * 1000 // 10 minutes
  private readonly maxCacheSize = 2000 // Increased from 1000 for better UX
  private readonly maxBatchSize = 50 // Maximum users to fetch in one batch
  
  // Request deduplication
  private pendingFetches = new Set<string>()
  private batchQueue = new Set<string>()
  private batchTimeout: NodeJS.Timeout | null = null
  private readonly batchDelay = 100 // ms to wait before executing batch
  
  // Event handling
  private eventTarget = new EventTarget()

  /**
   * Get user profile with intelligent caching
   */
  getUserProfile(userId: string): User | null {
    const cached = this.profileCache.get(userId)
    
    if (cached) {
      // Update access time and hit count
      cached.lastAccessed = new Date()
      cached.hits++
      
      // Check cache validity
      const now = new Date()
      const cacheAge = now.getTime() - cached.lastFetched.getTime()
      
      if (cacheAge < this.cacheValidityDuration) {
        // Merge with current presence data
        return this.enrichWithPresence(cached.profile)
      }
    }
    
    return null
  }

  /**
   * Fetch user profile with caching and deduplication
   */
  async fetchUserProfile(userId: string, forceRefresh = false): Promise<User | null> {
    // Check cache first unless force refresh
    if (!forceRefresh) {
      const cachedProfile = this.getUserProfile(userId)
      if (cachedProfile) {
        return cachedProfile
      }
    }

    // Check if already fetching to avoid duplicate requests
    if (this.pendingFetches.has(userId)) {
      return this.waitForPendingFetch(userId)
    }

    this.pendingFetches.add(userId)

    try {
      const profiles = await getProfilesWithAvatarUrls([userId])
      
      if (profiles.length === 0) {
        console.warn(`No profile found for user: ${userId}`)
        return null
      }

      const profile = this.processProfile(profiles[0])
      this.addToCache(profile)
      
      return this.enrichWithPresence(profile)

    } catch (error) {
      console.error(`Error fetching profile for user ${userId}:`, error)
      return null
    } finally {
      this.pendingFetches.delete(userId)
    }
  }

  /**
   * Batch fetch multiple profiles efficiently
   */
  async fetchMultipleUserProfiles(userIds: string[], forceRefresh = false): Promise<Record<string, User>> {
    const results: Record<string, User> = {}

    // Filter out cached users unless force refresh
    const uncachedUserIds = forceRefresh 
      ? userIds 
      : userIds.filter(id => !this.getUserProfile(id))

    // Return cached profiles immediately
    if (!forceRefresh) {
      userIds.forEach(id => {
        const profile = this.getUserProfile(id)
        if (profile) {
          results[id] = profile
        }
      })
    }

    if (uncachedUserIds.length === 0) {
      return results
    }

    try {
      // Process in batches to avoid overwhelming the API
      const batches = this.chunkArray(uncachedUserIds, this.maxBatchSize)
      
      for (const batch of batches) {
        const profiles = await getProfilesWithAvatarUrls(batch)
        
        profiles.forEach(profile => {
          if (profile) {
            const processedProfile = this.processProfile(profile)
            this.addToCache(processedProfile)
            results[profile.id] = this.enrichWithPresence(processedProfile)
          }
        })
      }

      console.log(`📦 Batch fetched ${Object.keys(results).length} profiles`)
      return results

    } catch (error) {
      console.error('Error batch fetching profiles:', error)
      return results
    }
  }

  /**
   * Queue user for batch fetching (optimized for performance)
   */
  queueUserForBatch(userId: string): Promise<User | null> {
    // Check cache first
    const cached = this.getUserProfile(userId)
    if (cached) {
      return Promise.resolve(cached)
    }

    // Add to batch queue
    this.batchQueue.add(userId)

    // Set up batch processing if not already scheduled
    if (!this.batchTimeout) {
      this.batchTimeout = setTimeout(() => {
        this.processBatchQueue()
      }, this.batchDelay)
    }

    // Return a promise that resolves when the user is fetched
    return new Promise((resolve) => {
      const checkForProfile = () => {
        const profile = this.getUserProfile(userId)
        if (profile) {
          resolve(profile)
        } else {
          // Check again after a short delay
          setTimeout(checkForProfile, 50)
        }
      }
      
      // Start checking after the batch delay + some buffer
      setTimeout(checkForProfile, this.batchDelay + 100)
    })
  }

  /**
   * Ensure multiple profiles are available (optimized for message displays)
   */
  async ensureProfilesAvailable(userIds: string[]): Promise<void> {
    const missingUserIds = userIds.filter(id => !this.getUserProfile(id))
    
    if (missingUserIds.length === 0) {
      return
    }

    await this.fetchMultipleUserProfiles(missingUserIds)
  }

  /**
   * Update a user profile in cache
   */
  updateUserProfile(userId: string, updates: Partial<User>): void {
    const cached = this.profileCache.get(userId)
    
    if (cached) {
      const updatedProfile = { ...cached.profile, ...updates }
      cached.profile = updatedProfile
      cached.lastFetched = new Date()
      
      this.emitEvent('profile-updated', {
        userId,
        profile: this.enrichWithPresence(updatedProfile),
        timestamp: new Date().toISOString()
      })
    }
  }

  /**
   * Invalidate cache for specific user
   */
  invalidateUserProfile(userId: string): void {
    if (this.profileCache.delete(userId)) {
      console.log(`🗑️ Invalidated profile cache for user: ${userId}`)
    }
  }

  /**
   * Clear all profile caches
   */
  clearCache(): void {
    const evictedUserIds = Array.from(this.profileCache.keys())
    this.profileCache.clear()
    
    if (evictedUserIds.length > 0) {
      this.emitEvent('cache-evicted', {
        userIds: evictedUserIds,
        timestamp: new Date().toISOString()
      })
      console.log(`🗑️ Cleared ${evictedUserIds.length} profile caches`)
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const totalHits = Array.from(this.profileCache.values())
      .reduce((sum, cache) => sum + cache.hits, 0)
    
    return {
      totalCached: this.profileCache.size,
      maxCacheSize: this.maxCacheSize,
      pendingFetches: this.pendingFetches.size,
      queuedForBatch: this.batchQueue.size,
      hitRate: this.profileCache.size > 0 ? totalHits / this.profileCache.size : 0,
      memoryUsage: this.estimateMemoryUsage()
    }
  }

  /**
   * Add event listener for profile events
   */
  addEventListener<K extends keyof UserProfileEvents>(
    type: K,
    listener: (event: CustomEvent<UserProfileEvents[K]>) => void
  ): void {
    this.eventTarget.addEventListener(type, listener as EventListener)
  }

  /**
   * Remove event listener
   */
  removeEventListener<K extends keyof UserProfileEvents>(
    type: K,
    listener: (event: CustomEvent<UserProfileEvents[K]>) => void
  ): void {
    this.eventTarget.removeEventListener(type, listener as EventListener)
  }

  // Private methods

  private async processBatchQueue(): Promise<void> {
    if (this.batchQueue.size === 0) return

    const userIds = Array.from(this.batchQueue)
    this.batchQueue.clear()
    this.batchTimeout = null

    console.log(`📦 Processing batch queue with ${userIds.length} users`)
    
    try {
      await this.fetchMultipleUserProfiles(userIds)
    } catch (error) {
      console.error('Error processing batch queue:', error)
    }
  }

  private async waitForPendingFetch(userId: string): Promise<User | null> {
    return new Promise((resolve) => {
      const checkComplete = () => {
        if (!this.pendingFetches.has(userId)) {
          resolve(this.getUserProfile(userId))
        } else {
          setTimeout(checkComplete, 50)
        }
      }
      checkComplete()
    })
  }

  private processProfile(rawProfile: any): User {
    return {
      ...rawProfile,
      status: this.convertToStatusEnum(rawProfile.status as number)
    }
  }

  private convertToStatusEnum(numericStatus: number): UserStatus {
    return numericStatus as UserStatus
  }

  private enrichWithPresence(profile: User): User {
    const presence = globalPresenceService.getUserPresence(profile.id)
    
    if (presence) {
      return {
        ...profile,
        status: presence.status,
        // Add any other presence-related fields
      }
    }
    
    return profile
  }

  private addToCache(profile: User): void {
    this.evictOldestCacheEntries()
    
    this.profileCache.set(profile.id, {
      profile,
      lastFetched: new Date(),
      lastAccessed: new Date(),
      hits: 0
    })

    this.emitEvent('profile-cached', {
      userId: profile.id,
      timestamp: new Date().toISOString()
    })
  }

  private evictOldestCacheEntries(): void {
    if (this.profileCache.size < this.maxCacheSize) return

    // Sort by last accessed time (LRU)
    const entries = Array.from(this.profileCache.entries())
      .sort((a, b) => a[1].lastAccessed.getTime() - b[1].lastAccessed.getTime())

    const toRemove = entries.slice(0, entries.length - this.maxCacheSize + 1)
    const evictedUserIds: string[] = []

    toRemove.forEach(([userId]) => {
      this.profileCache.delete(userId)
      evictedUserIds.push(userId)
    })

    if (evictedUserIds.length > 0) {
      this.emitEvent('cache-evicted', {
        userIds: evictedUserIds,
        timestamp: new Date().toISOString()
      })
      console.log(`🗑️ Evicted ${evictedUserIds.length} old profile cache entries`)
    }
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize))
    }
    return chunks
  }

  private estimateMemoryUsage(): number {
    // Rough estimation of memory usage in bytes
    let totalSize = 0
    this.profileCache.forEach((cache) => {
      // Estimate size of profile object (rough calculation)
      totalSize += JSON.stringify(cache.profile).length * 2 // UTF-16 encoding
      totalSize += 64 // Overhead for cache metadata
    })
    return totalSize
  }

  private emitEvent<K extends keyof UserProfileEvents>(type: K, detail: UserProfileEvents[K]): void {
    const event = new CustomEvent(type, { detail })
    this.eventTarget.dispatchEvent(event)
  }
}

// Export singleton instance
export const globalUserProfileService = new GlobalUserProfileService()
