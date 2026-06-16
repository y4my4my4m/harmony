import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

/** Ephemeral Discord (or other bridge) member from bot-gateway — not persisted in Harmony DB. */
export interface BridgedChannelUser {
  id: string
  username: string
  displayName: string
  avatarUrl: string
  source: 'discord'
}

interface CachedBridgedUsers {
  users: BridgedChannelUser[]
  hasBridge: boolean
  timestamp: number
}

const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_SIZE = 50

const cache = new Map<string, CachedBridgedUsers>()
const pending = new Map<string, Promise<CachedBridgedUsers>>()

function isCacheValid(entry: CachedBridgedUsers | undefined): boolean {
  if (!entry) return false
  return Date.now() - entry.timestamp < CACHE_TTL_MS
}

function pruneCache(): void {
  if (cache.size <= CACHE_MAX_SIZE) return
  const entries = Array.from(cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)
  for (const [key] of entries.slice(0, entries.length - CACHE_MAX_SIZE)) {
    cache.delete(key)
  }
}

export function clearBridgedUsersCache(channelId?: string): void {
  if (channelId) {
    cache.delete(channelId)
    pending.delete(channelId)
  } else {
    cache.clear()
    pending.clear()
  }
}

export async function fetchBridgedChannelUsers(channelId: string): Promise<{
  hasBridge: boolean
  users: BridgedChannelUser[]
}> {
  if (!channelId) {
    return { hasBridge: false, users: [] }
  }

  const cached = cache.get(channelId)
  if (isCacheValid(cached)) {
    return { hasBridge: cached!.hasBridge, users: cached!.users }
  }

  const existing = pending.get(channelId)
  if (existing) {
    const result = await existing
    return { hasBridge: result.hasBridge, users: result.users }
  }

  const fetchPromise = (async (): Promise<CachedBridgedUsers> => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = {}
      if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`
      }

      const response = await fetch(`/bot-gateway/bridged-users/${channelId}`, { headers })
      if (!response.ok) {
        debug.log(`🌉 Failed to fetch bridged users: ${response.status}`)
        return { users: [], hasBridge: false, timestamp: Date.now() }
      }

      const data = await response.json()
      const users = data.has_bridge && Array.isArray(data.users)
        ? data.users as BridgedChannelUser[]
        : []
      const entry: CachedBridgedUsers = {
        users,
        hasBridge: !!data.has_bridge,
        timestamp: Date.now(),
      }
      cache.set(channelId, entry)
      pruneCache()
      debug.log(`🌉 Loaded ${users.length} bridged users for channel ${channelId}`)
      return entry
    } catch (error) {
      debug.log('🌉 Bridge API not available:', error)
      return { users: [], hasBridge: false, timestamp: Date.now() }
    } finally {
      pending.delete(channelId)
    }
  })()

  pending.set(channelId, fetchPromise)
  const result = await fetchPromise
  return { hasBridge: result.hasBridge, users: result.users }
}
