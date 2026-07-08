/**
 * Emoji Pack Service
 * 
 * Manages swappable emoji packs:
 * - Twemoji (default) - Twitter's open source emojis
 * - Native Unicode - System default emojis
 * 
 * Additional packs can be registered at runtime via `registerEmojiPack()`
 * (reserved for a future custom-emoji-pack feature).
 */

import { ref, computed } from 'vue'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'
import { 
  EMOJI_CATEGORIES, 
  TWEMOJI_BASE_URL, 
  DEFAULT_EMOJI_PACK,
  type EmojiPack as EmojiPackType
} from '@/utils/emojiConstants'

export interface EmojiPackItem {
  id: string              // Unique identifier (filename without extension)
  name: string            // Display name (emoji shortcode)
  category: string        // Category name
  subcategory?: string    // Subcategory name
  path: string            // Path to the SVG file
  keywords?: string[]     // Search keywords
}

export interface EmojiPackCategory {
  id: string
  name: string
  icon: string            // Category icon (emoji or SVG path)
  order?: number
  subcategories?: string[]
}

export interface EmojiPack {
  id: string
  name: string
  description: string
  basePath: string
  format: 'svg' | 'png' | 'webp'
  categories: EmojiPackCategory[]
  emojis: EmojiPackItem[]
  isBuiltIn: boolean      // True for native Unicode
  /** Path to a single representative emoji image used in pack pickers. */
  previewImage?: string
  /**
   * Path to a probe asset (relative to basePath) the service can fetch to
   * verify the pack is actually installed on this instance. When present,
   * `detectAvailablePacks()` will only register packs whose probe responds 2xx.
   * If omitted, the pack is assumed to be available (e.g. native / built-in).
   */
  probePath?: string
}

// Logical key; userStorage namespaces it per-instance (and per-user) so an
// emoji pack chosen on one Harmony instance doesn't override another's.
const STORAGE_KEY = 'emoji-pack'
const LEGACY_STORAGE_KEY = 'harmony-emoji-pack'
const DEFAULT_PACK_ID: EmojiPackType = DEFAULT_EMOJI_PACK

// Available emoji packs
const availablePacks = ref<Map<string, EmojiPack>>(new Map())
const currentPackId = ref<string>(DEFAULT_PACK_ID)
const isInitialized = ref(false)
/** True after `detectAvailablePacks()` has finished probing optional packs. */
const packsDetected = ref(false)

// Twemoji pack definition (NEW DEFAULT)
const twemojiPack: EmojiPack = {
  id: 'twemoji',
  name: 'Twemoji',
  description: 'Twitter\'s open source emoji set',
  basePath: TWEMOJI_BASE_URL,
  format: 'svg',
  categories: EMOJI_CATEGORIES.map(cat => ({
    id: cat.id,
    name: cat.name,
    icon: cat.icon,
    order: cat.order
  })),
  emojis: [], // Loaded from unicode-emoji-data.json
  isBuiltIn: false,
  previewImage: `${TWEMOJI_BASE_URL}/1f600.svg`,
  probePath: '1f600.svg',
}

// Native Unicode emoji pack (built-in)
const nativeUnicodePack: EmojiPack = {
  id: 'native',
  name: 'System',
  description: 'System default Unicode emojis',
  basePath: '',
  format: 'svg',
  categories: EMOJI_CATEGORIES.map(cat => ({
    id: cat.id,
    name: cat.name,
    icon: cat.icon,
    order: cat.order
  })),
  emojis: [], // Native emojis are handled differently (rendered as text)
  isBuiltIn: true
}

/**
 * Load emoji pack preference from localStorage
 */
function loadPackPreference(): void {
  try {
    let stored = userStorage.getItem(STORAGE_KEY)

    // One-time migration off the old un-namespaced raw key.
    if (!stored) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
      if (legacy) {
        stored = legacy
        userStorage.setItem(STORAGE_KEY, legacy)
        localStorage.removeItem(LEGACY_STORAGE_KEY)
      }
    }

    if (stored && availablePacks.value.has(stored)) {
      currentPackId.value = stored
    }
  } catch (error) {
    debug.error('Failed to load emoji pack preference:', error)
  }
}

/**
 * Save emoji pack preference to localStorage
 */
function savePackPreference(): void {
  try {
    userStorage.setItem(STORAGE_KEY, currentPackId.value)
  } catch (error) {
    debug.error('Failed to save emoji pack preference:', error)
  }
}

/**
 * Synchronous initialization: register the built-in packs (twemoji, native).
 */
export function initializeEmojiPacks(): void {
  if (isInitialized.value) return

  availablePacks.value.set('twemoji', twemojiPack)
  availablePacks.value.set('native', nativeUnicodePack)

  isInitialized.value = true
  debug.log('Emoji packs initialized.')
}

/**
 * Initialize packs and apply the user's saved preference, falling back to the
 * default pack when the stored selection is no longer available.
 *
 * Runs before the app mounts. Kept async so a future custom-pack feature can
 * probe operator-supplied packs here.
 */
export async function detectAvailablePacks(): Promise<void> {
  initializeEmojiPacks()

  loadPackPreference()

  if (!availablePacks.value.has(currentPackId.value)) {
    const fallback = availablePacks.value.has(DEFAULT_PACK_ID)
      ? DEFAULT_PACK_ID
      : (availablePacks.value.keys().next().value as string)
    debug.warn(
      `📦 Selected emoji pack "${currentPackId.value}" not available; falling back to "${fallback}"`,
    )
    currentPackId.value = fallback
    savePackPreference()
  }

  packsDetected.value = true
  debug.log('Emoji pack detection complete. Current pack:', currentPackId.value)
}

/**
 * Whether a pack's assets are installed on this instance (post-probe).
 */
export function isEmojiPackAvailable(packId: string): boolean {
  initializeEmojiPacks()
  return availablePacks.value.has(packId)
}

/**
 * Get the current emoji pack
 */
export function getCurrentPack(): EmojiPack {
  initializeEmojiPacks()
  return availablePacks.value.get(currentPackId.value) || twemojiPack
}

/**
 * Get all available emoji packs
 */
export function getAvailablePacks(): EmojiPack[] {
  initializeEmojiPacks()
  return Array.from(availablePacks.value.values())
}

/**
 * Set the current emoji pack
 */
export function setCurrentPack(packId: string): boolean {
  initializeEmojiPacks()
  
  if (!availablePacks.value.has(packId)) {
    debug.warn('Emoji pack not found:', packId)
    return false
  }
  
  currentPackId.value = packId
  savePackPreference()
  debug.log('Switched to emoji pack:', packId)

  return true
}

/**
 * Register a custom emoji pack
 */
export function registerEmojiPack(pack: EmojiPack): void {
  initializeEmojiPacks()
  availablePacks.value.set(pack.id, pack)
  debug.log('Registered emoji pack:', pack.name)
}

/**
 * Load emoji index for a pack (fetches the pre-generated JSON)
 */
export async function loadPackEmojiIndex(packId: string): Promise<EmojiPackItem[]> {
  initializeEmojiPacks()
  
  const pack = availablePacks.value.get(packId)
  if (!pack || pack.isBuiltIn) {
    return []
  }
  
  try {
    // Try to load the pre-generated index
    const indexPath = `${pack.basePath}/emoji-index.json`
    const response = await fetch(indexPath)
    
    if (!response.ok) {
      debug.warn('Emoji index not found:', indexPath)
      return []
    }
    
    const emojis = await response.json()
    
    pack.emojis = emojis
    
    debug.log(`Loaded ${emojis.length} emojis for pack:`, packId)
    return emojis
  } catch (error) {
    debug.error('Failed to load emoji index:', error)
    return []
  }
}

/**
 * Get emoji URL for a pack item
 */
export function getEmojiPackUrl(emoji: EmojiPackItem, pack?: EmojiPack): string {
  const currentPack = pack || getCurrentPack()
  if (currentPack.isBuiltIn) {
    return '' // Native emojis don't use URLs
  }
  return `${currentPack.basePath}/${emoji.path}`
}

/**
 * Search emojis across the current pack
 */
export function searchPackEmojis(query: string): EmojiPackItem[] {
  const pack = getCurrentPack()
  if (!pack.emojis.length) return []
  
  const lowerQuery = query.toLowerCase()
  return pack.emojis.filter(emoji => 
    emoji.name.toLowerCase().includes(lowerQuery) ||
    emoji.category.toLowerCase().includes(lowerQuery) ||
    emoji.keywords?.some(kw => kw.toLowerCase().includes(lowerQuery))
  ).slice(0, 50) // Limit results
}

/**
 * Get emojis by category
 */
export function getEmojisByCategory(categoryId: string): EmojiPackItem[] {
  const pack = getCurrentPack()
  return pack.emojis.filter(emoji => emoji.category === categoryId)
}

/**
 * Composable for emoji packs
 */
export { currentPackId }

export function useEmojiPacks() {
  initializeEmojiPacks()
  
  const currentPack = computed(() => getCurrentPack())
  const packs = computed(() => getAvailablePacks())
  const isNativePack = computed(() => currentPackId.value === 'native')
  const isTwemojiPack = computed(() => currentPackId.value === 'twemoji')
  
  return {
    currentPackId,
    currentPack,
    packs,
    isNativePack,
    isTwemojiPack,
    
    setCurrentPack,
    loadPackEmojiIndex,
    getEmojiPackUrl,
    searchPackEmojis,
    getEmojisByCategory,
    registerEmojiPack
  }
}
