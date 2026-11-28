import { computed } from 'vue'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useActivitiesStore } from '@/stores/activities'
import { usePlayTogetherStore } from '@/stores/playTogether'
import type { ActivityTarget } from '@/services/playTogether/sessions'

/**
 * Activities button of a voice control bar: opens the activities launcher
 * (ActivitiesLauncher, stores/playTogether launcher) for the call. Shown in a voice
 * channel of a local server, where watching together runs; games join it when an
 * enabled app lists calls.
 */
export function useActivityButton() {
  const voice = useUnifiedVoiceChannelStore()
  const activities = useActivitiesStore()
  const playTogether = usePlayTogetherStore()

  const target = computed<ActivityTarget | null>(() => {
    if (!voice.isConnected || !voice.currentServerId || voice.currentServerId === 'dm' || voice.isFederatedChannel) return null
    if (!voice.currentChannelId) return null
    return { kind: 'channel', id: voice.currentChannelId, serverId: voice.currentServerId, voice: true }
  })
  const available = computed(() => !!target.value)
  const visible = computed(() => {
    const open = playTogether.launcher?.target
    return !!open && !!target.value && open.kind === 'channel' && open.id === target.value.id
  })
  const gameOnStage = computed(() => {
    const joined = playTogether.joined?.target
    return !!joined && joined.kind === 'channel' && joined.voice && joined.id === voice.currentChannelId
  })
  const running = computed(() => !!activities.current || gameOnStage.value)

  const open = () => {
    if (target.value) playTogether.openLauncher(target.value)
  }
  const close = () => {
    if (visible.value) playTogether.closeLauncher()
  }
  const toggle = () => (visible.value ? close() : open())

  return { target, available, visible, running, gameOnStage, open, close, toggle }
}
