/**
 * Unified Emoji Service
 * 
 * A professional, DRY emoji system that:
 * - Stores reactions as standard unicode (portable across packs)
 * - Renders emojis based on user's selected pack (twemoji, mutant, or native)
 * - Provides lookup between shortcode ↔ unicode ↔ codepoint
 * - Works seamlessly when switching emoji packs
 * 
 * Data source: unicode-emoji-data.json (single source of truth)
 */

import { ref, computed } from 'vue'
import { debug } from '@/utils/debug'
import { 
  TWEMOJI_BASE_URL, 
  MUTANT_BASE_URL,
  DEFAULT_EMOJI_PACK,
  EMOJI_CATEGORIES,
  type EmojiPack 
} from '@/utils/emojiConstants'
import {
  getCachedStaticEmojiData,
  setCachedStaticEmojiData,
} from '@/services/emojiIndexedDBCache'

// Re-export type for convenience
export type { EmojiPack } from '@/utils/emojiConstants'

// Types
export interface EmojiLookups {
  shortcodeToUnicode: Record<string, string>
  unicodeToShortcode: Record<string, string>
  unicodeToCodepoint: Record<string, string>
  // Legacy support for mutant pack
  shortcodeToSvg?: Record<string, string>
  svgBasePath?: string
}

export interface EmojiEntry {
  unicode: string
  shortcode: string
  name: string
  category: string
  codepoint: string
  keywords: string[]
  skinToneSupport?: boolean
  // Legacy mutant fields
  svgPath?: string
  description?: string
  subcategory?: string
  codepoints?: number[]
}

export interface EmojiCategory {
  id: string
  name: string
  icon: string
  order: number
  count: number
}

export interface EmojiData {
  version: string
  source?: string
  pack?: string
  totalCount: number
  categories: EmojiCategory[]
  emojis: EmojiEntry[]
  lookups: EmojiLookups
}

// State
const PACK_STORAGE_KEY = 'harmony-emoji-pack'
const currentPack = ref<EmojiPack>(DEFAULT_EMOJI_PACK)
const emojiData = ref<EmojiData | null>(null)
const lookups = ref<EmojiLookups | null>(null)
const isLoaded = ref(false)
const isLoading = ref(false)

// Cache for mutant lookups (loaded separately when needed)
const mutantLookups = ref<EmojiLookups | null>(null)

// Twemoji file map for accurate SVG path resolution
const twemojiFileMap = ref<Record<string, boolean> | null>(null)

// Cache version - bump this when the static JSON files change to bust the IndexedDB cache.
//
// v2 (2026-05-21): `unicode-emoji-data.json` was regenerated on 2026-05-20 to
// include keyword aliases (`+1`, `thumbsup`, etc.). Users whose IndexedDB
// still holds the v1 blob would not see `:+1` resolve to thumbs_up in
// autosuggest or in the emoji-picker search, because the keyword check
// can't match a field that isn't in the cached payload. Bumping forces a
// one-time refetch the next time the emoji loader runs.
//
// v3 (2026-05-25): The data was regenerated to merge ~884 GitHub/Discord-style
// shortcode aliases (from `gemoji`) directly into `shortcodeToUnicode`. This
// is what makes `:joy:`, `:heart:`, `:thumbsup:`, etc. resolve as standalone
// shortcodes (not just keyword fuzzy-matches inside the picker). Without
// bumping, users still see the v2 blob where only the picker's keyword
// search could find these aliases.
const EMOJI_DATA_CACHE_VERSION = '3'

/**
 * Load the unified emoji data.
 * Tries IndexedDB first for instant hydration, then falls back to network fetch.
 */
async function loadEmojiData(): Promise<void> {
  if (isLoaded.value || isLoading.value) return
  
  isLoading.value = true
  try {
    // --- Try IndexedDB cache first (instant, no network) ---
    let loadedFromCache = false
    try {
      const [cachedData, cachedFileMap] = await Promise.all([
        getCachedStaticEmojiData<EmojiData>('unicode-emoji-data', EMOJI_DATA_CACHE_VERSION),
        getCachedStaticEmojiData<Record<string, boolean>>('twemoji-file-map', EMOJI_DATA_CACHE_VERSION),
      ])

      if (cachedData) {
        emojiData.value = cachedData
        lookups.value = cachedData.lookups || null
        loadedFromCache = true
        debug.log(`⚡ Loaded emoji data from IndexedDB cache: ${cachedData.totalCount} emojis`)
      }

      if (cachedFileMap) {
        twemojiFileMap.value = cachedFileMap
        if (loadedFromCache) {
          debug.log(`⚡ Loaded Twemoji file map from IndexedDB cache`)
        }
      }
    } catch (e) {
      debug.warn('IndexedDB emoji cache read failed, falling back to network:', e)
    }

    if (loadedFromCache && twemojiFileMap.value) {
      isLoaded.value = true
      return
    }

    // --- Fetch from network and populate IndexedDB cache ---
    if (!emojiData.value) {
      const dataResponse = await fetch('/assets/emojis/unicode-emoji-data.json')
      if (dataResponse.ok) {
        emojiData.value = await dataResponse.json()
        lookups.value = emojiData.value?.lookups || null
        debug.log(`📦 Loaded unified emoji data: ${emojiData.value?.totalCount} emojis`)
        setCachedStaticEmojiData('unicode-emoji-data', emojiData.value, EMOJI_DATA_CACHE_VERSION)
      } else {
        debug.warn('⚠️ unicode-emoji-data.json not found, trying legacy fallback...')
        const legacyResponse = await fetch('/assets/emojis/emoji-data.json')
        if (legacyResponse.ok) {
          emojiData.value = await legacyResponse.json()
          lookups.value = emojiData.value?.lookups || null
          debug.log(`📦 Loaded legacy emoji data: ${emojiData.value?.totalCount} emojis`)
          setCachedStaticEmojiData('unicode-emoji-data', emojiData.value, EMOJI_DATA_CACHE_VERSION)
        }
      }
    }
    
    if (!twemojiFileMap.value) {
      try {
        const fileMapResponse = await fetch('/assets/emojis/twemoji-file-map.json')
        if (fileMapResponse.ok) {
          twemojiFileMap.value = await fileMapResponse.json()
          debug.log(`📦 Loaded Twemoji file map: ${Object.keys(twemojiFileMap.value || {}).length} entries`)
          setCachedStaticEmojiData('twemoji-file-map', twemojiFileMap.value, EMOJI_DATA_CACHE_VERSION)
        }
      } catch (e) {
        debug.warn('Could not load Twemoji file map, using fallback normalization')
      }
    }
    
    isLoaded.value = true

    // Re-resolve display name emojis now that shortcode lookups are available
    import('@/services/userDataService').then(({ userDataService }) => {
      userDataService.reResolveAllDisplayNames()
    }).catch(() => { /* userDataService not ready yet */ })
  } catch (error) {
    debug.error('Failed to load emoji data:', error)
  } finally {
    isLoading.value = false
  }
}

/**
 * Load mutant-specific lookups (for shortcode to SVG path mapping)
 */
async function loadMutantLookups(): Promise<void> {
  if (mutantLookups.value) return
  
  try {
    const cached = await getCachedStaticEmojiData<EmojiLookups>('mutant-lookups', EMOJI_DATA_CACHE_VERSION)
    if (cached) {
      mutantLookups.value = cached
      debug.log('⚡ Loaded mutant emoji lookups from IndexedDB cache')
      return
    }
  } catch (_) { /* fall through to network */ }

  try {
    const response = await fetch('/assets/emojis/emoji-lookups.json')
    if (response.ok) {
      mutantLookups.value = await response.json()
      debug.log('📦 Loaded mutant emoji lookups')
      setCachedStaticEmojiData('mutant-lookups', mutantLookups.value, EMOJI_DATA_CACHE_VERSION)
    }
  } catch (error) {
    debug.error('Failed to load mutant lookups:', error)
  }
}

/**
 * Load user's emoji pack preference
 */
function loadPackPreference(): void {
  try {
    const stored = localStorage.getItem(PACK_STORAGE_KEY)
    if (stored === 'native' || stored === 'mutant' || stored === 'twemoji') {
      currentPack.value = stored as EmojiPack
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
  
  // Preload mutant lookups if switching to mutant
  if (pack === 'mutant') {
    loadMutantLookups()
  }
}

// ==============================================
// CONVERSION UTILITIES
// ==============================================

/**
 * Convert shortcode to unicode emoji
 * e.g., "grinning_face" → "😀"
 * Case insensitive lookup
 */
function shortcodeToUnicode(shortcode: string): string | null {
  if (!lookups.value || shortcode == null || shortcode === '') return null
  // Try exact match first, then lowercase
  const key = String(shortcode)
  return lookups.value.shortcodeToUnicode[key] || 
         lookups.value.shortcodeToUnicode[key.toLowerCase()] || 
         null
}

/**
 * Convert unicode emoji to shortcode
 * e.g., "😀" → "grinning_face"
 */
function unicodeToShortcode(unicode: string): string | null {
  if (!lookups.value) return null
  return lookups.value.unicodeToShortcode[unicode] || null
}

/**
 * Convert unicode emoji to hex codepoint
 * e.g., "😀" → "1f600"
 */
function unicodeToCodepoint(unicode: string): string | null {
  if (!lookups.value) return null
  return lookups.value.unicodeToCodepoint?.[unicode] || null
}

/**
 * Get emoji codepoint from shortcode
 */
function shortcodeToCodepoint(shortcode: string): string | null {
  const unicode = shortcodeToUnicode(shortcode)
  if (!unicode) return null
  return unicodeToCodepoint(unicode)
}

/**
 * Find a Twemoji file by trying different fe0f variations
 * Returns the actual filename if found, or null
 */
function findTwemojiFile(codepoint: string): string | null {
  if (!twemojiFileMap.value) return null
  
  // Try exact match first
  if (twemojiFileMap.value[codepoint]) {
    return codepoint
  }
  
  const parts = codepoint.split('-')
  
  // Try without all fe0f
  const withoutFe0f = parts.filter(p => p !== 'fe0f').join('-')
  if (twemojiFileMap.value[withoutFe0f]) {
    return withoutFe0f
  }
  
  // Try with fe0f only after gender symbols
  const withGenderFe0f: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === 'fe0f') {
      const prev = parts[i - 1]
      if (prev === '2640' || prev === '2642' || prev === '27a1') {
        withGenderFe0f.push(part)
      }
    } else {
      withGenderFe0f.push(part)
    }
  }
  const genderVariant = withGenderFe0f.join('-')
  if (twemojiFileMap.value[genderVariant]) {
    return genderVariant
  }
  
  // Try with all fe0f at the end stripped
  if (parts[parts.length - 1] === 'fe0f') {
    const withoutTrailing = parts.slice(0, -1).join('-')
    if (twemojiFileMap.value[withoutTrailing]) {
      return withoutTrailing
    }
  }
  
  // Try with fe0f added after base emoji (for emojis like 26f9-fe0f-200d-...)
  if (parts.length >= 2 && parts[1] === '200d') {
    const withBaseFe0f = [parts[0], 'fe0f', ...parts.slice(1)].join('-')
    if (twemojiFileMap.value[withBaseFe0f]) {
      return withBaseFe0f
    }
  }
  
  return null
}

/**
 * Get Twemoji SVG URL from unicode emoji
 * Uses file map for accurate resolution, with fallback to heuristic normalization
 */
function getTwemojiUrl(unicode: string): string | null {
  // First try from lookups
  let codepoint = unicodeToCodepoint(unicode)
  
  if (!codepoint) {
    // Fallback: compute codepoint directly from unicode
    codepoint = unicodeToCodepointDirect(unicode)
  }
  
  if (!codepoint) return null
  
  // Try to find the exact file using the file map
  if (twemojiFileMap.value) {
    const found = findTwemojiFile(codepoint)
    if (found) {
      return `${TWEMOJI_BASE_URL}/${found}.svg`
    }
  }
  
  // Fallback: use heuristic normalization (strip most fe0f except after gender symbols)
  const parts = codepoint.split('-')
  const normalized: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === 'fe0f') {
      const prev = parts[i - 1]
      // Keep fe0f after gender/directional symbols
      if (prev === '2640' || prev === '2642' || prev === '27a1') {
        normalized.push(part)
      }
    } else {
      normalized.push(part)
    }
  }
  
  return `${TWEMOJI_BASE_URL}/${normalized.join('-')}.svg`
}

/**
 * Convert unicode directly to codepoint (without lookup)
 * Used as fallback when lookups aren't loaded
 */
function unicodeToCodepointDirect(unicode: string): string | null {
  if (!unicode) return null
  const codepoints: string[] = []
  for (const char of unicode) {
    const cp = char.codePointAt(0)
    if (cp !== undefined) {
      codepoints.push(cp.toString(16).toLowerCase())
    }
  }
  return codepoints.length > 0 ? codepoints.join('-') : null
}

/**
 * Get Mutant SVG URL from shortcode
 * Legacy support for mutant pack
 */
function getMutantSvgUrl(shortcode: string): string | null {
  // First try mutant-specific lookups
  if (mutantLookups.value?.shortcodeToSvg) {
    const path = mutantLookups.value.shortcodeToSvg[shortcode] ||
                 mutantLookups.value.shortcodeToSvg[shortcode.toLowerCase()]
    if (path) {
      return `${MUTANT_BASE_URL}/${path}`
    }
  }
  
  // Fallback to main lookups (for legacy data)
  if (lookups.value?.shortcodeToSvg) {
    const path = lookups.value.shortcodeToSvg[shortcode] ||
                 lookups.value.shortcodeToSvg[shortcode.toLowerCase()]
    if (path) {
      return `${MUTANT_BASE_URL}/${path}`
    }
  }
  
  return null
}

/**
 * Get SVG path for a shortcode (legacy compatibility)
 */
function shortcodeToSvgPath(shortcode: string): string | null {
  if (mutantLookups.value?.shortcodeToSvg) {
    return mutantLookups.value.shortcodeToSvg[shortcode] || 
           mutantLookups.value.shortcodeToSvg[shortcode.toLowerCase()] || 
           null
  }
  if (lookups.value?.shortcodeToSvg) {
    return lookups.value.shortcodeToSvg[shortcode] || 
           lookups.value.shortcodeToSvg[shortcode.toLowerCase()] || 
           null
  }
  return null
}

/**
 * Get full SVG URL for a shortcode (legacy compatibility)
 */
function getSvgUrl(shortcode: string): string | null {
  // For twemoji, convert shortcode to unicode first, then get twemoji URL
  if (currentPack.value === 'twemoji') {
    const unicode = shortcodeToUnicode(shortcode)
    if (unicode) {
      return getTwemojiUrl(unicode)
    }
  }
  
  // For mutant pack
  return getMutantSvgUrl(shortcode)
}

/**
 * Get SVG URL from unicode emoji
 */
function unicodeToSvgUrl(unicode: string): string | null {
  if (currentPack.value === 'twemoji') {
    return getTwemojiUrl(unicode)
  }
  
  // For mutant pack
  const shortcode = unicodeToShortcode(unicode)
  if (!shortcode) return null
  return getMutantSvgUrl(shortcode)
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
/**
 * Resolve emoji from input (unicode, shortcode, or name)
 * LAZY: Triggers background load if not already loaded (non-blocking)
 */
function resolveEmoji(input: string): ResolvedEmoji {
  // OPTIMIZED: Don't auto-trigger lazy load here - let callers decide when to load
  // This prevents 823KB from loading during initial message rendering
  // Emoji data should only load when:
  // - User opens emoji picker
  // - User searches for emojis
  // - Component explicitly needs emoji resolution (and checks isLoaded first)
  // If data not loaded, this will return a basic resolution (native unicode)
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
    
    // Return based on current pack
    if (currentPack.value === 'native' && unicode) {
      return {
        unicode: unicode || input,
        shortcode,
        display: { type: 'native', content: unicode }
      }
    }
    
    if (currentPack.value === 'twemoji' && unicode) {
      const twemojiUrl = getTwemojiUrl(unicode)
      if (twemojiUrl) {
        return {
          unicode,
          shortcode,
          display: { type: 'svg', content: twemojiUrl }
        }
      }
    }
    
    // Fallback to mutant SVG
    return {
      unicode: unicode || input,
      shortcode,
      display: { type: 'svg', content: `${MUTANT_BASE_URL}/${path}` }
    }
  }
  
  // Check if input is a shortcode (no emoji characters)
  const isShortcode = /^[a-z0-9_+-]+$/i.test(input)
  
  if (isShortcode) {
    const unicode = shortcodeToUnicode(input)
    
    // Native pack
    if (currentPack.value === 'native') {
      return {
        unicode: unicode || input,
        shortcode: input,
        display: unicode 
          ? { type: 'native', content: unicode }
          : { type: 'native', content: input }
      }
    }
    
    // Twemoji pack
    if (currentPack.value === 'twemoji' && unicode) {
      const twemojiUrl = getTwemojiUrl(unicode)
      if (twemojiUrl) {
        return {
          unicode,
          shortcode: input,
          display: { type: 'svg', content: twemojiUrl }
        }
      }
    }
    
    // Mutant pack or fallback
    const mutantUrl = getMutantSvgUrl(input)
    if (mutantUrl) {
      return {
        unicode: unicode || input,
        shortcode: input,
        display: { type: 'svg', content: mutantUrl }
      }
    }
    
    // Ultimate fallback to native
    return {
      unicode: unicode || input,
      shortcode: input,
      display: { type: 'native', content: unicode || input }
    }
  }
  
  // Input is unicode emoji
  const shortcode = unicodeToShortcode(input)
  
  // Native pack
  if (currentPack.value === 'native') {
    return {
      unicode: input,
      shortcode,
      display: { type: 'native', content: input }
    }
  }
  
  // Twemoji pack
  if (currentPack.value === 'twemoji') {
    const twemojiUrl = getTwemojiUrl(input)
    if (twemojiUrl) {
      return {
        unicode: input,
        shortcode,
        display: { type: 'svg', content: twemojiUrl }
      }
    }
  }
  
  // Mutant pack
  if (shortcode) {
    const mutantUrl = getMutantSvgUrl(shortcode)
    if (mutantUrl) {
      return {
        unicode: input,
        shortcode,
        display: { type: 'svg', content: mutantUrl }
      }
    }
  }
  
  // Fallback to native
  return {
    unicode: input,
    shortcode,
    display: { type: 'native', content: input }
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
  const isShortcode = /^[a-z0-9_+-]+$/i.test(input)
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
 * LAZY: Triggers background load if not already loaded
 */
function searchEmojis(query: string, limit: number = 50): EmojiEntry[] {
  // Lazy load emoji data in background if not loaded (non-blocking)
  if (!isLoaded.value && !isLoading.value) {
    loadEmojiData().catch(err => {
      debug.warn('Failed to lazy load emoji data:', err)
    })
  }
  
  if (!emojiData.value || !query) return []
  
  const lowerQuery = query.toLowerCase()
  
  return emojiData.value.emojis
    .filter(emoji => 
      (emoji.shortcode ?? '').toLowerCase().includes(lowerQuery) ||
      (emoji.name && emoji.name.toLowerCase().includes(lowerQuery)) ||
      (emoji.description && emoji.description.toLowerCase().includes(lowerQuery)) ||
      emoji.keywords?.some(kw => kw.toLowerCase().includes(lowerQuery))
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
 * Get all categories (sorted by order)
 */
function getCategories(): EmojiCategory[] {
  if (!emojiData.value?.categories) return EMOJI_CATEGORIES as unknown as EmojiCategory[]
  return [...emojiData.value.categories].sort((a, b) => (a.order || 0) - (b.order || 0))
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
 * LAZY: Only loads emoji data when actually needed (emoji picker, search, etc.)
 */
export function useUnifiedEmoji() {
  // Initialize pack preference (lightweight, can load immediately)
  loadPackPreference()
  
  // LAZY: Don't auto-load emoji data - only load when needed
  // This saves 712KB on initial page load
  // Emoji data will be loaded when:
  // - Emoji picker is opened
  // - Emoji search is performed
  // - Emojis need to be resolved (with check to avoid duplicate loads)
  
  // Preload mutant lookups if using mutant pack (only if emoji data is already loaded)
  if (currentPack.value === 'mutant' && isLoaded.value) {
    loadMutantLookups()
  }
  
  const isNativePack = computed(() => currentPack.value === 'native')
  const isMutantPack = computed(() => currentPack.value === 'mutant')
  const isTwemojiPack = computed(() => currentPack.value === 'twemoji')
  
  return {
    // State
    currentPack,
    isNativePack,
    isMutantPack,
    isTwemojiPack,
    isLoaded,
    isLoading,
    emojiData,
    
    // Pack management
    setEmojiPack,
    
    // Conversions
    shortcodeToUnicode,
    unicodeToShortcode,
    unicodeToCodepoint,
    shortcodeToCodepoint,
    shortcodeToSvgPath,
    getSvgUrl,
    unicodeToSvgUrl,
    getTwemojiUrl,
    getMutantSvgUrl,
    
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
  unicodeToCodepoint,
  shortcodeToCodepoint,
  shortcodeToSvgPath,
  getSvgUrl,
  unicodeToSvgUrl,
  getTwemojiUrl,
  getMutantSvgUrl,
  resolveEmoji,
  normalizeToUnicode,
  searchEmojis,
  getEmojisByCategory,
  getCategories,
  getAllEmojis,
  currentPack,
  isLoaded
}
