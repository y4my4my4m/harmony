/**
 * Unified Emoji Service
 * 
 * A professional, DRY emoji system that:
 * - Stores reactions as standard unicode (portable across packs)
 * - Renders emojis based on user's selected pack (native or Mutant SVG)
 * - Provides lookup between shortcode ↔ unicode ↔ SVG path
 * - Works seamlessly when switching emoji packs
 */

import { ref, computed } from 'vue'
import { debug } from '@/utils/debug'

// Types
export interface EmojiLookups {
  shortcodeToUnicode: Record<string, string>
  unicodeToShortcode: Record<string, string>
  shortcodeToSvg: Record<string, string>
  svgBasePath: string
}

export interface EmojiEntry {
  shortcode: string
  unicode: string
  codepoints: number[]
  description: string
  category: string
  subcategory?: string
  svgPath: string
  keywords: string[]
}

export interface EmojiCategory {
  id: string
  name: string
  count: number
  subcategories: string[]
}

export interface EmojiData {
  version: string
  pack: string
  totalCount: number
  categories: EmojiCategory[]
  emojis: EmojiEntry[]
  lookups: EmojiLookups
}

export type EmojiPack = 'native' | 'mutant'

// State
const PACK_STORAGE_KEY = 'harmony-emoji-pack'
const currentPack = ref<EmojiPack>('mutant')  // Default to mutant
const emojiData = ref<EmojiData | null>(null)
const lookups = ref<EmojiLookups | null>(null)
const isLoaded = ref(false)
const isLoading = ref(false)

/**
 * Load the emoji data and lookups
 */
async function loadEmojiData(): Promise<void> {
  if (isLoaded.value || isLoading.value) return
  
  isLoading.value = true
  try {
    // Load full emoji data
    const dataResponse = await fetch('/assets/emojis/emoji-data.json')
    if (dataResponse.ok) {
      emojiData.value = await dataResponse.json()
      lookups.value = emojiData.value?.lookups || null
      debug.log(`📦 Loaded emoji data: ${emojiData.value?.totalCount} emojis`)
    } else {
      // Fallback to just lookups
      const lookupsResponse = await fetch('/assets/emojis/emoji-lookups.json')
      if (lookupsResponse.ok) {
        lookups.value = await lookupsResponse.json()
        debug.log('📦 Loaded emoji lookups (fallback)')
      }
    }
    
    isLoaded.value = true
  } catch (error) {
    debug.error('Failed to load emoji data:', error)
  } finally {
    isLoading.value = false
  }
}

/**
 * Load user's emoji pack preference
 */
function loadPackPreference(): void {
  try {
    const stored = localStorage.getItem(PACK_STORAGE_KEY)
    if (stored === 'native' || stored === 'mutant') {
      currentPack.value = stored
    }
  } catch (error) {
    debug.error('Failed to load emoji pack preference:', error)
  }
}

/**
 * Save user's emoji pack preference
 */
function savePackPreference(): void {
  try {
    localStorage.setItem(PACK_STORAGE_KEY, currentPack.value)
  } catch (error) {
    debug.error('Failed to save emoji pack preference:', error)
  }
}

/**
 * Set the current emoji pack
 */
function setEmojiPack(pack: EmojiPack): void {
  currentPack.value = pack
  savePackPreference()
  debug.log(`📦 Switched to emoji pack: ${pack}`)
}

// ==============================================
// CONVERSION UTILITIES
// ==============================================

/**
 * Convert shortcode to unicode emoji
 * e.g., "joy" → "😂"
 * Case insensitive lookup
 */
function shortcodeToUnicode(shortcode: string): string | null {
  if (!lookups.value) return null
  // Try exact match first, then lowercase
  return lookups.value.shortcodeToUnicode[shortcode] || 
         lookups.value.shortcodeToUnicode[shortcode.toLowerCase()] || 
         null
}

/**
 * Convert unicode emoji to shortcode
 * e.g., "😂" → "joy"
 */
function unicodeToShortcode(unicode: string): string | null {
  if (!lookups.value) return null
  return lookups.value.unicodeToShortcode[unicode] || null
}

/**
 * Get SVG path for a shortcode
 * e.g., "joy" → "expressions/smileys/typical/joy.svg"
 * Case insensitive lookup
 */
function shortcodeToSvgPath(shortcode: string): string | null {
  if (!lookups.value) return null
  // Try exact match first, then lowercase
  return lookups.value.shortcodeToSvg[shortcode] || 
         lookups.value.shortcodeToSvg[shortcode.toLowerCase()] || 
         null
}

// Default base path for emoji SVGs
const DEFAULT_SVG_BASE_PATH = '/assets/emojis/mutant_emojis_svg'

/**
 * Get full SVG URL for a shortcode
 */
function getSvgUrl(shortcode: string): string | null {
  const path = shortcodeToSvgPath(shortcode)
  if (!path) return null
  const basePath = lookups.value?.svgBasePath || DEFAULT_SVG_BASE_PATH
  return `${basePath}/${path}`
}

/**
 * Get SVG URL from unicode emoji
 */
function unicodeToSvgUrl(unicode: string): string | null {
  const shortcode = unicodeToShortcode(unicode)
  if (!shortcode) return null
  return getSvgUrl(shortcode)
}

// ==============================================
// EMOJI RESOLUTION (for display)
// ==============================================

export interface ResolvedEmoji {
  unicode: string          // The actual unicode character (always stored)
  shortcode: string | null // Shortcode if known
  display: {
    type: 'native' | 'svg'
    content: string        // Unicode char for native, URL for svg
  }
}

/**
 * Resolve an emoji for display based on current pack
 * Input can be: unicode emoji, shortcode, or legacy "mutant:path" format
 */
function resolveEmoji(input: string): ResolvedEmoji {
  // Handle legacy "mutant:path" format
  if (input.startsWith('mutant:')) {
    const path = input.replace('mutant:', '')
    // Try to find unicode from path
    const filename = path.split('/').pop()?.replace('.svg', '') || ''
    // Extract shortcode from filename (e.g., "1f602_joy" → "joy")
    const shortcode = filename.includes('_') 
      ? filename.split('_').slice(1).join('_')
      : filename
    
    const unicode = shortcodeToUnicode(shortcode)
    
    const basePath = lookups.value?.svgBasePath || DEFAULT_SVG_BASE_PATH
    return {
      unicode: unicode || input,
      shortcode,
      display: currentPack.value === 'native' && unicode
        ? { type: 'native', content: unicode }
        : { type: 'svg', content: `${basePath}/${path}` }
    }
  }
  
  // Check if input is a shortcode (no emoji characters)
  const isShortcode = /^[a-z0-9_]+$/i.test(input)
  
  if (isShortcode) {
    const unicode = shortcodeToUnicode(input)
    const svgUrl = getSvgUrl(input)
    
    // If we have a shortcode but no unicode/SVG, try to construct a path
    // This handles cases where emoji data isn't fully loaded yet
    let fallbackSvgUrl: string | null = null
    if (!unicode && !svgUrl && lookups.value?.shortcodeToSvg) {
      // Try lowercase
      const lowercaseKey = Object.keys(lookups.value.shortcodeToSvg)
        .find(k => k.toLowerCase() === input.toLowerCase())
      if (lowercaseKey) {
        fallbackSvgUrl = `${DEFAULT_SVG_BASE_PATH}/${lookups.value.shortcodeToSvg[lowercaseKey]}`
      }
    }
    
    return {
      unicode: unicode || input,
      shortcode: input,
      display: currentPack.value === 'native' && unicode
        ? { type: 'native', content: unicode }
        : svgUrl || fallbackSvgUrl
          ? { type: 'svg', content: svgUrl || fallbackSvgUrl! }
          : { type: 'native', content: unicode || input }  // Show shortcode instead of [shortcode]
    }
  }
  
  // Input is unicode emoji
  const shortcode = unicodeToShortcode(input)
  const svgUrl = shortcode ? getSvgUrl(shortcode) : null
  
  return {
    unicode: input,
    shortcode,
    display: currentPack.value === 'native'
      ? { type: 'native', content: input }
      : svgUrl 
        ? { type: 'svg', content: svgUrl }
        : { type: 'native', content: input }  // Fallback to native if no SVG
  }
}

/**
 * Normalize emoji input to unicode for storage
 * This ensures reactions are stored as standard unicode
 */
function normalizeToUnicode(input: string): string {
  // Handle legacy "mutant:path" format
  if (input.startsWith('mutant:')) {
    const path = input.replace('mutant:', '')
    const filename = path.split('/').pop()?.replace('.svg', '') || ''
    const shortcode = filename.includes('_') 
      ? filename.split('_').slice(1).join('_')
      : filename
    return shortcodeToUnicode(shortcode) || input
  }
  
  // Check if it's a shortcode
  const isShortcode = /^[a-z0-9_]+$/i.test(input)
  if (isShortcode) {
    return shortcodeToUnicode(input) || input
  }
  
  // Already unicode
  return input
}

// ==============================================
// SEARCH
// ==============================================

/**
 * Search emojis by query
 */
function searchEmojis(query: string, limit: number = 50): EmojiEntry[] {
  if (!emojiData.value || !query) return []
  
  const lowerQuery = query.toLowerCase()
  
  return emojiData.value.emojis
    .filter(emoji => 
      emoji.shortcode.toLowerCase().includes(lowerQuery) ||
      emoji.description.toLowerCase().includes(lowerQuery) ||
      emoji.keywords.some(kw => kw.includes(lowerQuery))
    )
    .slice(0, limit)
}

/**
 * Get emojis by category
 */
function getEmojisByCategory(categoryId: string): EmojiEntry[] {
  if (!emojiData.value) return []
  return emojiData.value.emojis.filter(e => e.category === categoryId)
}

/**
 * Get all categories
 */
function getCategories(): EmojiCategory[] {
  return emojiData.value?.categories || []
}

/**
 * Get all emojis
 */
function getAllEmojis(): EmojiEntry[] {
  return emojiData.value?.emojis || []
}

// ==============================================
// COMPOSABLE
// ==============================================

/**
 * Unified emoji composable
 */
export function useUnifiedEmoji() {
  // Initialize on first use
  loadPackPreference()
  loadEmojiData()
  
  const isNativePack = computed(() => currentPack.value === 'native')
  const isMutantPack = computed(() => currentPack.value === 'mutant')
  
  return {
    // State
    currentPack,
    isNativePack,
    isMutantPack,
    isLoaded,
    isLoading,
    emojiData,
    
    // Pack management
    setEmojiPack,
    
    // Conversions
    shortcodeToUnicode,
    unicodeToShortcode,
    shortcodeToSvgPath,
    getSvgUrl,
    unicodeToSvgUrl,
    
    // Resolution
    resolveEmoji,
    normalizeToUnicode,
    
    // Data access
    searchEmojis,
    getEmojisByCategory,
    getCategories,
    getAllEmojis,
    
    // Reload
    reload: loadEmojiData
  }
}

// Export singleton functions for use outside Vue components
export {
  loadEmojiData,
  setEmojiPack,
  shortcodeToUnicode,
  unicodeToShortcode,
  shortcodeToSvgPath,
  getSvgUrl,
  unicodeToSvgUrl,
  resolveEmoji,
  normalizeToUnicode,
  searchEmojis,
  getEmojisByCategory,
  getCategories,
  getAllEmojis,
  currentPack,
  isLoaded
}

