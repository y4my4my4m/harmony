import { computed, onBeforeUnmount, watch, type Ref } from 'vue'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { useT } from '@/composables/useT'

/** Meter percent at or above which the test counts as hearing sound. */
export const MIC_SOUND_THRESHOLD = 10
/** Silence after the test starts before "no sound" is spoken, ms. */
export const MIC_NO_SOUND_MS = 4000

/**
 * Spoken result of a microphone test, for users who cannot see the meter:
 * "Testing" on start, "Sound detected" on the first level at or above
 * MIC_SOUND_THRESHOLD, "No sound detected" after MIC_NO_SOUND_MS without one.
 * `meterText` is the meter's aria-valuetext.
 */
export function useMicTestStatus(isTesting: Ref<boolean>, level: Ref<number>) {
  const { t } = useT()
  const { polite } = useAnnouncer()
  let heard = false
  let silenceTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  watch(isTesting, (testing) => {
    clearTimer()
    heard = false
    if (!testing) return
    polite(t('settings.voice.micTestStarted'), { key: 'mic-test', dedupeMs: 0 })
    silenceTimer = setTimeout(() => {
      silenceTimer = null
      if (isTesting.value && !heard) polite(t('settings.voice.micTestSilent'), { key: 'mic-test', dedupeMs: 0 })
    }, MIC_NO_SOUND_MS)
  })

  watch(level, (value) => {
    if (!isTesting.value || heard || value < MIC_SOUND_THRESHOLD) return
    heard = true
    clearTimer()
    polite(t('settings.voice.micTestHeard'), { key: 'mic-test', dedupeMs: 0 })
  })

  onBeforeUnmount(clearTimer)

  const meterText = computed(() => t('settings.voice.micLevelValue', { level: Math.round(level.value) }))

  return { meterText }
}
