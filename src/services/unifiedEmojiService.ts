/**
 * Emoji storage, lookup and rendering.
 *
 * Reactions are stored as unicode so they survive a pack switch. Rendering
 * follows the selected pack (twemoji or native). Lookups map
 * shortcode <-> unicode <-> codepoint.
 *
 * Data source: unicode-emoji-data.json.
 */

import { ref, computed } from 'vue'
import { debug } from '@/utils/debug'
import { 
  TWEMOJI_BASE_URL, 
  DEFAULT_EMOJI_PACK,
  EMOJI_CATEGORIES,
  type EmojiPack 
} from '@/utils/emojiConstants'
import {
  getCachedStaticEmojiData,
  setCachedStaticEmojiData,
} from '@/services/emojiIndexedDBCache'

export type { EmojiPack } from '@/utils/emojiConstants'

export interface EmojiLookups {
  shortcodeToUnicode: Record<string, string>
  unicodeToShortcode: Record<string, string>
  unicodeToCodepoint: Record<string, string>
}

export interface EmojiEntry {
  unicode: string
  shortcode: string
  name: string
  category: string
  codepoint: string
  keywords: string[]
  skinToneSupport?: boolean
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

// Set of twemoji SVG filenames; used for exact path resolution.
const twemojiFileMap = ref<Record<string, boolean> | null>(null)

// Bump when the static JSON files change; busts the IndexedDB cache and forces
// a one-time refetch on the next loader run.
//
// v2 (2026-05-21): unicode-emoji-data.json regenerated 2026-05-20 with keyword
// aliases (`+1`, `thumbsup`). A stale v1 blob has no keyword field, so `:+1`
// does not resolve to thumbs_up in autosuggest or picker search.
//
// v3 (2026-05-25): ~884 GitHub/Discord shortcode aliases from `gemoji` merged
// into `shortcodeToUnicode`, making `:joy:`, `:heart:`, `:thumbsup:` resolve as
// standalone shortcodes rather than picker-only keyword matches.
const EMOJI_DATA_CACHE_VERSION = '4'

/** Loads emoji data from IndexedDB, falling back to a network fetch. */
async function loadEmojiData(): Promise<void> {
  if (isLoaded.value || isLoading.value) return
  
  isLoading.value = true
  try {
    // IndexedDB first: no network round-trip.
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
        debug.log(`Loaded emoji data from IndexedDB cache: ${cachedData.totalCount} emojis`)
      }

      if (cachedFileMap) {
        twemojiFileMap.value = cachedFileMap
        if (loadedFromCache) {
          debug.log(`Loaded Twemoji file map from IndexedDB cache`)
        }
      }
    } catch (e) {
      debug.warn('IndexedDB emoji cache read failed, falling back to network:', e)
    }

    if (loadedFromCache && twemojiFileMap.value) {
      isLoaded.value = true
      return
    }

    // Network fetch, repopulating the IndexedDB cache.
    if (!emojiData.value) {
      const dataResponse = await fetch('/assets/emojis/unicode-emoji-data.json')
      if (dataResponse.ok) {
        emojiData.value = await dataResponse.json()
        lookups.value = emojiData.value?.lookups || null
        debug.log(`Loaded unified emoji data: ${emojiData.value?.totalCount} emojis`)
        setCachedStaticEmojiData('unicode-emoji-data', emojiData.value, EMOJI_DATA_CACHE_VERSION)
      } else {
        debug.warn('unicode-emoji-data.json not found')
      }
    }
    
    if (!twemojiFileMap.value) {
      try {
        const fileMapResponse = await fetch('/assets/emojis/twemoji-file-map.json')
        if (fileMapResponse.ok) {
          twemojiFileMap.value = await fileMapResponse.json()
          debug.log(`Loaded Twemoji file map: ${Object.keys(twemojiFileMap.value || {}).length} entries`)
          setCachedStaticEmojiData('twemoji-file-map', twemojiFileMap.value, EMOJI_DATA_CACHE_VERSION)
        }
      } catch (e) {
        debug.warn('Could not load Twemoji file map, using fallback normalization')
      }
    }
    
    isLoaded.value = true

    // Shortcode lookups now exist; re-resolve emojis in cached display names.
    import('@/services/userDataService').then(({ userDataService }) => {
      userDataService.reResolveAllDisplayNames()
    }).catch(() => { /* userDataService not ready yet */ })
  } catch (error) {
    debug.error('Failed to load emoji data:', error)
  } finally {
    isLoading.value = false
  }
}

function loadPackPreference(): void {
  try {
    const stored = localStorage.getItem(PACK_STORAGE_KEY)
    if (stored === 'native' || stored === 'twemoji') {
      currentPack.value = stored as EmojiPack
    }
  } catch (error) {
    debug.error('Failed to load emoji pack preference:', error)
  }
}

function savePackPreference(): void {
  try {
    localStorage.setItem(PACK_STORAGE_KEY, currentPack.value)
  } catch (error) {
    debug.error('Failed to save emoji pack preference:', error)
  }
}

function setEmojiPack(pack: EmojiPack): void {
  currentPack.value = pack
  savePackPreference()
  debug.log(`Switched to emoji pack: ${pack}`)
}

// CONVERSION UTILITIES

/**
 * "grinning_face" -> "😀". Case-insensitive: exact match, then lowercase.
 */
function shortcodeToUnicode(shortcode: string): string | null {
  if (!lookups.value || shortcode == null || shortcode === '') return null
  const key = String(shortcode)
  return lookups.value.shortcodeToUnicode[key] || 
         lookups.value.shortcodeToUnicode[key.toLowerCase()] || 
         null
}

/** "😀" -> "grinning_face". */
function unicodeToShortcode(unicode: string): string | null {
  if (!lookups.value) return null
  return lookups.value.unicodeToShortcode[unicode] || null
}

/** "😀" -> "1f600" (hex, dash-joined for sequences). */
function unicodeToCodepoint(unicode: string): string | null {
  if (!lookups.value) return null
  return lookups.value.unicodeToCodepoint?.[unicode] || null
}

function shortcodeToCodepoint(shortcode: string): string | null {
  const unicode = shortcodeToUnicode(shortcode)
  if (!unicode) return null
  return unicodeToCodepoint(unicode)
}

/**
 * Resolves a codepoint sequence to an existing Twemoji filename by trying
 * fe0f (variation selector) placements. Returns null when none match.
 */
function findTwemojiFile(codepoint: string): string | null {
  if (!twemojiFileMap.value) return null
  
  if (twemojiFileMap.value[codepoint]) {
    return codepoint
  }
  
  const parts = codepoint.split('-')
  
  // All fe0f stripped.
  const withoutFe0f = parts.filter(p => p !== 'fe0f').join('-')
  if (twemojiFileMap.value[withoutFe0f]) {
    return withoutFe0f
  }
  
  // fe0f kept only after gender/directional symbols (2640, 2642, 27a1).
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
  
  // Trailing fe0f stripped.
  if (parts[parts.length - 1] === 'fe0f') {
    const withoutTrailing = parts.slice(0, -1).join('-')
    if (twemojiFileMap.value[withoutTrailing]) {
      return withoutTrailing
    }
  }
  
  // fe0f inserted after the base emoji of a ZWJ sequence, e.g. 26f9-fe0f-200d-...
  if (parts.length >= 2 && parts[1] === '200d') {
    const withBaseFe0f = [parts[0], 'fe0f', ...parts.slice(1)].join('-')
    if (twemojiFileMap.value[withBaseFe0f]) {
      return withBaseFe0f
    }
  }
  
  return null
}

/**
 * Twemoji SVG URL for a unicode emoji. Resolves via the file map; falls back
 * to heuristic fe0f normalization when the map is unloaded or has no entry.
 */
function getTwemojiUrl(unicode: string): string | null {
  let codepoint = unicodeToCodepoint(unicode)
  
  if (!codepoint) {
    codepoint = unicodeToCodepointDirect(unicode)
  }
  
  if (!codepoint) return null
  
  if (twemojiFileMap.value) {
    const found = findTwemojiFile(codepoint)
    if (found) {
      return `${TWEMOJI_BASE_URL}/${found}.svg`
    }
  }
  
  // Heuristic: strip fe0f except after gender/directional symbols.
  const parts = codepoint.split('-')
  const normalized: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === 'fe0f') {
      const prev = parts[i - 1]
      if (prev === '2640' || prev === '2642' || prev === '27a1') {
        normalized.push(part)
      }
    } else {
      normalized.push(part)
    }
  }
  
  return `${TWEMOJI_BASE_URL}/${normalized.join('-')}.svg`
}

/** Codepoint from the string itself. Used when lookups are not loaded. */
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

/** SVG URL for a shortcode. Null under the native pack, which renders text. */
function getSvgUrl(shortcode: string): string | null {
  if (currentPack.value === 'twemoji') {
    const unicode = shortcodeToUnicode(shortcode)
    if (unicode) {
      return getTwemojiUrl(unicode)
    }
  }
  return null
}

/** SVG URL for a unicode emoji. Null under the native pack. */
function unicodeToSvgUrl(unicode: string): string | null {
  if (currentPack.value === 'twemoji') {
    return getTwemojiUrl(unicode)
  }
  return null
}

// EMOJI RESOLUTION (for display)

export interface ResolvedEmoji {
  unicode: string          // The actual unicode character (always stored)
  shortcode: string | null // Shortcode if known
  display: {
    type: 'native' | 'svg'
    content: string        // Unicode char for native, URL for svg
  }
}

/**
 * Resolves unicode, shortcode or name input for display.
 * Does not load emoji data; callers control when that happens.
 */
function resolveEmoji(input: string): ResolvedEmoji {

  const isShortcode = /^[a-z0-9_+-]+$/i.test(input)
  
  if (isShortcode) {
    const unicode = shortcodeToUnicode(input)
    
    if (currentPack.value === 'native') {
      return {
        unicode: unicode || input,
        shortcode: input,
        display: unicode 
          ? { type: 'native', content: unicode }
          : { type: 'native', content: input }
      }
    }
    
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
    
    return {
      unicode: unicode || input,
      shortcode: input,
      display: { type: 'native', content: unicode || input }
    }
  }
  
  // Input is unicode emoji
  const shortcode = unicodeToShortcode(input)
  
  if (currentPack.value === 'native') {
    return {
      unicode: input,
      shortcode,
      display: { type: 'native', content: input }
    }
  }
  
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
  
  return {
    unicode: input,
    shortcode,
    display: { type: 'native', content: input }
  }
}

/** Normalizes input to unicode; reactions are stored in that form. */
function normalizeToUnicode(input: string): string {
  const isShortcode = /^[a-z0-9_+-]+$/i.test(input)
  if (isShortcode) {
    return shortcodeToUnicode(input) || input
  }
  
  // Already unicode
  return input
}

// SEARCH

/** Returns [] until the background load started here completes. */
function searchEmojis(query: string, limit: number = 50): EmojiEntry[] {
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

function getEmojisByCategory(categoryId: string): EmojiEntry[] {
  if (!emojiData.value) return []
  return emojiData.value.emojis.filter(e => e.category === categoryId)
}

/** Categories sorted by `order`; falls back to EMOJI_CATEGORIES when unloaded. */
function getCategories(): EmojiCategory[] {
  if (!emojiData.value?.categories) return EMOJI_CATEGORIES as unknown as EmojiCategory[]
  return [...emojiData.value.categories].sort((a, b) => (a.order || 0) - (b.order || 0))
}

function getAllEmojis(): EmojiEntry[] {
  return emojiData.value?.emojis || []
}

// COMPOSABLE

/** Emoji data is not loaded here; see the note in the body. */
export function useUnifiedEmoji() {
  loadPackPreference()
  
  // Emoji data stays unloaded on mount: 712KB off the initial page load.
  // Loaded on picker open, on search, and on resolution.
  
  const isNativePack = computed(() => currentPack.value === 'native')
  const isTwemojiPack = computed(() => currentPack.value === 'twemoji')
  
  return {
    // State
    currentPack,
    isNativePack,
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
    getSvgUrl,
    unicodeToSvgUrl,
    getTwemojiUrl,
    
    // Resolution
    resolveEmoji,
    normalizeToUnicode,
    
    // Data access
    searchEmojis,
    getEmojisByCategory,
    getCategories,
    getAllEmojis,
    
    reload: loadEmojiData
  }
}

// Direct exports for non-component consumers.
export {
  loadEmojiData,
  setEmojiPack,
  shortcodeToUnicode,
  unicodeToShortcode,
  unicodeToCodepoint,
  shortcodeToCodepoint,
  getSvgUrl,
  unicodeToSvgUrl,
  getTwemojiUrl,
  resolveEmoji,
  normalizeToUnicode,
  searchEmojis,
  getEmojisByCategory,
  getCategories,
  getAllEmojis,
  currentPack,
  isLoaded
}
