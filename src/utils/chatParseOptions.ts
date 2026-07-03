/**
 * Context-aware parse options for chat message input.
 *
 * Server chat: '#name' resolves against the current server's text channels
 * (the store only ever holds channels of a server the user is a member of,
 * so the map is inherently access-scoped). DMs: '#' has no meaning at all.
 */

import { useServerChannelStore } from '@/stores/useServerChannel'
import type { ContentParseOptions } from './unifiedContentProcessing'

export function buildChatParseOptions(isDM: boolean): ContentParseOptions {
  if (isDM) return { hashtags: 'none' }

  const serverChannelStore = useServerChannelStore()
  const serverId = serverChannelStore.currentServerId
  if (!serverId) return { hashtags: 'none' }

  const channelDataMap: Record<string, { id: string; serverId: string; name: string }> = {}
  for (const channel of serverChannelStore.channels) {
    if (channel.type === 0) {
      channelDataMap[channel.name.toLowerCase()] = {
        id: channel.id,
        serverId: channel.server_id || serverId,
        name: channel.name,
      }
    }
  }
  return { hashtags: 'channels', channelDataMap }
}
