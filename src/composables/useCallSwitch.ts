import { i18n } from '@/i18n'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

/** Conversation id of a DM call room: dm-{id} or federated-dm-{id}-{timestamp}. */
export function dmConversationIdFromChannel(channelId: string | null | undefined): string | null {
  if (!channelId) return null
  const federated = channelId.match(/^federated-dm-([a-f0-9-]{36})/i)
  if (federated) return federated[1]
  if (channelId.startsWith('dm-')) return channelId.slice(3)
  return null
}

/**
 * Starting or joining a call while in another one asks first, then leaves
 * the current call (Discord's "switch calls"). Resolves true when the
 * caller may proceed.
 */
export function useCallSwitch() {
  const voiceStore = useUnifiedVoiceChannelStore()
  const { confirm } = useConfirmDialog()

  async function leaveCurrentCallFor(targetChannelId: string | null = null): Promise<boolean> {
    if (!voiceStore.isConnectedOrJoining) return true
    if (targetChannelId && voiceStore.effectiveChannelId === targetChannelId) return true
    const t = i18n.global.t
    const ok = await confirm({
      title: t('voice.switchCallTitle'),
      message: t('voice.switchCallMessage', { channel: voiceStore.effectiveChannelName || t('voice.voiceChannel') }),
      confirmButtonText: t('voice.switchCallConfirm'),
    })
    if (!ok) return false
    await voiceStore.leaveVoiceChannel()
    return true
  }

  return { leaveCurrentCallFor }
}
