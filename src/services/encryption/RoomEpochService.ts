/**
 * RoomEpochService
 *
 * Thin client wrapper over the server-authoritative room membership epoch
 * (room_epoch_state, bumped by DB triggers on membership changes). The epoch is
 * used to rotate Megolm sessions when membership changes so that, e.g., a user
 * who left a channel cannot decrypt messages sent after they left ("Bob leaves
 * -> cannot read new messages").
 *
 * Reads are cached briefly to keep the send hot-path cheap; the cache TTL bounds
 * how long a client keeps using a stale (lower) epoch after a membership change.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

const EPOCH_CACHE_TTL_MS = 30_000

interface CachedEpoch {
  epoch: number
  cachedAt: number
}

class RoomEpochService {
  private cache = new Map<string, CachedEpoch>()

  /**
   * Current epoch for a room. Defaults to 1 on any error so encryption is never
   * blocked by epoch lookup failures (fail-open to "epoch 1").
   */
  async getEpoch(roomId: string): Promise<number> {
    if (!roomId) return 1
    const cached = this.cache.get(roomId)
    if (cached && Date.now() - cached.cachedAt < EPOCH_CACHE_TTL_MS) {
      return cached.epoch
    }
    try {
      const { data, error } = await supabase.rpc('get_room_epoch', { p_room_id: roomId })
      const epoch = typeof data === 'number' && !error ? data : 1
      this.cache.set(roomId, { epoch, cachedAt: Date.now() })
      return epoch
    } catch (err) {
      debug.warn('⚠️ get_room_epoch failed, defaulting to epoch 1:', err)
      return 1
    }
  }

  /** Force a new epoch for a room (manual rotate). Returns the new epoch. */
  async rotate(roomId: string, reason = 'manual_rotate'): Promise<number | null> {
    try {
      const { data, error } = await supabase.rpc('request_room_epoch_bump', {
        p_room_id: roomId,
        p_reason: reason,
      })
      if (error) {
        debug.warn('⚠️ request_room_epoch_bump failed:', error)
        return null
      }
      this.invalidate(roomId)
      return typeof data === 'number' ? data : null
    } catch (err) {
      debug.warn('⚠️ rotate epoch threw:', err)
      return null
    }
  }

  invalidate(roomId: string): void {
    this.cache.delete(roomId)
  }

  clear(): void {
    this.cache.clear()
  }
}

export const roomEpochService = new RoomEpochService()
