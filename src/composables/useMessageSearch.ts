/**
 * Server-side message search: query state, paging and recent searches.
 *
 * The server holds no plaintext for encrypted messages; useLocalMessageSearch covers the
 * decrypted ones already in memory.
 */

import { computed, ref, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'
import { searchService, SEARCH_TOTAL_CAP } from '@/services/SearchService'
import { ensureMessageEmbeds } from '@/utils/messageEmbedUtils'
import {
  buildSearchParams,
  serializeQuery,
  type ParsedQuery,
  type SearchRpcParams,
  type SearchScope,
  type SearchSort,
  type SearchToken,
} from '@/utils/searchQuery'
import type { Message } from '@/types'
import { debug } from '@/utils/debug'

const RECENT_KEY = 'harmony_recent_searches'
const RECENT_MAX = 10
export const SEARCH_PAGE_SIZE = 25

function readRecent(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(stored) ? stored.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

export function useMessageSearch(scope: MaybeRefOrGetter<SearchScope>) {
  const tokens = ref<SearchToken[]>([])
  const text = ref('')
  const sort = ref<SearchSort>('newest')
  const page = ref(0)
  const results = shallowRef<Message[]>([])
  const total = ref<number | null>(null)
  const isSearching = ref(false)
  const error = ref<string | null>(null)
  /** Parameters of the search on screen; null before the first search. */
  const lastParams = shallowRef<SearchRpcParams | null>(null)
  const recentSearches = ref<string[]>(readRecent())

  let controller: AbortController | null = null

  const pageCount = computed(() =>
    total.value ? Math.ceil(Math.min(total.value, SEARCH_TOTAL_CAP) / SEARCH_PAGE_SIZE) : 0)
  const totalCapped = computed(() => (total.value ?? 0) > SEARCH_TOTAL_CAP)

  const query = (): ParsedQuery => ({ text: text.value, tokens: tokens.value })

  const rememberSearch = () => {
    const entry = serializeQuery(query())
    if (!entry) return
    recentSearches.value = [entry, ...recentSearches.value.filter(s => s !== entry)].slice(0, RECENT_MAX)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches.value))
    } catch {
      // Storage unavailable: recent searches last for the session.
    }
  }

  const clearRecentSearches = () => {
    recentSearches.value = []
    try {
      localStorage.removeItem(RECENT_KEY)
    } catch {
      // Storage unavailable.
    }
  }

  /** Runs the current query at `targetPage`. Returns false when the query cannot match anything. */
  const execute = async (targetPage = 0): Promise<boolean> => {
    controller?.abort()
    const params = buildSearchParams(query(), toValue(scope), {
      sort: sort.value,
      page: targetPage,
      pageSize: SEARCH_PAGE_SIZE,
    })
    if (!params) {
      lastParams.value = null
      results.value = []
      total.value = null
      error.value = null
      isSearching.value = false
      return false
    }

    const ctrl = new AbortController()
    controller = ctrl
    isSearching.value = true
    error.value = null
    try {
      const response = await searchService.searchMessages(params, { signal: ctrl.signal })
      if (ctrl.signal.aborted) return true
      ensureMessageEmbeds(response.results)
      results.value = response.results
      // A page past the end reports no count; keep the one already shown.
      if (response.total !== null || targetPage === 0) total.value = response.total ?? 0
      page.value = targetPage
      lastParams.value = params
      if (targetPage === 0) rememberSearch()
    } catch (err: unknown) {
      if (ctrl.signal.aborted) return true
      debug.error('Search error:', err)
      error.value = err instanceof Error ? err.message : String(err)
      results.value = []
      lastParams.value = params
    } finally {
      if (controller === ctrl) {
        isSearching.value = false
        controller = null
      }
    }
    return true
  }

  const reset = () => {
    controller?.abort()
    controller = null
    tokens.value = []
    text.value = ''
    sort.value = 'newest'
    page.value = 0
    results.value = []
    total.value = null
    error.value = null
    isSearching.value = false
    lastParams.value = null
  }

  return {
    tokens,
    text,
    sort,
    page,
    results,
    total,
    totalCapped,
    pageCount,
    isSearching,
    error,
    lastParams,
    recentSearches,
    execute,
    reset,
    clearRecentSearches,
  }
}
