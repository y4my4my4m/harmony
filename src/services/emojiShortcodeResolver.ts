/**
 * Central resolver for custom emoji shortcodes (:name: and :name~N: disambiguation).
 * Used by display names, supporter badges, message content, editors, and admin UI.
 */

import { supabase } from '@/supabase'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { getSvgUrl, resolveEmoji, getTwemojiUrl, loadEmojiData, isLoaded as unifiedEmojiLoaded } from '@/services/unifiedEmojiService'
import { debug } from '@/utils/debug'
import type { Emoji } from '@/types'

/**
 * Characters allowed inside :shortcode: (includes ~ for cross-server disambiguation).
 *
 * NOTE: Stateful `g`-flag regex objects MUST NOT be shared across modules — `lastIndex`
 * mutation by one consumer corrupts ongoing iteration in another. Each consumer
 * should construct its own RegExp from this pattern via `createShortcodeRegex()`.
 */
export const EMOJI_SHORTCODE_INNER = '[a-zA-Z0-9_+~-]+'
export const EMOJI_SHORTCODE_FULL_REGEX = new RegExp(`^:(${EMOJI_SHORTCODE_INNER}):$`)

/** Each call returns a fresh global regex — safe for concurrent `.exec()` loops. */
export function createShortcodeRegex(): RegExp {
  return new RegExp(`:(${EMOJI_SHORTCODE_INNER}):`, 'g')
}

const EMOJI_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DISAMBIGUATOR_SUFFIX_REGEX = /^(.+?)(?:~(\d+))?$/

export interface ParsedEmojiShortcode {
  /** Inner token (e.g. har_wink~1), without colons. */
  token: string
  baseName: string
  /** null = first match (~0); 1 = second duplicate (display name foo~1), etc. */
  disambiguator: number | null
  isUuid: boolean
}

const dbEmojiCache = new Map<string, Emoji>()
const pendingDbFetches = new Map<string, Promise<Emoji | null>>()
/** Negative cache: tokens we know the DB has no row for. Prevents re-fetch loops. */
const dbEmojiMissCache = new Set<string>()
const DB_MISS_CACHE_MAX = 500

export function parseEmojiShortcodeToken(token: string): ParsedEmojiShortcode {
  if (EMOJI_UUID_REGEX.test(token)) {
    return { token, baseName: token, disambiguator: null, isUuid: true }
  }

  const match = token.match(DISAMBIGUATOR_SUFFIX_REGEX)
  const baseName = match?.[1] ?? token
  const disambiguator = match?.[2] !== undefined ? Number.parseInt(match[2], 10) : null

  return { token, baseName, disambiguator, isUuid: false }
}

/** Shortcode string to store when user picks an emoji (uses display_name~N when disambiguated). */
export function getEmojiShortcodeForInsert(emoji: Emoji & { display_name?: string }): string {
  if (!emoji.url) {
    return typeof emoji.id === 'string' ? emoji.id : emoji.name
  }
  const label =
    emoji.display_name && emoji.display_name !== emoji.name
      ? emoji.display_name
      : emoji.name
  return `:${label}:`
}

/** Strip or add colons around a token. */
export function normalizeToInnerToken(value: string): string {
  const full = value.match(EMOJI_SHORTCODE_FULL_REGEX)
  return full ? full[1] : value
}

/**
 * List custom emojis with the same base name in the same order as the emoji picker
 * (useEmojiCache.rebuildResolvedEmojis disambiguation).
 */
export function listCachedEmojisInDisambiguationOrder(baseName: string): Emoji[] {
  let store: ReturnType<typeof useEmojiCacheStore> | null = null
  try {
    store = useEmojiCacheStore()
  } catch {
    return []
  }

  if (!store.isInitialized) return []

  const result: Emoji[] = []
  const seenIds = new Set<string>()

  for (const [, cache] of store.serverCaches) {
    if (cache.isStale) continue
    for (const entry of cache.emojis.values()) {
      if (entry.emoji.name !== baseName) continue
      if (seenIds.has(entry.emoji.id)) continue
      seenIds.add(entry.emoji.id)
      result.push(entry.emoji)
    }
  }

  const indexEntries = store.nameIndex.get(baseName) ?? []
  for (const entry of indexEntries) {
    if (seenIds.has(entry.emoji.id)) continue
    seenIds.add(entry.emoji.id)
    result.push(entry.emoji)
  }

  return result
}

function pickFromOrderedList(emojis: Emoji[], disambiguator: number | null): Emoji | null {
  if (emojis.length === 0) return null
  const index = disambiguator ?? 0
  return emojis[index] ?? emojis[0] ?? null
}

function getEmojiCacheStoreSafe(): ReturnType<typeof useEmojiCacheStore> | null {
  try {
    return useEmojiCacheStore()
  } catch {
    return null
  }
}

/** Synchronous resolve from in-memory emoji cache (+ module DB cache). */
export function findCustomEmojiInCache(
  tokenOrShortcode: string,
  options?: { serverId?: string }
): Emoji | null {
  const inner = normalizeToInnerToken(tokenOrShortcode)
  const parsed = parseEmojiShortcodeToken(inner)

  if (parsed.isUuid) {
    const store = getEmojiCacheStoreSafe()
    const cached = store?.getEmojiById(parsed.token)
    if (cached?.url) return cached
    const fromDb = dbEmojiCache.get(parsed.token)
    return fromDb?.url ? fromDb : null
  }

  const fromDbToken = dbEmojiCache.get(parsed.token)
  if (fromDbToken?.url) return fromDbToken

  const ordered = listCachedEmojisInDisambiguationOrder(parsed.baseName)
  if (options?.serverId) {
    const onServer = ordered.filter(e => e.server_id === options.serverId)
    const picked = pickFromOrderedList(onServer.length > 0 ? onServer : ordered, parsed.disambiguator)
    if (picked?.url) return picked
  }

  const picked = pickFromOrderedList(ordered, parsed.disambiguator)
  return picked?.url ? picked : null
}

/** Drop-in replacement for scattered findEmojiByName helpers. */
export function findEmojiByName(name: string): Emoji | null {
  const custom = findCustomEmojiInCache(name)
  if (custom) return custom

  try {
    if (!unifiedEmojiLoaded.value) {
      loadEmojiData().catch(() => {})
      return null
    }
    const resolved = resolveEmoji(name)
    if (resolved.display.type === 'svg' && resolved.display.content) {
      return {
        id: resolved.shortcode || name,
        name: resolved.shortcode || name,
        url: resolved.display.content,
      } as Emoji
    }
    if (resolved.display.type === 'native' && resolved.unicode && resolved.unicode !== name) {
      return {
        id: resolved.unicode,
        name: resolved.shortcode || name,
        url: '',
        content: resolved.unicode,
        native: resolved.unicode,
      } as Emoji & { native?: string }
    }
  } catch {
    /* ignore */
  }

  return null
}

async function fetchEmojiFromDb(parsed: ParsedEmojiShortcode): Promise<Emoji | null> {
  if (parsed.isUuid) {
    const { data, error } = await supabase
      .from('emojis')
      .select('id, name, url, server_id')
      .eq('id', parsed.token)
      .maybeSingle()
    if (error) throw error
    return data?.url ? (data as Emoji) : null
  }

  const { data, error } = await supabase
    .from('emojis')
    .select('id, name, url, server_id')
    .eq('name', parsed.baseName)
    .order('server_id', { ascending: true })
    .order('id', { ascending: true })

  if (error) throw error
  if (!data?.length) return null

  const index = parsed.disambiguator ?? 0
  const row = data[index] ?? data[0]
  return row?.url ? (row as Emoji) : null
}

/** Resolve custom emoji: cache → module DB cache → Supabase. */
export async function findCustomEmojiByToken(tokenOrShortcode: string): Promise<Emoji | null> {
  const inner = normalizeToInnerToken(tokenOrShortcode)
  const parsed = parseEmojiShortcodeToken(inner)

  const cached = findCustomEmojiInCache(inner)
  if (cached) return cached

  if (dbEmojiMissCache.has(parsed.token)) return null

  const existing = pendingDbFetches.get(parsed.token)
  if (existing) return existing

  const request = (async () => {
    try {
      const emoji = await fetchEmojiFromDb(parsed)
      if (emoji) {
        dbEmojiCache.set(parsed.token, emoji)
        dbEmojiCache.set(parsed.baseName, emoji)
        if (emoji.id) dbEmojiCache.set(emoji.id, emoji)
      } else {
        // Negative cache (size-capped) so we don't refetch missing emojis
        // every render — important because resolveDisplayNameParts triggers
        // ensureCustomEmojisResolved → reResolveAllDisplayNames cycles.
        if (dbEmojiMissCache.size >= DB_MISS_CACHE_MAX) {
          const first = dbEmojiMissCache.values().next().value
          if (first !== undefined) dbEmojiMissCache.delete(first)
        }
        dbEmojiMissCache.add(parsed.token)
      }
      return emoji
    } catch (err) {
      debug.warn('emojiShortcodeResolver: DB lookup failed for', parsed.token, err)
      return null
    } finally {
      pendingDbFetches.delete(parsed.token)
    }
  })()

  pendingDbFetches.set(parsed.token, request)
  return request
}

/** Invalidate caches when an emoji is added/updated/deleted (called by emoji cache store). */
export function invalidateEmojiResolverCache(token?: string): void {
  if (token) {
    const inner = normalizeToInnerToken(token)
    const parsed = parseEmojiShortcodeToken(inner)
    dbEmojiCache.delete(parsed.token)
    dbEmojiCache.delete(parsed.baseName)
    dbEmojiMissCache.delete(parsed.token)
    return
  }
  dbEmojiCache.clear()
  dbEmojiMissCache.clear()
}

/**
 * Batch-resolve tokens and warm the module DB cache.
 * Returns the number of tokens that were *newly* resolved this call
 * (callers can skip downstream re-renders when 0).
 */
export async function ensureCustomEmojisResolved(tokens: string[]): Promise<number> {
  const inners = [...new Set(tokens.map(normalizeToInnerToken).filter(Boolean))]
  const uncached = inners.filter(t => {
    const parsed = parseEmojiShortcodeToken(t)
    if (findCustomEmojiInCache(t)) return false
    if (dbEmojiCache.has(parsed.token)) return false
    if (dbEmojiMissCache.has(parsed.token)) return false
    return true
  })
  if (uncached.length === 0) return 0

  const results = await Promise.allSettled(uncached.map(t => findCustomEmojiByToken(t)))
  let resolved = 0
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.url) resolved++
  }
  return resolved
}

export function getDbCachedEmoji(token: string): Emoji | null {
  return dbEmojiCache.get(normalizeToInnerToken(token)) ?? null
}

/** Whether a token is known to be absent (negative-cached). */
export function isDbMissCached(token: string): boolean {
  return dbEmojiMissCache.has(normalizeToInnerToken(token))
}

/** Unified pack fallback for non-custom shortcodes (mutant / twemoji). */
export function resolveUnifiedEmojiDisplay(
  shortcode: string
): { id: string; name: string; url: string } | null {
  try {
    let fallbackUrl: string | null = getSvgUrl(shortcode)
    if (!fallbackUrl) {
      const resolved = resolveEmoji(shortcode)
      if (resolved.display.type === 'svg' && resolved.display.content) {
        fallbackUrl = resolved.display.content
      } else if (resolved.display.type === 'native' && resolved.unicode && resolved.unicode !== shortcode) {
        fallbackUrl = getTwemojiUrl(resolved.unicode)
      }
    }
    if (fallbackUrl) {
      return { id: shortcode, name: shortcode, url: fallbackUrl }
    }
  } catch {
    /* ignore */
  }
  return null
}
