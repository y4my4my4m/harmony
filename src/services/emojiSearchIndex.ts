/**
 * Precomputed emoji search over the unicode set and the custom emoji groups.
 *
 * Every string is lowercased once at build time. A unicode query costs two
 * binary searches over sorted term arrays (alias prefix, word prefix) and, when
 * those leave room under the limit, one `includes` per entry. Custom emoji are
 * scanned linearly over the precomputed lowercase names.
 *
 * Tiers, best first:
 *   0  exact shortcode or alias          `joy` -> 😂
 *   1  shortcode or alias prefix         `jo`  -> 😂 (`joy`), 🕹️ (`joystick`)
 *   2  keyword or name-word prefix       `tears` -> 😂
 *   3  substring of any term
 * Ties order by matched term length, then custom before unicode, then source
 * order (category order for unicode, current server first for custom).
 */
import type { EmojiEntry } from '@/services/unifiedEmojiService'
import type { ResolvedEmoji } from '@/types'

export type MatchTier = 0 | 1 | 2 | 3

export interface UnicodeSearchEntry {
  emoji: EmojiEntry
  /** Shortcode and every alias, lowercased; `label` first. */
  names: string[]
  /** Preferred display shortcode: the first alias, else the canonical shortcode. */
  label: string
  hay: string
  order: number
}

export interface UnicodeSearchIndex {
  entries: UnicodeSearchEntry[]
  /** Sorted ascending; `nameEntries[i]` owns `names[i]`. */
  names: string[]
  nameEntries: UnicodeSearchEntry[]
  words: string[]
  wordEntries: UnicodeSearchEntry[]
}

export interface CustomSearchEntry {
  emoji: ResolvedEmoji
  serverId: string
  serverName: string
  name: string
  display: string
  order: number
}

export interface EmojiHit<T> {
  item: T
  tier: MatchTier
  /** Term the query matched; the display shortcode for tier 0 and 1. */
  matched: string
}

function sortedPairs<T>(pairs: Array<[string, T]>): { keys: string[]; values: T[] } {
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return { keys: pairs.map(p => p[0]), values: pairs.map(p => p[1]) }
}

function lowerBound(keys: string[], q: string): number {
  let lo = 0
  let hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (keys[mid] < q) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function buildUnicodeIndex(
  emojis: readonly EmojiEntry[],
  shortcodeToUnicode: Readonly<Record<string, string>>,
): UnicodeSearchIndex {
  const aliasesByUnicode = new Map<string, string[]>()
  for (const [code, unicode] of Object.entries(shortcodeToUnicode)) {
    let list = aliasesByUnicode.get(unicode)
    if (!list) aliasesByUnicode.set(unicode, (list = []))
    list.push(code.toLowerCase())
  }

  const entries: UnicodeSearchEntry[] = []
  const namePairs: Array<[string, UnicodeSearchEntry]> = []
  const wordPairs: Array<[string, UnicodeSearchEntry]> = []

  emojis.forEach((emoji, order) => {
    const canonical = (emoji.shortcode ?? '').toLowerCase()
    const aliases = (aliasesByUnicode.get(emoji.unicode) ?? []).filter(a => a !== canonical)
    const label = aliases[0] ?? canonical
    const names = [...new Set([label, canonical, ...aliases].filter(Boolean))]

    const words = new Set<string>()
    for (const kw of emoji.keywords ?? []) words.add(kw.toLowerCase())
    for (const w of (emoji.name ?? '').toLowerCase().split(/[\s_:,-]+/)) if (w) words.add(w)
    for (const n of names) for (const seg of n.split('_')) if (seg) words.add(seg)
    for (const n of names) words.delete(n)

    const entry: UnicodeSearchEntry = {
      emoji,
      names,
      label,
      hay: [...names, ...words, (emoji.name ?? '').toLowerCase()].join('\n'),
      order,
    }
    entries.push(entry)
    for (const n of names) {
      namePairs.push([n, entry])
    }
    for (const w of words) wordPairs.push([w, entry])
  })

  const n = sortedPairs(namePairs)
  const w = sortedPairs(wordPairs)
  return { entries, names: n.keys, nameEntries: n.values, words: w.keys, wordEntries: w.values }
}

/** Ranked unicode hits; `limit` caps the result, not the candidates ranked. */
export function searchUnicodeIndex(
  index: UnicodeSearchIndex,
  rawQuery: string,
  limit = 50,
): EmojiHit<UnicodeSearchEntry>[] {
  const q = rawQuery.toLowerCase().trim()
  if (!q) return []
  const best = new Map<UnicodeSearchEntry, EmojiHit<UnicodeSearchEntry>>()
  const offer = (item: UnicodeSearchEntry, tier: MatchTier, matched: string) => {
    const prev = best.get(item)
    if (!prev || tier < prev.tier || (tier === prev.tier && matched.length < prev.matched.length)) {
      best.set(item, { item, tier, matched })
    }
  }

  for (let i = lowerBound(index.names, q); i < index.names.length && index.names[i].startsWith(q); i++) {
    const name = index.names[i]
    offer(index.nameEntries[i], name === q ? 0 : 1, name)
  }
  for (let i = lowerBound(index.words, q); i < index.words.length && index.words[i].startsWith(q); i++) {
    offer(index.wordEntries[i], 2, index.wordEntries[i].label)
  }
  if (best.size < limit) {
    for (const entry of index.entries) {
      if (!best.has(entry) && entry.hay.includes(q)) offer(entry, 3, entry.label)
    }
  }

  return [...best.values()]
    .sort((a, b) => a.tier - b.tier || a.matched.length - b.matched.length || a.item.order - b.item.order)
    .slice(0, limit)
}

type ResolvedGroups = Record<string, { server_name: string; emojis: ResolvedEmoji[] }>

const customIndexCache = new WeakMap<object, { currentServerId: string | null; entries: CustomSearchEntry[] }>()

/**
 * Flat, lowercased view of `resolved`, current server first. Cached per
 * `resolved` object; the emoji cache store replaces that object on every rebuild.
 */
export function customEmojiIndex(resolved: ResolvedGroups, currentServerId: string | null): CustomSearchEntry[] {
  const cached = customIndexCache.get(resolved)
  if (cached && cached.currentServerId === currentServerId) return cached.entries

  const ids = Object.keys(resolved)
  if (currentServerId && ids.includes(currentServerId)) {
    ids.splice(ids.indexOf(currentServerId), 1)
    ids.unshift(currentServerId)
  }
  const entries: CustomSearchEntry[] = []
  for (const serverId of ids) {
    const group = resolved[serverId]
    for (const emoji of group.emojis) {
      entries.push({
        emoji,
        serverId,
        serverName: group.server_name,
        name: (emoji.name ?? '').toLowerCase(),
        display: (emoji.display_name ?? emoji.name ?? '').toLowerCase(),
        order: entries.length,
      })
    }
  }
  customIndexCache.set(resolved, { currentServerId, entries })
  return entries
}

function customTier(e: CustomSearchEntry, q: string): MatchTier | -1 {
  if (e.name === q || e.display === q) return 0
  if (e.name.startsWith(q) || e.display.startsWith(q)) return 1
  if (e.name.includes('_' + q)) return 2
  if (e.name.includes(q) || e.display.includes(q)) return 3
  return -1
}

/** Ranked custom hits. An empty query matches every entry at tier 3. */
export function searchCustomIndex(
  entries: readonly CustomSearchEntry[],
  rawQuery: string,
  limit = Infinity,
): EmojiHit<CustomSearchEntry>[] {
  const q = rawQuery.toLowerCase().trim()
  const hits: EmojiHit<CustomSearchEntry>[] = []
  if (!q) {
    for (const e of entries) {
      if (hits.length >= limit) break
      hits.push({ item: e, tier: 3, matched: e.display })
    }
    return hits
  }
  // Bucketed by tier; a bucket is sorted only when the limit reaches into it.
  const buckets: EmojiHit<CustomSearchEntry>[][] = [[], [], [], []]
  for (const e of entries) {
    const tier = customTier(e, q)
    if (tier >= 0) buckets[tier].push({ item: e, tier: tier as MatchTier, matched: e.display })
  }
  for (const bucket of buckets) {
    if (hits.length >= limit) break
    bucket.sort((a, b) => a.matched.length - b.matched.length || a.item.order - b.item.order)
    for (const h of bucket) {
      if (hits.length >= limit) break
      hits.push(h)
    }
  }
  return hits
}

/** True when `entry` matches `rawQuery` at any tier. */
export function customMatches(entry: CustomSearchEntry, rawQuery: string): boolean {
  return customTier(entry, rawQuery.toLowerCase().trim()) >= 0
}

const urlByNameCache = new WeakMap<object, Map<string, string>>()

/** Custom emoji name -> image URL, first group wins. Cached per `resolved` object. */
export function customEmojiUrlByName(resolved: ResolvedGroups): Map<string, string> {
  let map = urlByNameCache.get(resolved)
  if (map) return map
  map = new Map()
  for (const group of Object.values(resolved)) {
    for (const emoji of group.emojis) {
      if (emoji.url && !map.has(emoji.name)) map.set(emoji.name, emoji.url)
    }
  }
  urlByNameCache.set(resolved, map)
  return map
}
