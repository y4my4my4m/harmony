/**
 * Leaves a server after confirmation. Local servers delete the caller's
 * user_servers row; federated servers go through FederationServerService.
 */

import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { supabase } from '@/supabase'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useUserData } from '@/composables/useUserData'
import { useAuthStore } from '@/stores/auth'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useChatStore } from '@/stores/useChat'
import { federationServerService } from '@/services/federation/FederationServerService'
import { debug } from '@/utils/debug'
import type { Server } from '@/types'

export function useLeaveServer() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  const authStore = useAuthStore()
  const serverChannelStore = useServerChannelStore()
  const { unsubscribeFromContext } = useUserData()
  const { confirm } = useConfirmDialog()

  /** `owner` holds the auth user id; owners cannot leave. */
  const isOwner = (server: Pick<Server, 'owner'> | null | undefined): boolean =>
    !!server && server.owner === authStore.session?.user?.id

  /** Resolves true once the server is left; false when cancelled or failed. */
  async function leaveServer(serverId: string): Promise<boolean> {
    const server = serverChannelStore.servers.find(s => s.id === serverId)
      ?? (serverChannelStore.currentServerId === serverId ? serverChannelStore.currentServer : null)
    const userId = authStore.session?.user?.id
    if (!server || !userId || isOwner(server)) return false

    const confirmed = await confirm({
      title: t('server.leaveServer'),
      message: t('serverRail.leave.confirm', { name: server.name }),
      confirmButtonText: t('serverRail.leave.button'),
      dangerAction: true,
    })
    if (!confirmed) return false

    try {
      const voiceStore = useUnifiedVoiceChannelStore()
      if (voiceStore.effectiveServerId === serverId) await voiceStore.leaveVoiceChannel()

      const wasCurrent = serverChannelStore.currentServerId === serverId
      if (wasCurrent) {
        const chatStore = useChatStore()
        chatStore.unsubscribeFromMessages()
        chatStore.clearMessages()
      }

      if (!server.is_local_server) {
        const result = await federationServerService.leaveServer(serverId, userId)
        if (!result.success) throw new Error(result.error || t('serverRail.leave.failed'))
      } else {
        const { error } = await supabase
          .from('user_servers')
          .delete()
          .eq('server_id', serverId)
          .eq('user_id', userId)
        if (error) throw error
      }

      toast.success(t('serverRail.leave.done'))
      await unsubscribeFromContext(serverId)
      serverChannelStore._cleanupServerState(serverId)
      if (wasCurrent) router.push('/')
      return true
    } catch (error) {
      debug.error('Error leaving server:', error)
      toast.error((error as Error)?.message || t('serverRail.leave.failed'))
      return false
    }
  }

  return { leaveServer, isOwner }
}
