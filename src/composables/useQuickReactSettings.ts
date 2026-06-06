/**
 * Quick-React Settings Composable
 *
 * Stores the user's "double-tap / double-click a message to quick-react"
 * preference: whether it's enabled and which emoji to apply. Persisted in
 * per-user scoped localStorage (client-only, not synced to the server).
 */

import { ref, watch } from 'vue'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'

/** Minimal emoji shape needed to apply a reaction (native or custom). */
export interface QuickReactEmoji {
  /** Native unicode char OR custom emoji UUID. Drives native-vs-custom logic. */
  id: string
  name: string
  /** Set for custom (image) emoji. */
  url?: string
  /** Native unicode char (used for optimistic render). */
  content?: string
}

const ENABLED_KEY = 'quick-react-enabled'
const EMOJI_KEY = 'quick-react-emoji'

const DEFAULT_EMOJI: QuickReactEmoji = { id: '👍', name: 'thumbs up', content: '👍' }

// Shared module-level state across all callers.
const enabled = ref<boolean>(true)
const emoji = ref<QuickReactEmoji>({ ...DEFAULT_EMOJI })
let isInitialized = false

function loadSettings(): void {
  if (isInitialized) return
  try {
    const storedEnabled = userStorage.getItem(ENABLED_KEY)
    if (storedEnabled !== null) enabled.value = storedEnabled === 'true'

    const storedEmoji = userStorage.getItem(EMOJI_KEY)
    if (storedEmoji) {
      const parsed = JSON.parse(storedEmoji)
      if (parsed && typeof parsed.id === 'string') {
        emoji.value = {
          id: parsed.id,
          name: typeof parsed.name === 'string' ? parsed.name : parsed.id,
          url: typeof parsed.url === 'string' ? parsed.url : undefined,
          content: typeof parsed.content === 'string' ? parsed.content : undefined,
        }
      }
    }
    isInitialized = true
  } catch (error) {
    debug.error('Failed to load quick-react settings:', error)
    isInitialized = true
  }
}

function persist(): void {
  try {
    userStorage.setItem(ENABLED_KEY, enabled.value.toString())
    userStorage.setItem(EMOJI_KEY, JSON.stringify(emoji.value))
  } catch (error) {
    debug.error('Failed to save quick-react settings:', error)
  }
}

watch(enabled, persist)
watch(emoji, persist, { deep: true })

export function useQuickReactSettings() {
  loadSettings()

  function setEmoji(next: QuickReactEmoji): void {
    emoji.value = {
      id: next.id,
      name: next.name || next.id,
      url: next.url || undefined,
      content: next.content || undefined,
    }
  }

  function setEnabled(value: boolean): void {
    enabled.value = value
  }

  return {
    enabled,
    emoji,
    setEmoji,
    setEnabled,
  }
}
