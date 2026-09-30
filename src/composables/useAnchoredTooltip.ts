import { onScopeDispose, ref } from 'vue'

/**
 * Hover tooltip bound to the element that opened it. A tooltip whose anchor
 * leaves the DOM (folder collapse, list reorder) or stops being hovered hides
 * on the next check; mouseleave never fires for an anchor that unmounts under
 * a stationary pointer.
 */
export function useAnchoredTooltip<T extends object>(delayMs = 400, checkMs = 200) {
  const visible = ref(false)
  const y = ref(0)
  const payload = ref<T | null>(null)

  let anchor: HTMLElement | null = null
  let showTimer: ReturnType<typeof setTimeout> | null = null
  let watchTimer: ReturnType<typeof setInterval> | null = null

  const anchorIsLive = () => !!anchor && anchor.isConnected && anchor.matches(':hover')

  const stopWatching = () => {
    if (watchTimer) {
      clearInterval(watchTimer)
      watchTimer = null
    }
  }

  const hide = () => {
    if (showTimer) {
      clearTimeout(showTimer)
      showTimer = null
    }
    stopWatching()
    anchor = null
    visible.value = false
  }

  /** `event.currentTarget` is the anchor; its vertical centre is the tooltip's y, in viewport px. */
  const show = (event: MouseEvent, data: T) => {
    const target = event.currentTarget as HTMLElement | null
    if (!target) return
    if (showTimer) clearTimeout(showTimer)
    stopWatching()

    anchor = target
    const rect = target.getBoundingClientRect()
    const nextY = rect.top + rect.height / 2

    showTimer = setTimeout(() => {
      showTimer = null
      if (!anchorIsLive()) {
        hide()
        return
      }
      payload.value = data
      y.value = nextY
      visible.value = true
      watchTimer = setInterval(() => {
        if (!anchorIsLive()) hide()
      }, checkMs)
    }, delayMs)
  }

  const onWindowBlur = () => hide()
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('dragstart', onWindowBlur, true)
  }

  onScopeDispose(() => {
    hide()
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('dragstart', onWindowBlur, true)
    }
  })

  return { visible, y, payload, show, hide }
}
