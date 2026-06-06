/**
 * AI emoji generation — resilient, app-global state.
 *
 * Generation can take several seconds. This composable owns the in-flight state
 * at module scope (not tied to any component), so the spinner survives the
 * picker/popup closing, and a success/error toast fires whenever it resolves —
 * even if the user navigated away. It never throws to the caller.
 */
import { ref, computed } from 'vue'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { generateAiEmoji } from '@/services/emojiService'
import type { Emoji } from '@/types'

// Module-level shared state (one in-flight generation at a time).
const isGenerating = ref(false)
const lastError = ref<string | null>(null)

export function useAiEmojiGeneration() {
  const toast = useToast()

  /**
   * Kick off a generation. Returns the created emoji on success or null on
   * failure. Safe to fire-and-forget; surfaces a toast either way.
   */
  async function generate(prompt: string): Promise<Emoji | null> {
    const trimmed = prompt.trim()
    if (!trimmed || isGenerating.value) return null

    isGenerating.value = true
    lastError.value = null
    try {
      const emoji = await generateAiEmoji(trimmed)
      toast.success(`✨ Generated :${emoji.name}:`)
      return emoji
    } catch (e) {
      const message = (e as Error)?.message || 'AI emoji generation failed'
      lastError.value = message
      toast.error(message)
      debug.warn('AI emoji generation failed:', message)
      return null
    } finally {
      isGenerating.value = false
    }
  }

  return {
    isGenerating: computed(() => isGenerating.value),
    lastError: computed(() => lastError.value),
    generate,
  }
}
