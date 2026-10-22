import { readonly, ref, type Ref } from 'vue'
import { apiUrl } from '@/services/instanceConfig'

/**
 * Whether this instance streams X video to this browser (GET /api/federation/embed-media/config,
 * EMBED_RELAY_ENABLED on the backend). False until it answers, and when it cannot: X video then
 * plays in X's embedded post outside WebKit (components/embeds/XPostFrame.vue).
 */
const relaysXVideo = ref(false)
let requested = false

async function load(): Promise<void> {
  try {
    const res = await fetch(apiUrl('/api/federation/embed-media/config'), { headers: { Accept: 'application/json' } })
    if (!res.ok) return
    const body = await res.json()
    relaysXVideo.value = body?.relaysXVideo === true
  } catch {
    // Absent backend or not JSON: no relay.
  }
}

export function useXVideoRelay(): Readonly<Ref<boolean>> {
  if (!requested) {
    requested = true
    void load()
  }
  return readonly(relaysXVideo)
}

/**
 * A WebKit engine (Safari, the iOS and macOS apps, every iOS browser): it asks the instance's
 * redirect again for every byte range, which X accepts. Mirrors isWebKitRequest in
 * federation-backend/src/routes/embedMedia.ts.
 */
export function isWebKitEngine(): boolean {
  if (typeof navigator === 'undefined') return false
  if ((navigator as Navigator & { userAgentData?: unknown }).userAgentData) return false
  const ua = navigator.userAgent
  return /AppleWebKit\//.test(ua) && !/Chrom(e|ium)\/\d/.test(ua)
}

/** Forgets the instance's answer. Tests only. */
export function resetXVideoRelay(): void {
  requested = false
  relaysXVideo.value = false
}
