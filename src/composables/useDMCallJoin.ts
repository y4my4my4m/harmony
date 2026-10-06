import { useToast } from 'vue-toastification'
import { i18n } from '@/i18n'
import { useCallSwitch } from '@/composables/useCallSwitch'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { globalDMCallListener } from '@/services/GlobalDMCallListener'
import { authContextService } from '@/services/AuthContextService'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { debug } from '@/utils/debug'

/**
 * Joins the live call of a DM conversation by its id. An unanswered federated
 * ring is accepted through this instance, which returns credentials for the
 * caller's room, as BaseLayout handleGlobalCallAccept does; every other call is
 * the local room dm-{conversationId}. Resolves true once connected.
 */
export function useDMCallJoin() {
  const voiceStore = useUnifiedVoiceChannelStore()
  const { leaveCurrentCallFor } = useCallSwitch()
  const toast = useToast()

  async function joinConversationCall(conversationId: string): Promise<boolean> {
    const call = dmCallSignaling.getActiveCall(conversationId)
    if (!call) return false
    // An answered federated call names no room this client can rejoin.
    if (call.isFederated && !(call.ringing && call.callerFederatedId)) return false

    const room = call.isFederated ? null : `dm-${conversationId}`
    if (!(await leaveCurrentCallFor(room))) return false
    if (room && voiceStore.isConnected && voiceStore.currentChannelId === room) {
      voiceStore.isOverlayVisible = true
      return true
    }
    globalDMCallListener.dismissIncomingCall(conversationId)

    const failed = i18n.global.t('voice.joinCallFailed')
    try {
      const profileId = await authContextService.getCurrentProfileId()
      let joined: boolean
      if (call.isFederated) {
        const credentials = await dmCallSignaling.acceptFederatedCall(conversationId, profileId, call.callerFederatedId!)
        if (!credentials) {
          toast.error(failed)
          return false
        }
        joined = await voiceStore.joinVoiceChannel(credentials.roomName, 'dm', {
          livekit: { wsUrl: credentials.wsUrl, token: credentials.token },
        })
      } else {
        if (!(await dmCallSignaling.joinCall(conversationId, profileId))) return false
        joined = await voiceStore.joinVoiceChannel(room!, 'dm')
      }

      if (joined) {
        voiceStore.isOverlayVisible = true
      } else {
        toast.error(voiceStore.joinError || failed)
      }
      return joined
    } catch (error) {
      debug.error('Failed to join conversation call:', conversationId, error)
      toast.error(failed)
      return false
    }
  }

  return { joinConversationCall }
}
