import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig';
import { debug } from '@/utils/debug'

const API_BASE = apiUrl('/api/federation/realtime')

type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline' | 'invisible'

interface PresenceData {
  status: PresenceStatus
  customStatus?: string
  lastSeen: number
}

/**
 * Client for the Redis-backed realtime API on the federation backend.
 *
 * Handles:
 *  - Presence heartbeats (every 60s)
 *  - Bulk presence queries (sidebar, profiles)
 *  - Typing indicator relay (when Redis is available)
 *
 * Falls back gracefully when the API is unreachable - the existing
 * Supabase Realtime Presence continues to work in parallel.
 */
class RealtimeApiServiceSingleton {
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private currentStatus: PresenceStatus = 'online'
  private customStatus: string | undefined
  private _available: boolean | null = null // null = not yet tested
  private _goingOffline = false

  private async getAuthHeaders(): Promise<HeadersInit> {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error('No auth session')
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    }
  }

  private async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T | null> {
    try {
      const headers = await this.getAuthHeaders()
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        if (res.status === 401) debug.warn('RealtimeApi: auth expired')
        return null
      }
      this._available = true
      return await res.json() as T
    } catch {
      if (this._available !== false) {
        debug.warn('RealtimeApi: federation backend unreachable, falling back to Supabase Presence')
        this._available = false
      }
      return null
    }
  }

  private async get<T = unknown>(path: string): Promise<T | null> {
    try {
      const headers = await this.getAuthHeaders()
      const res = await fetch(`${API_BASE}${path}`, { headers })
      if (!res.ok) return null
      this._available = true
      return await res.json() as T
    } catch {
      if (this._available !== false) {
        debug.warn('RealtimeApi: federation backend unreachable for GET')
        this._available = false
      }
      return null
    }
  }

  get available(): boolean {
    return this._available === true
  }

  // ─── Presence ────────────────────────────────────────────────────────

  /**
   * Start sending heartbeats every 60 seconds.
   * Also sends an immediate heartbeat.
   * Redis TTL is 90s so 60s gives 1.5x grace.
   */
  startHeartbeat(status: PresenceStatus = 'online', customStatus?: string): void {
    this._goingOffline = false
    this.currentStatus = status
    this.customStatus = customStatus
    this.sendHeartbeat()

    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 60_000)
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  updateStatus(status: PresenceStatus, customStatus?: string): void {
    this.currentStatus = status
    this.customStatus = customStatus
    this.sendHeartbeat()
  }

  private async sendHeartbeat(): Promise<void> {
    await this.post('/heartbeat', {
      status: this.currentStatus,
      customStatus: this.customStatus,
    })
  }

  async goOffline(): Promise<void> {
    if (this._goingOffline) return
    this._goingOffline = true
    this.stopHeartbeat()
    try {
      await this.post('/offline')
    } finally {
      this._goingOffline = false
    }
  }

  /**
   * Fetch presence for a batch of profile IDs (max 200).
   */
  async getBulkPresence(profileIds: string[]): Promise<Map<string, PresenceData>> {
    const result = new Map<string, PresenceData>()
    if (profileIds.length === 0) return result

    const data = await this.post<{ presence: Record<string, PresenceData> }>('/presence/bulk', { profileIds })
    if (!data?.presence) return result

    for (const [id, pd] of Object.entries(data.presence)) {
      result.set(id, pd)
    }
    return result
  }

  /**
   * Get all online profile IDs.
   */
  async getOnlineIds(): Promise<string[]> {
    const data = await this.get<{ online: string[] }>('/presence/online')
    return data?.online ?? []
  }

  // ─── Typing ──────────────────────────────────────────────────────────

  async startTyping(contextType: 'channel' | 'conversation' | 'thread', contextId: string, username: string): Promise<void> {
    await this.post('/typing/start', { contextType, contextId, username })
  }

  async stopTyping(contextType: 'channel' | 'conversation' | 'thread', contextId: string): Promise<void> {
    await this.post('/typing/stop', { contextType, contextId })
  }

  async getTypingUsers(contextType: 'channel' | 'conversation' | 'thread', contextId: string): Promise<Array<{ profileId: string; username: string; startedAt: number }>> {
    const data = await this.post<{ typing: Array<{ profileId: string; username: string; startedAt: number }> }>('/typing/active', { contextType, contextId })
    return data?.typing ?? []
  }

  // ─── Profiles (cached) ─────────────────────────────────────────────

  /**
   * Fetch profiles through the Redis cache layer (max 100).
   */
  async getBulkProfiles(profileIds: string[]): Promise<Map<string, any>> {
    const result = new Map<string, any>()
    if (profileIds.length === 0) return result

    const data = await this.post<{ profiles: Record<string, any> }>('/profiles/bulk', { profileIds })
    if (!data?.profiles) return result

    for (const [id, profile] of Object.entries(data.profiles)) {
      result.set(id, profile)
    }
    return result
  }

  // ─── Health ──────────────────────────────────────────────────────────

  async checkHealth(): Promise<boolean> {
    const data = await this.get<{ ok: boolean; latencyMs?: number }>('/redis-health')
    const ok = data?.ok ?? false
    this._available = ok
    return ok
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  cleanup(): void {
    this.stopHeartbeat()
    this._available = null
  }
}

export const realtimeApiService = new RealtimeApiServiceSingleton()
export default realtimeApiService
