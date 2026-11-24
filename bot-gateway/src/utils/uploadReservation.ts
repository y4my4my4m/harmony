import { randomUUID } from 'node:crypto'
import { supabase } from '../config/supabase.js'

/** Claims bytes of a server's cap for one file. */
export interface Reservation {
  /** Claims `bytes` (whole) in all; false when the cap has no room. Throws when that cannot be asked. */
  claim(bytes: number): Promise<boolean>
  /** Gives the claim up. Never throws. */
  release(): Promise<void>
}

/**
 * bridge_upload_reserve: a file's bytes count toward the cap of the channel's server
 * (instance_config.bridge_mirror_server_limit_mb) from before it is read until `release`. The id is
 * this process's, so a claim whose answer was lost is released too. With `avatar` the file is also
 * one of at most `max` avatars of the bot.
 */
export class UploadReservation implements Reservation {
  private readonly id = randomUUID()
  private asked = false

  constructor(private readonly channelId: string, private readonly avatar?: { botId: string; max: number }) {}

  async claim(bytes: number): Promise<boolean> {
    this.asked = true
    const { data, error } = await supabase.rpc('bridge_upload_reserve', {
      p_reservation_id: this.id,
      p_channel_id: this.channelId,
      p_bytes: bytes,
      p_avatar_bot_id: this.avatar?.botId ?? null,
      p_max_avatars: this.avatar?.max ?? null,
    })
    if (error) throw new Error(`bridge_upload_reserve failed: ${error.message}`)
    return data === true
  }

  async release(): Promise<void> {
    if (!this.asked) return
    this.asked = false
    try {
      const { error } = await supabase.rpc('bridge_upload_release', { p_reservation_id: this.id })
      if (error) throw new Error(error.message)
    } catch (error: any) {
      // A reservation ends by itself after 1800 s.
      console.warn(`bridge_upload_release failed: ${error?.message || error}`)
    }
  }
}
