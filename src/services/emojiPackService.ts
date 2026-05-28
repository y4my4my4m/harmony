/**
 * Emoji Pack Service
 * 
 * Manages swappable emoji packs:
 * - Twemoji (default) - Twitter's open source emojis
 * - Mutant Standard - Expressive custom emoji set
 * - Native Unicode - System default emojis
 * 
 * Allows users to switch between different emoji styles.
 */

import { ref, computed } from 'vue'
import { debug } from '@/utils/debug'
import { 
  EMOJI_CATEGORIES, 
  TWEMOJI_BASE_URL, 
  MUTANT_BASE_URL,
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

const STORAGE_KEY = 'harmony-emoji-pack'
const DEFAULT_PACK_ID: EmojiPackType = DEFAULT_EMOJI_PACK

// Available emoji packs
const availablePacks = ref<Map<string, EmojiPack>>(new Map())
const currentPackId = ref<string>(DEFAULT_PACK_ID)
const isInitialized = ref(false)

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

// Mutant Standard emoji pack definition
const mutantStandardPack: EmojiPack = {
  id: 'mutant',
  name: 'Mutant Standard',
  description: 'Expressive and unique emoji set',
  basePath: MUTANT_BASE_URL,
  format: 'svg',
  categories: [
    { id: 'expressions', name: 'Expressions', icon: '😀', order: 0, subcategories: ['smileys', 'body_parts', 'semi_body'] },
    { id: 'food_drink_herbs', name: 'Food & Drink', icon: '🍕', order: 1, subcategories: ['food', 'drink', 'fruit_veg', 'alcohol_herbs'] },
    { id: 'activities_clothing', name: 'Activities', icon: '🏀', order: 2, subcategories: ['sports', 'clothing', 'performing_arts', 'roles'] },
    { id: 'nature_effects', name: 'Nature', icon: '🌿', order: 3, subcategories: ['plants', 'weather', 'earth', 'effects', 'moon'] },
    { id: 'objects', name: 'Objects', icon: '🔧', order: 4, subcategories: ['tech', 'household', 'office_stationery', 'games', 'party'] },
    { id: 'symbols', name: 'Symbols', icon: '❤️', order: 5, subcategories: ['hearts', 'arrows', 'shapes', 'misc'] },
    { id: 'travel_places', name: 'Travel', icon: '✈️', order: 6, subcategories: ['air', 'road', 'trains', 'buildings', 'scenes'] },
    { id: 'people_animals', name: 'Creatures', icon: '🐱', order: 7, subcategories: ['creatures', 'aspects'] },
    { id: 'extra', name: 'Extra', icon: '✨', order: 8, subcategories: ['cyber', 'occult_magic', 'weapons', 'symbols'] },
  ],
  emojis: [], // Will be populated by the index generator
  isBuiltIn: false,
  previewImage: `${MUTANT_BASE_URL}/expressions/smileys/typical/grinning.svg`,
  probePath: 'expressions/smileys/typical/grinning.svg',
}

/**
 * Directories/patterns to exclude from Mutant Standard (per user request)
 */
export const MUTANT_EXCLUDED_PATHS = [
  'gender_sexuality_relationships', // Exclude trans/furry flags and symbols
  'expressions/hands/paw',          // Exclude furry hand variants
  'expressions/hands/hoof',         // Exclude furry hand variants
  'expressions/hands/clw',          // Exclude furry claw variants
]

/**
 * Check if a path should be excluded from the emoji pack
 */
export function shouldExcludePath(path: string): boolean {
  return MUTANT_EXCLUDED_PATHS.some(excluded => path.includes(excluded))
}

/**
 * Load emoji pack preference from localStorage
 */
function loadPackPreference(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
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
    localStorage.setItem(STORAGE_KEY, currentPackId.value)
  } catch (error) {
    debug.error('Failed to save emoji pack preference:', error)
  }
}

/**
 * Synchronous initialization: register all known packs optimistically.
 *
 * The picker UI may render before `detectAvailablePacks()` has finished,
 * so we register every pack here. `detectAvailablePacks()` will then prune
 * any pack whose probe asset returns 404 - useful when an instance ships
 * without an optional pack like Mutant Standard.
 */
export function initializeEmojiPacks(): void {
  if (isInitialized.value) return

  // Register all candidate packs (order matters for UI display).
  availablePacks.value.set('twemoji', twemojiPack)
  availablePacks.value.set('mutant', mutantStandardPack)
  availablePacks.value.set('native', nativeUnicodePack)

  loadPackPreference()

  isInitialized.value = true
  debug.log('📦 Emoji packs initialized. Current pack:', currentPackId.value)
}

/**
 * Probe each registered pack to confirm its assets are actually served by
 * this instance. Removes packs whose `probePath` 404s. If the user's
 * currently-selected pack disappears, falls back to the default pack.
 *
 * Call this once on app startup (after `initializeEmojiPacks`).
 */
export async function detectAvailablePacks(): Promise<void> {
  initializeEmojiPacks()

  const checks = Array.from(availablePacks.value.values()).map(async (pack) => {
    if (pack.isBuiltIn || !pack.probePath) return { pack, ok: true }
    try {
      const url = `${pack.basePath}/${pack.probePath}`
      const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' })
      return { pack, ok: res.ok }
    } catch (err) {
      debug.warn(`Emoji pack probe failed for "${pack.id}":`, err)
      return { pack, ok: false }
    }
  })

  const results = await Promise.all(checks)
  for (const { pack, ok } of results) {
    if (!ok) {
      availablePacks.value.delete(pack.id)
      debug.log(`📦 Emoji pack not installed on this instance, hiding: ${pack.id}`)
    }
  }

  // If the previously-selected pack is no longer available, fall back.
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
  debug.log('📦 Switched to emoji pack:', packId)
  return true
}

/**
 * Register a custom emoji pack
 */
export function registerEmojiPack(pack: EmojiPack): void {
  initializeEmojiPacks()
  availablePacks.value.set(pack.id, pack)
  debug.log('📦 Registered emoji pack:', pack.name)
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
    
    // Update the pack with loaded emojis
    pack.emojis = emojis
    
    debug.log(`📦 Loaded ${emojis.length} emojis for pack:`, packId)
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
export function useEmojiPacks() {
  initializeEmojiPacks()
  
  const currentPack = computed(() => getCurrentPack())
  const packs = computed(() => getAvailablePacks())
  const isNativePack = computed(() => currentPackId.value === 'native')
  const isTwemojiPack = computed(() => currentPackId.value === 'twemoji')
  const isMutantPack = computed(() => currentPackId.value === 'mutant')
  
  return {
    // State
    currentPackId,
    currentPack,
    packs,
    isNativePack,
    isTwemojiPack,
    isMutantPack,
    
    // Methods
    setCurrentPack,
    loadPackEmojiIndex,
    getEmojiPackUrl,
    searchPackEmojis,
    getEmojisByCategory,
    registerEmojiPack
  }
}
