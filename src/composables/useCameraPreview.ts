import { getCurrentInstance, onBeforeUnmount, shallowRef } from 'vue'
import { debug } from '@/utils/debug'

/**
 * Camera preview of the voice settings. One capture is live at a time; a capture resolving
 * after its run was superseded or the component unmounted is stopped at once, so no camera is
 * left on behind a closed settings page. Same generation guard as useMicTest.
 */
export function useCameraPreview() {
  const stream = shallowRef<MediaStream | null>(null)
  // Bumped by every start and stop.
  let generation = 0

  function stop(): void {
    generation++
    stream.value?.getTracks().forEach(track => track.stop())
    stream.value = null
  }

  /** `video` is read once the capture resolves: the element can be gone by then. */
  async function start(constraints: MediaStreamConstraints, video: () => HTMLVideoElement | null): Promise<void> {
    stop()
    const run = generation
    try {
      const captured = await navigator.mediaDevices.getUserMedia(constraints)
      if (run !== generation) {
        captured.getTracks().forEach(track => track.stop())
        return
      }
      stream.value = captured
      const element = video()
      if (element) element.srcObject = captured
    } catch (error) {
      debug.error('Error starting video preview:', error)
    }
  }

  if (getCurrentInstance()) onBeforeUnmount(stop)

  return { stream, start, stop }
}
