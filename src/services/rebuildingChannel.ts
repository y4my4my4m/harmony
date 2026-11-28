/**
 * Private broadcast or presence topic that outlives a server close.
 *
 * A `phx_close` from the server (events limit, expired token, channel process stop) reaches the
 * subscribe callback as CLOSED. realtime-js has removed the channel by then and does not rejoin it,
 * and a closed instance cannot join again, so a new instance is built after a backoff.
 *
 * CHANNEL_ERROR and TIMED_OUT stay with realtime-js's rejoin timer: a socket drop reports them on
 * every channel, and a rebuild per topic adds joins to a restart storm. A refused join stops the
 * topic until auth hands Realtime another member token (the refusal may have carried the anon key
 * or an expired token); each refusal holds the socket for Realtime's CHANNEL_ERROR_BACKOFF_MS.
 */

import type { RealtimeChannel, RealtimeChannelOptions } from '@supabase/supabase-js'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { ChannelCloseBackoff, isChannelRefusal } from '@/utils/realtimeRefusal'
import { currentRealtimeToken, onMemberToken } from '@/services/realtimeMemberToken'

export interface RebuildingChannelOptions {
  topic: string
  /** Merged under `private: true`. */
  config?: RealtimeChannelOptions['config']
  /** Attaches handlers. Runs once per instance, before subscribe. */
  bind: (channel: RealtimeChannel) => void
  /** Each SUBSCRIBED. `resumed`: the topic was down since the last one, so events were missed. */
  onSubscribed?: (resumed: boolean) => void
  /** Join refused. The channel is gone; it is opened again on another member token unless closed. */
  onRefused?: (err?: Error) => void
}

export interface RebuildingChannel {
  /** Sends on the current channel. While the topic is down nothing is sent and the result is 'error'. */
  send(...args: Parameters<RealtimeChannel['send']>): ReturnType<RealtimeChannel['send']>
  /** Removes the channel and cancels a pending rebuild. Its later callbacks are ignored. */
  close(): Promise<void>
}

export function openRebuildingChannel(options: RebuildingChannelOptions): RebuildingChannel {
  const { topic, config, bind, onSubscribed, onRefused } = options
  const backoff = new ChannelCloseBackoff()
  let current: RealtimeChannel | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let down = false
  // Token the last refused join carried; null while not refused.
  let refusedToken: string | null = null
  let tokenOff: (() => void) | null = null

  const retryRefused = (token: string): void => {
    if (closed || current || timer || refusedToken === null || refusedToken === token) return
    refusedToken = null
    open()
  }

  const open = (): void => {
    if (closed) return
    const channel = supabase.channel(topic, { config: { ...config, private: true } })
    current = channel
    bind(channel)
    channel.subscribe((status, err) => {
      if (current !== channel) return
      if (status === 'SUBSCRIBED') {
        const resumed = down
        down = false
        backoff.joined()
        debug.log(`[Realtime] ${topic} → SUBSCRIBED`)
        onSubscribed?.(resumed)
      } else if (status === 'CHANNEL_ERROR' && isChannelRefusal(err)) {
        debug.warn(`[Realtime] ${topic} refused:`, err?.message)
        current = null
        down = true
        refusedToken = currentRealtimeToken()
        tokenOff ??= onMemberToken(retryRefused)
        void supabase.removeChannel(channel)
        onRefused?.(err)
      } else if (status === 'CLOSED') {
        current = null
        down = true
        const delay = backoff.next()
        debug.warn(`[Realtime] ${topic} closed by the server; rebuilding in ${Math.round(delay)} ms`)
        timer = setTimeout(() => {
          timer = null
          open()
        }, delay)
      } else {
        down = true
        debug.warn(`[Realtime] ${topic} →`, status, err?.message ?? '')
      }
    })
  }

  open()

  return {
    send(...args) {
      return current ? current.send(...args) : Promise.resolve('error')
    },
    async close() {
      closed = true
      tokenOff?.()
      tokenOff = null
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const channel = current
      current = null
      if (channel) await supabase.removeChannel(channel)
    },
  }
}
