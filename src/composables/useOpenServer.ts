import { useRouter, type RouteLocationRaw } from 'vue-router'
import { useServerChannelStore } from '@/stores/useServerChannel'

/**
 * Routes to `channelId` in `serverId`, or to the server's landing channel (last
 * viewed, else default) when none is given. The server must already be in the
 * user's server list; the bare chat route is the fallback when it is not, or
 * when it has no channels. `replace` takes the current history entry's place.
 */
export function useOpenServer() {
  const router = useRouter()
  const serverChannelStore = useServerChannelStore()

  return async function openServer(
    serverId: string,
    channelId?: string | null,
    options: { replace?: boolean } = {},
  ): Promise<void> {
    const go = (to: RouteLocationRaw) => (options.replace ? router.replace(to) : router.push(to))
    serverChannelStore.setCurrentServer(serverId)

    let targetChannelId = channelId ?? null
    if (!targetChannelId && serverChannelStore.currentServerId === serverId) {
      await serverChannelStore.fetchCategoriesAndChannels(serverId)
      if (serverChannelStore.currentServerId !== serverId) return
      targetChannelId = serverChannelStore.landingChannelFor(serverId)
    }

    if (targetChannelId) {
      await go({ name: 'ChatChannel', params: { serverId, channelId: targetChannelId } })
    } else {
      await go({ name: 'Chat' })
    }
  }
}
