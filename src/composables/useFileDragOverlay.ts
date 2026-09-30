import { onScopeDispose, ref } from 'vue'

export const dataTransferHasFiles = (dt: DataTransfer): boolean =>
  Array.from(dt.types || []).includes('Files')

/**
 * Visibility of a file-drop overlay.
 *
 * Nested dragenter/dragleave pairs on the drop target are counted. Window
 * capture listeners reset on drop, dragend, blur, Escape and pointer release,
 * so a child that stops drop propagation cannot strand the overlay. Browsers
 * repeat dragover every ~350 ms while a drag is over a target; `idleMs` of
 * silence resets, which covers a drag that leaves the window.
 */
export function useFileDragOverlay(
  accepts: (dt: DataTransfer) => boolean = dataTransferHasFiles,
  idleMs = 1000,
) {
  const visible = ref(false)
  let depth = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const reset = () => {
    depth = 0
    visible.value = false
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(reset, idleMs)
  }

  /** Shows the overlay for drags reported outside the DOM (Tauri webview events). */
  const hold = () => {
    visible.value = true
    armIdle()
  }

  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer || !accepts(event.dataTransfer)) return
    depth += 1
    hold()
  }

  const onDragOver = () => {
    if (visible.value) armIdle()
  }

  const onDragLeave = () => {
    if (depth === 0) return
    depth -= 1
    if (depth === 0) reset()
  }

  const onWindowDragLeave = (event: DragEvent) => {
    // Leaving the document reports a null relatedTarget and a point on or past the viewport edge.
    if (event.relatedTarget) return
    const { clientX: x, clientY: y } = event
    if (x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight) reset()
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && visible.value) reset()
  }

  const resetEvents = ['drop', 'dragend', 'mouseup', 'pointerup'] as const
  if (typeof window !== 'undefined') {
    resetEvents.forEach((name) => window.addEventListener(name, reset, true))
    window.addEventListener('dragleave', onWindowDragLeave, true)
    window.addEventListener('blur', reset)
    window.addEventListener('keydown', onKeydown, true)
  }

  onScopeDispose(() => {
    reset()
    if (typeof window === 'undefined') return
    resetEvents.forEach((name) => window.removeEventListener(name, reset, true))
    window.removeEventListener('dragleave', onWindowDragLeave, true)
    window.removeEventListener('blur', reset)
    window.removeEventListener('keydown', onKeydown, true)
  })

  return { visible, onDragEnter, onDragOver, onDragLeave, reset, hold }
}
