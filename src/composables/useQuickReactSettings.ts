/**
 * Quick-React Settings Composable
 *
 * Quick react: a double-click (mouse) or a double-tap (touch) on a message reacts with one
 * emoji. Each gesture has its own switch; the emoji is shared. Stored in per-user scoped
 * localStorage of this device, not on the account.
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

const DOUBLE_CLICK_KEY = 'quick-react-double-click'
const DOUBLE_TAP_KEY = 'quick-react-double-tap'
/** One switch for both gestures before 1.8.12; seeds either switch not yet stored. */
const LEGACY_ENABLED_KEY = 'quick-react-enabled'
const EMOJI_KEY = 'quick-react-emoji'

const DEFAULT_EMOJI: QuickReactEmoji = { id: '👍', name: 'thumbs up', content: '👍' }

// Shared module-level state across all callers.
const doubleClick = ref<boolean>(true)
const doubleTap = ref<boolean>(true)
const emoji = ref<QuickReactEmoji>({ ...DEFAULT_EMOJI })
let isInitialized = false

function loadSettings(): void {
  if (isInitialized) return
  try {
    const legacy = userStorage.getItem(LEGACY_ENABLED_KEY)
    const storedClick = userStorage.getItem(DOUBLE_CLICK_KEY) ?? legacy
    const storedTap = userStorage.getItem(DOUBLE_TAP_KEY) ?? legacy
    if (storedClick !== null) doubleClick.value = storedClick === 'true'
    if (storedTap !== null) doubleTap.value = storedTap === 'true'

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
    userStorage.setItem(DOUBLE_CLICK_KEY, doubleClick.value.toString())
    userStorage.setItem(DOUBLE_TAP_KEY, doubleTap.value.toString())
    userStorage.setItem(EMOJI_KEY, JSON.stringify(emoji.value))
  } catch (error) {
    debug.error('Failed to save quick-react settings:', error)
  }
}

watch([doubleClick, doubleTap], persist)
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

  return {
    doubleClick,
    doubleTap,
    emoji,
    setEmoji,
  }
}
