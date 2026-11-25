import { randomUUID } from 'node:crypto'
import { supabase } from '../config/supabase.js'

/**
 * bridge_upload_reserve's answer. Refused: 'full', the stored bytes leave no room; 'busy', only bytes
 * in flight are in the way; 'avatars', the bot holds its `max` avatars in the server.
 */
export type Claim = 'reserved' | 'full' | 'busy' | 'avatars'

const REFUSALS: readonly unknown[] = ['busy', 'avatars']

/** Claims bytes of a server's cap for one file. */
export interface Reservation {
  /** Claims `bytes` (whole) in all. Throws when that cannot be asked. */
  claim(bytes: number): Promise<Claim>
  /** Gives the claim up, one still being asked for included. Never throws. */
  release(): Promise<void>
}

/**
 * bridge_upload_reserve: a file's bytes count toward the cap of the channel's server
 * (instance_config.bridge_mirror_server_limit_mb) from before it is read until `release`. The id is
 * this process's, so a claim whose answer was lost is released too. With `avatar` the file is also
 * one of at most `max` avatars of the bot in the server.
 */
export class UploadReservation implements Reservation {
  private readonly id = randomUUID()
  private asked = false
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly channelId: string, private readonly avatar?: { botId: string; max: number }) {}

  claim(bytes: number): Promise<Claim> {
    this.asked = true
    const claim = this.ask(bytes)
    this.pending = Promise.allSettled([this.pending, claim])
    return claim
  }

  private async ask(bytes: number): Promise<Claim> {
    const { data, error } = await supabase.rpc('bridge_upload_reserve', {
      p_reservation_id: this.id,
      p_channel_id: this.channelId,
      p_bytes: bytes,
      p_avatar_bot_id: this.avatar?.botId ?? null,
      p_max_avatars: this.avatar?.max ?? null,
    })
    if (error) throw new Error(`bridge_upload_reserve failed: ${error.message}`)
    return data === 'reserved' || REFUSALS.includes(data) ? data as Claim : 'full'
  }

  async release(): Promise<void> {
    if (!this.asked) return
    this.asked = false
    // A release that overtakes its claim leaves the claim's bytes held for 1800 s.
    await this.pending
    try {
      const { error } = await supabase.rpc('bridge_upload_release', { p_reservation_id: this.id })
      if (error) throw new Error(error.message)
    } catch (error: any) {
      // A reservation ends by itself after 1800 s.
      console.warn(`bridge_upload_release failed: ${error?.message || error}`)
    }
  }
}
