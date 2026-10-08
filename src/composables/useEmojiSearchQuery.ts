import { ref, watch, onScopeDispose } from 'vue'

/** Debounce of the picker search input, ms. Clearing applies at once. */
export const EMOJI_SEARCH_DEBOUNCE_MS = 90

/**
 * `searchQuery` binds the input; `activeQuery` is its trimmed, lowercased,
 * debounced copy that filtering and rendering follow.
 */
export function useEmojiSearchQuery() {
  const searchQuery = ref('')
  const activeQuery = ref('')
  let timer: ReturnType<typeof setTimeout> | null = null

  watch(searchQuery, (q) => {
    if (timer) clearTimeout(timer)
    timer = null
    const next = q.toLowerCase().trim()
    if (!next) {
      activeQuery.value = ''
      return
    }
    timer = setTimeout(() => {
      timer = null
      activeQuery.value = next
    }, EMOJI_SEARCH_DEBOUNCE_MS)
  })

  onScopeDispose(() => {
    if (timer) clearTimeout(timer)
  })

  return { searchQuery, activeQuery }
}
