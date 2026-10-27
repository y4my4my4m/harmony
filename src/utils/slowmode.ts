// Slowmode intervals offered by Create Channel and the channel editor, in seconds: Discord's
// steps. create_channel and server templates accept 0-21600.

export const SLOWMODE_STEPS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600] as const

type Translate = (key: string, plural?: number) => string

/**
 * "5m" beside the slider ('short') or "5 minutes" as its aria-valuetext ('long'), from the
 * channel.edit.slowmodeShort / slowmodeLong keys.
 */
export function formatSlowmode(t: Translate, seconds: number, form: 'short' | 'long'): string {
  const group = form === 'short' ? 'slowmodeShort' : 'slowmodeLong'
  if (seconds === 0) return t('channel.edit.slowmodeOff')
  if (seconds < 60) return t(`channel.edit.${group}.seconds`, seconds)
  if (seconds < 3600) return t(`channel.edit.${group}.minutes`, seconds / 60)
  return t(`channel.edit.${group}.hours`, seconds / 3600)
}

/** Index of the step at or below `seconds`: a value set elsewhere snaps down. */
export function slowmodeStepIndex(seconds: number | null | undefined): number {
  const value = seconds ?? 0
  for (let i = SLOWMODE_STEPS.length - 1; i >= 0; i--) {
    if (SLOWMODE_STEPS[i] <= value) return i
  }
  return 0
}
