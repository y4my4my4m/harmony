import { onMounted, onUnmounted, ref, type Ref } from 'vue'

/** Status and snapshot refresh; a bridge heartbeats every 30 s and on change. */
const POLL_MS = 5000

/**
 * `now` for relative times, and `refresh` every `everyMs` and on return to the page while `active`
 * holds and the page is visible.
 */
export function useBridgePolling(active: () => boolean, refresh: () => void, everyMs = POLL_MS): { now: Ref<number> } {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null

  function poll() {
    now.value = Date.now()
    if (!active()) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    refresh()
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') poll()
  }

  onMounted(() => {
    timer = setInterval(poll, everyMs)
    document.addEventListener('visibilitychange', onVisibility)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibility)
  })

  return { now }
}
