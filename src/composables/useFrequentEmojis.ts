/**
 * Frequent Emojis Composable
 * 
 * Tracks user's most frequently used emojis in localStorage
 * and provides methods to get top emojis for the picker and context menu.
 */

import { ref, computed } from 'vue'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'

interface EmojiUsage {
  id: string           // Emoji ID or unicode character
  native?: string      // Unicode emoji character (for native emojis)
  name: string         // Emoji name/shortcode
  url?: string         // URL for custom server emojis
  count: number        // Usage count
  lastUsed: number     // Timestamp of last use
}

const STORAGE_KEY = 'frequent-emojis'
const MAX_STORED_EMOJIS = 50  // Maximum emojis to track

// Shared state across all composable instances
const frequentEmojis = ref<EmojiUsage[]>([])
const isInitialized = ref(false)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * An entry a reaction can be written from: a unicode emoji, an emojis id, a `:shortcode:`
 * or a `discord:name:id`. Clicking a bridged Discord pill recorded its display name as the
 * id (reactionGroupKey before 1.9.4); such a bare name is no emoji and the server refuses it.
 */
function isReactableEntry(entry: unknown): entry is EmojiUsage {
  if (!entry || typeof entry !== 'object') return false
  const { id, native } = entry as Partial<EmojiUsage>
  if (typeof id !== 'string' || !id) return false
  if (typeof native === 'string' && native) return true
  return UUID_RE.test(id) || id.startsWith('discord:') || /^:.+:$/.test(id) || !/[A-Za-z]/.test(id)
}

/**
 * Load frequent emojis from localStorage
 */
function loadFrequentEmojis(): void {
  if (isInitialized.value) return
  
  try {
    const stored = userStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed: unknown = JSON.parse(stored)
      frequentEmojis.value = Array.isArray(parsed) ? parsed.filter(isReactableEntry) : []
    }
    isInitialized.value = true
    debug.log('Loaded frequent emojis:', frequentEmojis.value.length)
  } catch (error) {
    debug.error('Failed to load frequent emojis:', error)
    frequentEmojis.value = []
  }
}

/**
 * Save frequent emojis to localStorage
 */
function saveFrequentEmojis(): void {
  try {
    const sorted = [...frequentEmojis.value]
      .sort((a, b) => {
        // Primary sort by count (descending)
        if (b.count !== a.count) return b.count - a.count
        // Secondary sort by lastUsed (descending)
        return b.lastUsed - a.lastUsed
      })
      .slice(0, MAX_STORED_EMOJIS)
    
    frequentEmojis.value = sorted
    userStorage.setItem(STORAGE_KEY, JSON.stringify(sorted))
  } catch (error) {
    debug.error('Failed to save frequent emojis:', error)
  }
}

/**
 * Record emoji usage (call this when an emoji is used)
 */
function recordEmojiUsage(emoji: { id?: string; native?: string; name: string; url?: string }): void {
  loadFrequentEmojis()
  
  const emojiId = emoji.id || emoji.native || emoji.name
  if (!emojiId) return
  
  const existingIndex = frequentEmojis.value.findIndex(e => 
    e.id === emojiId || 
    (e.native && e.native === emoji.native) ||
    (e.name === emoji.name && !e.native && !emoji.native)
  )
  
  if (existingIndex >= 0) {
    frequentEmojis.value[existingIndex].count++
    frequentEmojis.value[existingIndex].lastUsed = Date.now()
    if (emoji.url) {
      frequentEmojis.value[existingIndex].url = emoji.url
    }
  } else {
    frequentEmojis.value.push({
      id: emojiId,
      native: emoji.native,
      name: emoji.name,
      url: emoji.url,
      count: 1,
      lastUsed: Date.now()
    })
  }
  
  saveFrequentEmojis()
  debug.log('Recorded emoji usage:', emoji.name)
}

/**
 * Remove an emoji from the frequently used list
 */
export function removeFrequentEmoji(emojiId: string): void {
  loadFrequentEmojis()
  const idx = frequentEmojis.value.findIndex(e => e.id === emojiId || e.native === emojiId)
  if (idx >= 0) {
    frequentEmojis.value.splice(idx, 1)
    saveFrequentEmojis()
    debug.log('Removed frequent emoji:', emojiId)
  }
}

/**
 * Check if an emoji is in the frequently used list
 */
function isFrequentEmoji(emojiId: string): boolean {
  loadFrequentEmojis()
  return frequentEmojis.value.some(e => e.id === emojiId || e.native === emojiId)
}

/**
 * Get top N frequently used emojis
 */
function getTopEmojis(limit: number = 10): EmojiUsage[] {
  loadFrequentEmojis()
  
  return frequentEmojis.value
    .sort((a, b) => {
      // Primary sort by count (descending)
      if (b.count !== a.count) return b.count - a.count
      // Secondary sort by lastUsed (descending)
      return b.lastUsed - a.lastUsed
    })
    .slice(0, limit)
}

/**
 * Composable for frequent emojis
 */
export function useFrequentEmojis() {
  // Load on first use
  loadFrequentEmojis()
  
  // Top 10 for emoji picker
  const topEmojisForPicker = computed(() => getTopEmojis(10))
  
  // Top 4 for context menu quick reactions
  const topEmojisForContextMenu = computed(() => getTopEmojis(4))
  
  const hasFrequentEmojis = computed(() => frequentEmojis.value.length > 0)
  
  return {
    // State
    frequentEmojis,
    topEmojisForPicker,
    topEmojisForContextMenu,
    hasFrequentEmojis,
    
    // Methods
    recordEmojiUsage,
    removeFrequentEmoji,
    isFrequentEmoji,
    getTopEmojis,
    
    reload: () => {
      isInitialized.value = false
      loadFrequentEmojis()
    }
  }
}

