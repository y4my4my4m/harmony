/**
 * Links to a channel, thread or message on this instance, read from their URL. Shapes as
 * utils/messageShareUrl builds them.
 */

import { isInstanceHost } from '@/utils/internalLinks'
import { runtimeConfig } from '@/services/runtimeConfig'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const THREAD_PATH = new RegExp(`^/chat/(${UUID})/thread/(${UUID})/?$`, 'i')
const CHANNEL_PATH = new RegExp(`^/chat/(${UUID})/(${UUID})/?$`, 'i')

export interface ChatLinkTarget {
  serverId: string
  /** Absent on a thread link. */
  channelId?: string
  threadId?: string
  messageId?: string
  /** Path and query, for the router. */
  path: string
}

/** The chat target of `url`, or null off this instance and for any other path. */
export function parseChatLink(url: unknown): ChatLinkTarget | null {
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const domain = runtimeConfig.domain as string | undefined
  if (parsed.host.toLowerCase() !== domain?.toLowerCase() && !isInstanceHost(parsed.host)) return null

  const messageId = parsed.searchParams.get('messageId') || undefined
  const query = messageId ? `?messageId=${encodeURIComponent(messageId)}` : ''
  const thread = THREAD_PATH.exec(parsed.pathname)
  if (thread) {
    return {
      serverId: thread[1],
      threadId: thread[2],
      messageId,
      path: `/chat/${thread[1]}/thread/${thread[2]}${query}`,
    }
  }
  const channel = CHANNEL_PATH.exec(parsed.pathname)
  if (channel) {
    return {
      serverId: channel[1],
      channelId: channel[2],
      messageId,
      path: `/chat/${channel[1]}/${channel[2]}${query}`,
    }
  }
  return null
}
