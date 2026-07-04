/**
 * Server Membership Service
 * Centralized service for server membership queries with caching
 * Prevents duplicate queries to user_servers table
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

// Cache for member counts (server_id -> count)
const memberCountCache = new Map<string, { count: number; timestamp: number }>()
const MEMBER_COUNT_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Cache for user membership checks (userId-serverId -> boolean)
const membershipCache = new Map<string, { isMember: boolean; timestamp: number }>()
const MEMBERSHIP_CACHE_TTL = 2 * 60 * 1000 // 2 minutes

// Pending requests to prevent duplicate concurrent queries
const pendingMemberCountRequests = new Map<string, Promise<number>>()
const pendingMembershipChecks = new Map<string, Promise<boolean>>()

/**
 * Get member count for a server (with caching and deduplication)
 */
export async function getServerMemberCount(serverId: string, forceRefresh = false): Promise<number> {
  if (!serverId) return 0

  // Check cache first
  if (!forceRefresh) {
    const cached = memberCountCache.get(serverId)
    if (cached && Date.now() - cached.timestamp < MEMBER_COUNT_CACHE_TTL) {
      return cached.count
    }
  }

  const pendingKey = `count-${serverId}`
  const pendingRequest = pendingMemberCountRequests.get(pendingKey)
  if (pendingRequest) {
    debug.log(`📊 Member count request already pending for server ${serverId}, reusing`)
    return pendingRequest
  }

  const requestPromise = (async () => {
    try {
      const { count, error } = await supabase
        .from('user_servers')
        .select('*', { count: 'exact', head: true })
        .eq('server_id', serverId)

      if (error) {
        debug.error(`❌ Failed to get member count for server ${serverId}:`, error)
        return 0
      }

      const memberCount = count || 0

      // Cache the result
      memberCountCache.set(serverId, { count: memberCount, timestamp: Date.now() })

      return memberCount
    } catch (error) {
      debug.error(`❌ Error getting member count for server ${serverId}:`, error)
      return 0
    } finally {
      pendingMemberCountRequests.delete(pendingKey)
    }
  })()

  pendingMemberCountRequests.set(pendingKey, requestPromise)

  return requestPromise
}

/**
 * Batch get member counts for multiple servers (more efficient)
 */
export async function getServerMemberCounts(serverIds: string[]): Promise<Map<string, number>> {
  const results = new Map<string, number>()

  const uncachedServerIds: string[] = []
  for (const serverId of serverIds) {
    const cached = memberCountCache.get(serverId)
    if (cached && Date.now() - cached.timestamp < MEMBER_COUNT_CACHE_TTL) {
      results.set(serverId, cached.count)
    } else {
      uncachedServerIds.push(serverId)
    }
  }

  // If all were cached, return early
  if (uncachedServerIds.length === 0) {
    return results
  }

  // Batch query for uncached servers
  try {
    const { data, error } = await supabase
      .from('user_servers')
      .select('server_id')
      .in('server_id', uncachedServerIds)

    if (error) {
      debug.error('❌ Failed to batch get member counts:', error)
      return results
    }

    // Count members per server
    const counts = new Map<string, number>()
    for (const item of data || []) {
      counts.set(item.server_id, (counts.get(item.server_id) || 0) + 1)
    }

    // Cache results and add to return map
    const now = Date.now()
    for (const serverId of uncachedServerIds) {
      const count = counts.get(serverId) || 0
      memberCountCache.set(serverId, { count, timestamp: now })
      results.set(serverId, count)
    }
  } catch (error) {
    debug.error('❌ Error batch getting member counts:', error)
  }

  return results
}

/**
 * Check if a user is a member of a server (with caching)
 */
export async function isUserMemberOfServer(
  userId: string,
  serverId: string,
  forceRefresh = false
): Promise<boolean> {
  if (!userId || !serverId) return false

  const cacheKey = `${userId}-${serverId}`

  // Check cache first
  if (!forceRefresh) {
    const cached = membershipCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < MEMBERSHIP_CACHE_TTL) {
      return cached.isMember
    }
  }

  const pendingRequest = pendingMembershipChecks.get(cacheKey)
  if (pendingRequest) {
    debug.log(`📊 Membership check already pending for ${userId}-${serverId}, reusing`)
    return pendingRequest
  }

  const requestPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from('user_servers')
        .select('id')
        .eq('user_id', userId)
        .eq('server_id', serverId)
        .maybeSingle()

      if (error) {
        debug.error(`❌ Failed to check membership for ${userId}-${serverId}:`, error)
        return false
      }

      const isMember = !!data

      // Cache the result
      membershipCache.set(cacheKey, { isMember, timestamp: Date.now() })

      return isMember
    } catch (error) {
      debug.error(`❌ Error checking membership for ${userId}-${serverId}:`, error)
      return false
    } finally {
      pendingMembershipChecks.delete(cacheKey)
    }
  })()

  pendingMembershipChecks.set(cacheKey, requestPromise)

  return requestPromise
}

/**
 * Invalidate cache for a server (call when membership changes)
 */
export function invalidateServerCache(serverId: string): void {
  memberCountCache.delete(serverId)
  // Also invalidate all membership checks for this server
  for (const key of membershipCache.keys()) {
    if (key.endsWith(`-${serverId}`)) {
      membershipCache.delete(key)
    }
  }
  debug.log(`🗑️ Invalidated cache for server ${serverId}`)
}

/**
 * Invalidate cache for a user (call when user joins/leaves servers)
 */
export function invalidateUserCache(userId: string): void {
  // Invalidate all membership checks for this user
  for (const key of membershipCache.keys()) {
    if (key.startsWith(`${userId}-`)) {
      membershipCache.delete(key)
    }
  }
  debug.log(`🗑️ Invalidated membership cache for user ${userId}`)
}

/**
 * Clear all caches (use sparingly)
 */
export function clearAllCaches(): void {
  memberCountCache.clear()
  membershipCache.clear()
  debug.log('🗑️ Cleared all server membership caches')
}
