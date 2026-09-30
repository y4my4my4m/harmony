import { useRouter } from 'vue-router'
import { useServerChannelStore } from '@/stores/useServerChannel'

/**
 * Routes to `channelId` in `serverId`, or to the server's default channel when
 * none is given. The server must already be in the user's server list; the bare
 * chat route is the fallback when it is not, or when it has no channels.
 */
export function useOpenServer() {
  const router = useRouter()
  const serverChannelStore = useServerChannelStore()

  return async function openServer(serverId: string, channelId?: string | null): Promise<void> {
    serverChannelStore.setCurrentServer(serverId)

    let targetChannelId = channelId ?? null
    if (!targetChannelId && serverChannelStore.currentServerId === serverId) {
      await serverChannelStore.fetchCategoriesAndChannels(serverId)
      if (serverChannelStore.currentServerId !== serverId) return
      targetChannelId = serverChannelStore.getDefaultChannel()
    }

    if (targetChannelId) {
      await router.push({ name: 'ChatChannel', params: { serverId, channelId: targetChannelId } })
    } else {
      await router.push({ name: 'Chat' })
    }
  }
}
