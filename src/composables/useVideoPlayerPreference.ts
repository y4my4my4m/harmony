import { computed, ref, type ComputedRef } from 'vue'

/**
 * The visual theme's videoPlayer setting, mirrored here by useVisualTheme. Media components
 * read this module instead of useVisualTheme, whose store imports they would otherwise pull in.
 */
const preference = ref<'harmony' | 'native'>('harmony')

export function setVideoPlayerPreference(value: 'harmony' | 'native' | undefined): void {
  preference.value = value === 'native' ? 'native' : 'harmony'
}

/** True when the user picked the browser's own video controls over Harmony's player. */
export function useNativeVideoControls(): ComputedRef<boolean> {
  return computed(() => preference.value === 'native')
}
