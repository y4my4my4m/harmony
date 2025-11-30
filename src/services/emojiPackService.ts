/**
 * Emoji Pack Service
 * 
 * Manages swappable emoji packs (native Unicode vs custom SVG packs like Mutant Standard).
 * Allows users to switch between different emoji styles.
 */

import { ref, computed } from 'vue'
import { debug } from '@/utils/debug'

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
}

const STORAGE_KEY = 'harmony-emoji-pack'
const DEFAULT_PACK_ID = 'mutant'  // Mutant Standard is the default

// Available emoji packs
const availablePacks = ref<Map<string, EmojiPack>>(new Map())
const currentPackId = ref<string>(DEFAULT_PACK_ID)
const isInitialized = ref(false)

// Native Unicode emoji pack (built-in)
const nativeUnicodePack: EmojiPack = {
  id: 'native',
  name: 'Native Unicode',
  description: 'System default Unicode emojis',
  basePath: '',
  format: 'svg',
  categories: [
    { id: 'smileys', name: 'Smileys & People', icon: '😀' },
    { id: 'animals', name: 'Animals & Nature', icon: '🐱' },
    { id: 'food', name: 'Food & Drink', icon: '🍔' },
    { id: 'activities', name: 'Activities', icon: '⚽' },
    { id: 'travel', name: 'Travel & Places', icon: '✈️' },
    { id: 'objects', name: 'Objects', icon: '💡' },
    { id: 'symbols', name: 'Symbols', icon: '❤️' },
    { id: 'flags', name: 'Flags', icon: '🏳️' },
  ],
  emojis: [], // Native emojis are handled differently (rendered as text)
  isBuiltIn: true
}

// Mutant Standard emoji pack definition
const mutantStandardPack: EmojiPack = {
  id: 'mutant',
  name: 'Mutant Standard',
  description: 'Expressive and unique emoji set',
  basePath: '/assets/emojis/mutant_emojis_svg',
  format: 'svg',
  categories: [
    { id: 'expressions', name: 'Expressions', icon: '😀', subcategories: ['smileys', 'body_parts', 'semi_body'] },
    { id: 'food_drink_herbs', name: 'Food & Drink', icon: '🍕', subcategories: ['food', 'drink', 'fruit_veg', 'alcohol_herbs'] },
    { id: 'activities_clothing', name: 'Activities', icon: '🏀', subcategories: ['sports', 'clothing', 'performing_arts', 'roles'] },
    { id: 'nature_effects', name: 'Nature', icon: '🌿', subcategories: ['plants', 'weather', 'earth', 'effects', 'moon'] },
    { id: 'objects', name: 'Objects', icon: '🔧', subcategories: ['tech', 'household', 'office_stationery', 'games', 'party'] },
    { id: 'symbols', name: 'Symbols', icon: '❤️', subcategories: ['hearts', 'arrows', 'shapes', 'misc'] },
    { id: 'travel_places', name: 'Travel', icon: '✈️', subcategories: ['air', 'road', 'trains', 'buildings', 'scenes'] },
    { id: 'people_animals', name: 'Creatures', icon: '🐱', subcategories: ['creatures', 'aspects'] },
    { id: 'extra', name: 'Extra', icon: '✨', subcategories: ['cyber', 'occult_magic', 'weapons', 'symbols'] },
  ],
  emojis: [], // Will be populated by the index generator
  isBuiltIn: false
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
 * Initialize the emoji pack service
 */
export function initializeEmojiPacks(): void {
  if (isInitialized.value) return
  
  // Register built-in packs
  availablePacks.value.set('native', nativeUnicodePack)
  availablePacks.value.set('mutant', mutantStandardPack)
  
  // Load user preference
  loadPackPreference()
  
  isInitialized.value = true
  debug.log('📦 Emoji packs initialized. Current pack:', currentPackId.value)
}

/**
 * Get the current emoji pack
 */
export function getCurrentPack(): EmojiPack {
  initializeEmojiPacks()
  return availablePacks.value.get(currentPackId.value) || nativeUnicodePack
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
  
  return {
    // State
    currentPackId,
    currentPack,
    packs,
    isNativePack,
    
    // Methods
    setCurrentPack,
    loadPackEmojiIndex,
    getEmojiPackUrl,
    searchPackEmojis,
    getEmojisByCategory,
    registerEmojiPack
  }
}

