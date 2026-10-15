import { computed, type Ref } from 'vue'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useActivitiesStore } from '@/stores/activities'
import { styleRect } from '@/utils/appZoom'
import type { Rect } from '@/components/voice/voiceMenuModel'

/**
 * Activity button of a voice control bar: shown in a voice channel of a local server; opens
 * the launcher anchored to the button.
 */
export function useActivityButton(buttonRef: Ref<HTMLElement | null>) {
  const voice = useUnifiedVoiceChannelStore()
  const activities = useActivitiesStore()

  const available = computed(() => voice.isConnected
    && !!voice.currentServerId && voice.currentServerId !== 'dm'
    && !voice.isFederatedChannel)
  const visible = computed(() => activities.launcherOpen)
  const running = computed(() => !!activities.current)

  const toggle = () => {
    if (activities.launcherOpen) {
      activities.launcherOpen = false
      return
    }
    const r = buttonRef.value ? styleRect(buttonRef.value) : null
    activities.launcherAnchor = r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
    activities.launcherOpen = true
  }

  const close = () => {
    activities.launcherOpen = false
  }

  const anchor = computed<Rect | null>(() => activities.launcherAnchor)
  return { available, visible, running, anchor, toggle, close }
}
