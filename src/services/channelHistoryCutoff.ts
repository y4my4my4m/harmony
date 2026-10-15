import { reactive } from 'vue'

/**
 * READ_MESSAGE_HISTORY cutoff per server channel, as get_message_page reports it in
 * history_since: the viewer's join time where the channel withholds the permission, null where
 * it does not. Channels whose pages never reported one are absent.
 */
const cutoffs = reactive(new Map<string, string | null>())

export function recordHistoryCutoff(channelId: string, since: unknown): void {
  if (since === undefined) return
  cutoffs.set(channelId, typeof since === 'string' && since ? since : null)
}

export function historyCutoff(channelId: string | null | undefined): string | null {
  return channelId ? cutoffs.get(channelId) ?? null : null
}

export function clearHistoryCutoffs(): void {
  cutoffs.clear()
}
