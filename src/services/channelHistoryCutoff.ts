import { reactive } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

/**
 * READ_MESSAGE_HISTORY cutoff per server channel, as get_message_page reports it in
 * history_since: where the viewer's view of a channel that withholds the permission starts
 * ('infinity' before it starts), null where the channel does not withhold it. Channels whose
 * pages never reported one are absent.
 */
const cutoffs = reactive(new Map<string, string | null>())

/** Channels whose view started in this session. */
const begun = new Set<string>()

export function recordHistoryCutoff(channelId: string, since: unknown): void {
  if (since === undefined) return
  cutoffs.set(channelId, typeof since === 'string' && since ? since : null)
}

export function historyCutoff(channelId: string | null | undefined): string | null {
  return channelId ? cutoffs.get(channelId) ?? null : null
}

export function historyViewBegun(channelId: string): boolean {
  return begun.has(channelId)
}

/**
 * Starts this session's view of a channel that withholds READ_MESSAGE_HISTORY, as Discord's
 * client: messages created from now on read until the app reloads or signs out. True when a
 * view started; false where the channel does not withhold it or the call failed.
 */
export async function beginHistoryView(channelId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('begin_channel_history_view', { p_channel_id: channelId })
    if (error) {
      debug.warn('begin_channel_history_view failed:', error.message)
      return false
    }
    if (typeof data !== 'string' || !data) return false
    begun.add(channelId)
    cutoffs.set(channelId, data)
    return true
  } catch (error) {
    debug.warn('begin_channel_history_view failed:', error)
    return false
  }
}

export function clearHistoryCutoffs(): void {
  cutoffs.clear()
  begun.clear()
}
