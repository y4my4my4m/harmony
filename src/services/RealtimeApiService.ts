import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig';
import { debug } from '@/utils/debug'

const API_BASE = apiUrl('/api/federation/realtime')

/**
 * Client for the Redis-backed realtime API on the federation backend: typing relay and the
 * cached profile batch. Presence is the database's (userDataService); the backend's
 * /heartbeat, /offline and /presence routes serve clients older than 1.9.4.
 */
class RealtimeApiServiceSingleton {
  private _available: boolean | null = null // null = not yet tested

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
        debug.warn('RealtimeApi: federation backend unreachable')
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
    this._available = null
  }
}

export const realtimeApiService = new RealtimeApiServiceSingleton()
export default realtimeApiService
