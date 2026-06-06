/**
 * AI emoji generation — resilient, app-global state.
 *
 * Generation is asynchronous (webhook-driven on the backend): we POST to start
 * the job, then wait for an `ai_emoji:generated` (or `ai_emoji:failed`) event
 * on the user's realtime channel. This composable owns the in-flight state at
 * module scope (not tied to any component), so the spinner survives the
 * picker/popup closing and the result is handled wherever the user is.
 *
 * It also tracks the user's daily generation quota so the picker can show how
 * many generations are left (auto-bounded by the instance-wide cap, and skipped
 * for instance admins/owners).
 */
import { ref, computed } from 'vue'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import {
  generateAiEmoji,
  registerGeneratedEmoji,
  getAiEmojiQuota,
  type AiEmojiQuota,
} from '@/services/emojiService'
import { userEventChannel } from '@/services/UserEventChannel'
import type { Emoji } from '@/types'

// Module-level shared state (one in-flight generation at a time).
const isGenerating = ref(false)
const lastError = ref<string | null>(null)
const quota = ref<AiEmojiQuota | null>(null)
let quotaLoaded = false

// Webhook delivery can lag; give it a generous window before giving up so the
// spinner doesn't stop while Klipy is still rendering.
const GENERATION_TIMEOUT_MS = 130_000

// Resolver for the in-flight job, keyed by the backend job id. The realtime
// listeners (registered once below) settle this when the event arrives.
interface InflightJob {
  jobId: string
  resolve: (emoji: Emoji | null) => void
  timer: ReturnType<typeof setTimeout>
}
let inflight: InflightJob | null = null
let listenersBound = false

function settle(emoji: Emoji | null): void {
  if (!inflight) return
  clearTimeout(inflight.timer)
  const { resolve } = inflight
  inflight = null
  isGenerating.value = false
  resolve(emoji)
}

/** Bind the realtime listeners once; safe to call repeatedly. */
function ensureListeners(): void {
  if (listenersBound) return
  listenersBound = true

  userEventChannel.on('ai_emoji:generated', (payload) => {
    // Ignore events for a different job than the one we're awaiting.
    if (inflight && payload.jobId && payload.jobId !== inflight.jobId) return
    const raw = payload.emoji as { id: string; name: string; url: string } | undefined
    if (!raw?.id) return settle(null)
    const emoji = registerGeneratedEmoji(raw)
    if (payload.quota) quota.value = payload.quota as AiEmojiQuota
    settle(emoji)
  })

  userEventChannel.on('ai_emoji:failed', (payload) => {
    if (inflight && payload.jobId && payload.jobId !== inflight.jobId) return
    lastError.value = typeof payload.error === 'string' ? payload.error : 'AI emoji generation failed'
    settle(null)
  })
}

export function useAiEmojiGeneration() {
  const toast = useToast()
  ensureListeners()

  /** Load the user's remaining-generations quota (cached after first call). */
  async function refreshQuota(force = false): Promise<void> {
    if (quotaLoaded && !force && quota.value) return
    const result = await getAiEmojiQuota()
    if (result) {
      quota.value = result
      quotaLoaded = true
    }
  }

  /**
   * Kick off a generation and await its async result. Returns the created emoji
   * on success or null on failure/timeout. Safe to fire-and-forget; surfaces a
   * toast either way.
   */
  async function generate(prompt: string): Promise<Emoji | null> {
    const trimmed = prompt.trim()
    if (!trimmed || isGenerating.value) return null

    isGenerating.value = true
    lastError.value = null

    let started: Awaited<ReturnType<typeof generateAiEmoji>>
    try {
      started = await generateAiEmoji(trimmed)
    } catch (e) {
      const message = (e as Error)?.message || 'AI emoji generation failed'
      lastError.value = message
      toast.error(message)
      debug.warn('AI emoji generation failed to start:', message)
      isGenerating.value = false
      refreshQuota(true).catch(() => {})
      return null
    }

    if (started.quota) quota.value = started.quota

    // Wait for the realtime result (or timeout). The listeners call settle().
    return new Promise<Emoji | null>((resolve) => {
      const timer = setTimeout(() => {
        // wrapResolve (invoked by settle) shows the error toast from lastError.
        lastError.value = 'AI emoji generation timed out — please try again'
        settle(null)
        refreshQuota(true).catch(() => {})
      }, GENERATION_TIMEOUT_MS)

      inflight = { jobId: started.jobId, resolve: wrapResolve(resolve, toast), timer }
    })
  }

  return {
    isGenerating: computed(() => isGenerating.value),
    lastError: computed(() => lastError.value),
    quota: computed(() => quota.value),
    refreshQuota,
    generate,
  }
}

/** Wrap the promise resolver to fire the success toast on a real emoji. */
function wrapResolve(
  resolve: (emoji: Emoji | null) => void,
  toast: ReturnType<typeof useToast>,
) {
  return (emoji: Emoji | null) => {
    if (emoji) {
      toast.success(`✨ Generated :${emoji.name}:`)
    } else if (lastError.value) {
      toast.error(lastError.value)
    }
    resolve(emoji)
  }
}
