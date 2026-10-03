import { reactive } from 'vue'
import { renderToObjectUrl } from '@/utils/storageImageUtils'

/**
 * Fallback from a public render URL to the stored object.
 *
 * imgproxy answers 422 for sources it refuses: animations over
 * IMGPROXY_MAX_SRC_RESOLUTION (width × height × frames) or over
 * IMGPROXY_MAX_ANIMATION_FRAMES. The object route serves the same file
 * untransformed.
 *
 * <img>: a capture listener on the window swaps a failed render URL for its
 * object URL and stops the event, so element handlers see only a failure of
 * the object URL and apply their own placeholder. The object URL is not a
 * render URL, so a second failure passes through; there is no loop.
 *
 * A failure is recorded per object, not per variant: the limits apply to the
 * source, so every size of that object fails alike. knownRenderFallback reads
 * the record reactively; display-URL helpers pass through it so later renders
 * request the object directly.
 *
 * CSS backgrounds fire no error event: withRenderFallback probes the render
 * URL once and reports the object URL after the probe fails.
 */

const failedObjects = reactive(new Set<string>())
const probedRenderUrls = new Set<string>()

function onResourceError(event: Event): void {
  const img = event.target
  if (!(img instanceof HTMLImageElement)) return
  const fallback = renderToObjectUrl(img.src)
  if (!fallback) return
  event.stopImmediatePropagation()
  failedObjects.add(fallback)
  img.src = fallback
}

/** Installs the <img> fallback on `target`; returns the uninstaller. */
export function installRenderFallback(target: Window = window): () => void {
  target.addEventListener('error', onResourceError, true)
  return () => target.removeEventListener('error', onResourceError, true)
}

/** `url`, or its object URL once a render of that object has failed. Reactive. */
export function knownRenderFallback(url: string): string
export function knownRenderFallback(url: string | null | undefined): string | null
export function knownRenderFallback(url: string | null | undefined): string | null {
  if (!url) return null
  const fallback = renderToObjectUrl(url)
  return fallback && failedObjects.has(fallback) ? fallback : url
}

/** knownRenderFallback that also probes an unproven render URL once; for CSS backgrounds. */
export function withRenderFallback(url: string): string
export function withRenderFallback(url: string | null | undefined): string | null
export function withRenderFallback(url: string | null | undefined): string | null {
  if (!url) return null
  const fallback = renderToObjectUrl(url)
  if (!fallback) return url
  if (failedObjects.has(fallback)) return fallback
  if (!probedRenderUrls.has(url) && typeof Image !== 'undefined') {
    probedRenderUrls.add(url)
    const probe = new Image()
    probe.onerror = () => { failedObjects.add(fallback) }
    probe.src = url
  }
  return url
}

/** Test hook: forgets probed and failed objects. */
export function resetRenderFallback(): void {
  failedObjects.clear()
  probedRenderUrls.clear()
}
