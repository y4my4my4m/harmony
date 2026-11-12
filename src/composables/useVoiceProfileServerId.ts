import { computed, type ComputedRef } from 'vue'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

/**
 * The server whose member profiles apply to the people in the current call: the voice
 * channel's server, or null in a direct call (the store uses 'dm' there), where the
 * account profile shows.
 */
export function useVoiceProfileServerId(): ComputedRef<string | null> {
  const voiceStore = useUnifiedVoiceChannelStore()
  return computed(() => {
    const id = voiceStore.currentServerId
    return id && id !== 'dm' ? id : null
  })
}
