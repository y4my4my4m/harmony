import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { UserStatus, type User } from '@/types'
import { apiUrl } from '@/services/instanceConfig'

export const BRIDGED_DISCORD_USER_ID_PREFIX = 'discord:'

export interface BridgedDiscordRole {
  id: string
  name: string
  color: string | null
  position: number
}

export interface BridgedCustomStatus {
  text: string
  emoji: string | null
}

/** Ephemeral Discord (or other bridge) member from bot-gateway - not persisted in Harmony DB. */
export interface BridgedChannelUser {
  id: string
  username: string
  displayName: string
  avatarUrl: string
  bannerUrl?: string | null
  accentColor?: string | null
  harmonyRoleIds?: string[]
  roles?: BridgedDiscordRole[]
  joinedAt?: string | null
  createdAt?: string | null
  presenceStatus?: 'online' | 'away' | 'busy' | 'offline'
  customStatus?: BridgedCustomStatus | null
  source: 'discord'
}

interface CachedBridgedUsers {
  users: BridgedChannelUser[]
  hasBridge: boolean
  timestamp: number
}

const CACHE_TTL_MS = 90 * 1000
const CACHE_MAX_SIZE = 50

const cache = new Map<string, CachedBridgedUsers>()
const serverCache = new Map<string, CachedBridgedUsers>()
const pending = new Map<string, Promise<CachedBridgedUsers>>()
const serverPending = new Map<string, Promise<CachedBridgedUsers>>()
/** Latest bridged user payload by Discord snowflake (any channel/server fetch). */
const usersByDiscordId = new Map<string, BridgedChannelUser>()

function isCacheValid(entry: CachedBridgedUsers | undefined): boolean {
  if (!entry) return false
  return Date.now() - entry.timestamp < CACHE_TTL_MS
}

function pruneCache(map: Map<string, CachedBridgedUsers>): void {
  if (map.size <= CACHE_MAX_SIZE) return
  const entries = Array.from(map.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)
  for (const [key] of entries.slice(0, entries.length - CACHE_MAX_SIZE)) {
    map.delete(key)
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  const headers: Record<string, string> = {}
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`
  }
  return headers
}

function indexBridgedUsers(users: BridgedChannelUser[]): void {
  for (const user of users) {
    usersByDiscordId.set(user.id, user)
  }
}

export function clearBridgedUsersCache(channelId?: string): void {
  if (channelId) {
    cache.delete(channelId)
    pending.delete(channelId)
  } else {
    cache.clear()
    serverCache.clear()
    pending.clear()
    serverPending.clear()
    usersByDiscordId.clear()
  }
}

/** Look up a bridged user from the in-memory cache (no network). */
export function findBridgedUserInCache(
  _channelId: string | null | undefined,
  discordUserId: string,
): BridgedChannelUser | null {
  return usersByDiscordId.get(discordUserId) ?? null
}

export function resolveBridgedUserColor(
  user: BridgedChannelUser,
  harmonyRoleColor?: string | null,
): string | undefined {
  if (harmonyRoleColor) return harmonyRoleColor
  const coloredRole = user.roles?.find(r => r.color)
  return coloredRole?.color ?? undefined
}

export function isBridgedDiscordProfileUser(
  user: { id?: string; bridge_source?: string } | null | undefined,
): boolean {
  if (!user) return false
  return user.bridge_source === 'discord'
    || !!user.id?.startsWith(BRIDGED_DISCORD_USER_ID_PREFIX)
}

export function bridgedUserToProfileUser(bridged: BridgedChannelUser): User {
  let status = UserStatus.Offline
  switch (bridged.presenceStatus) {
    case 'online': status = UserStatus.Online; break
    case 'away': status = UserStatus.Away; break
    case 'busy': status = UserStatus.Busy; break
    default: status = UserStatus.Offline
  }

  return {
    id: `${BRIDGED_DISCORD_USER_ID_PREFIX}${bridged.id}`,
    username: bridged.username,
    display_name: bridged.displayName,
    avatar_url: bridged.avatarUrl,
    banner_url: bridged.bannerUrl ?? undefined,
    accent_color: bridged.accentColor ?? null,
    color: resolveBridgedUserColor(bridged),
    status,
    created_at: bridged.createdAt ?? undefined,
    bridge_source: 'discord',
    discord_id: bridged.id,
    discord_joined_at: bridged.joinedAt ?? null,
    discord_custom_status: bridged.customStatus ?? null,
    roles: (bridged.roles ?? []).map(r => ({
      id: r.id,
      name: r.name,
      color: r.color ?? '#99AAB5',
      permissions: [],
      position: r.position,
    })),
    is_local: false,
  }
}

export function discordMetadataToBridgedUser(meta: {
  id: string
  username: string
  display_name?: string
  avatar_url?: string
}): BridgedChannelUser {
  return {
    id: meta.id,
    username: meta.username,
    displayName: meta.display_name || meta.username,
    avatarUrl: meta.avatar_url || '',
    source: 'discord',
  }
}

export async function fetchBridgedChannelUsers(
  channelId: string,
  options: { force?: boolean } = {},
): Promise<{
  hasBridge: boolean
  users: BridgedChannelUser[]
}> {
  if (!channelId) {
    return { hasBridge: false, users: [] }
  }

  const cached = cache.get(channelId)
  if (!options.force && isCacheValid(cached)) {
    return { hasBridge: cached!.hasBridge, users: cached!.users }
  }

  const existing = pending.get(channelId)
  if (existing) {
    const result = await existing
    return { hasBridge: result.hasBridge, users: result.users }
  }

  const fetchPromise = (async (): Promise<CachedBridgedUsers> => {
    try {
      const response = await fetch(apiUrl(`/bot-gateway/bridged-users/${channelId}`), {
        headers: await authHeaders(),
      })
      if (!response.ok) {
        debug.log(`Failed to fetch bridged users: ${response.status}`)
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
      indexBridgedUsers(users)
      pruneCache(cache)
      debug.log(`Loaded ${users.length} bridged users for channel ${channelId}`)
      return entry
    } catch (error) {
      debug.log('Bridge API not available:', error)
      return { users: [], hasBridge: false, timestamp: Date.now() }
    } finally {
      pending.delete(channelId)
    }
  })()

  pending.set(channelId, fetchPromise)
  const result = await fetchPromise
  return { hasBridge: result.hasBridge, users: result.users }
}

export async function fetchBridgedServerUsers(
  serverId: string,
  options: { force?: boolean } = {},
): Promise<{
  hasBridge: boolean
  users: BridgedChannelUser[]
}> {
  if (!serverId) {
    return { hasBridge: false, users: [] }
  }

  const cached = serverCache.get(serverId)
  if (!options.force && isCacheValid(cached)) {
    return { hasBridge: cached!.hasBridge, users: cached!.users }
  }

  const existing = serverPending.get(serverId)
  if (existing) {
    const result = await existing
    return { hasBridge: result.hasBridge, users: result.users }
  }

  const fetchPromise = (async (): Promise<CachedBridgedUsers> => {
    try {
      const response = await fetch(apiUrl(`/bot-gateway/bridged-users/server/${serverId}`), {
        headers: await authHeaders(),
      })
      if (!response.ok) {
        debug.log(`Failed to fetch server bridged users: ${response.status}`)
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
      serverCache.set(serverId, entry)
      indexBridgedUsers(users)
      pruneCache(serverCache)
      return entry
    } catch (error) {
      debug.log('Server bridge API not available:', error)
      return { users: [], hasBridge: false, timestamp: Date.now() }
    } finally {
      serverPending.delete(serverId)
    }
  })()

  serverPending.set(serverId, fetchPromise)
  const result = await fetchPromise
  return { hasBridge: result.hasBridge, users: result.users }
}
