/**
 * useMessageSearch - Composable for message search functionality
 * 
 * Provides reactive search state, debouncing, filter management,
 * and search execution with pagination support.
 * 
 * For encrypted messages (E2EE), use useLocalMessageSearch instead,
 * which performs client-side search on already-decrypted messages.
 */

import { ref, computed, watch } from 'vue'
import { searchService, type MessageSearchFilters, type MessageSearchResponse } from '@/services/SearchService'
import { ensureMessageEmbeds } from '@/utils/messageEmbedUtils'
import type { Message } from '@/types'
import { debug } from '@/utils/debug'

export interface SearchFilters {
  query: string
  channelId?: string | string[]
  userId?: string
  conversationId?: string
  serverId?: string
  hasMedia?: boolean
  hasUrl?: boolean
  fromDate?: Date | null
  toDate?: Date | null
}

/**
 * Note on E2EE Search:
 * 
 * For end-to-end encrypted messages, server-side search cannot access
 * the decrypted content. In these cases, use the `useLocalMessageSearch`
 * composable which performs client-side filtering on messages that are
 * already loaded and decrypted in memory.
 * 
 * @see useLocalMessageSearch
 */

export function useMessageSearch() {
  // State
  const isSearching = ref(false)
  const searchResults = ref<Message[]>([])
  const hasMore = ref(false)
  const error = ref<string | null>(null)
  const filters = ref<SearchFilters>({
    query: '',
    channelId: undefined,
    userId: undefined,
    conversationId: undefined,
    serverId: undefined,
    hasMedia: undefined,
    hasUrl: undefined,
    fromDate: null,
    toDate: null
  })
  
  const offset = ref(0)
  const searchAbortController = ref<AbortController | null>(null)
  const recentSearches = ref<string[]>([])

  // Debounce timer
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const DEBOUNCE_MS = 300

  // Computed
  const hasActiveFilters = computed(() => {
    return !!(
      filters.value.channelId ||
      filters.value.userId ||
      filters.value.conversationId ||
      filters.value.serverId ||
      filters.value.hasMedia !== undefined ||
      filters.value.hasUrl !== undefined ||
      filters.value.fromDate ||
      filters.value.toDate
    )
  })

  const hasResults = computed(() => searchResults.value.length > 0)
  const canLoadMore = computed(() => hasMore.value && !isSearching.value)

  // Methods
  const setQuery = (query: string) => {
    filters.value.query = query
  }

  const setFilter = <K extends keyof SearchFilters>(
    key: K,
    value: SearchFilters[K]
  ) => {
    filters.value[key] = value
  }

  const clearFilter = (key: keyof SearchFilters) => {
    if (key === 'query') {
      filters.value.query = ''
    } else if (key === 'fromDate' || key === 'toDate') {
      filters.value[key] = null
    } else {
      filters.value[key] = undefined
    }
  }

    const clearAllFilters = () => {
    filters.value = {
      query: '',
      channelId: undefined,
      userId: undefined,
      conversationId: undefined,
      serverId: undefined,
      hasMedia: undefined,
      hasUrl: undefined,
      fromDate: null,
      toDate: null
    }
    offset.value = 0
    searchResults.value = []
    hasMore.value = false
    error.value = null
  }

  const executeSearch = async (resetOffset = true): Promise<void> => {
    // Cancel previous search
    if (searchAbortController.value) {
      searchAbortController.value.abort()
    }

    if (resetOffset) {
      offset.value = 0
      searchResults.value = []
    }

    // Don't search if query is empty and no filters
    if (!filters.value.query.trim() && !hasActiveFilters.value) {
      searchResults.value = []
      hasMore.value = false
      error.value = null
      return
    }

    const abortController = new AbortController()
    searchAbortController.value = abortController

    isSearching.value = true
    error.value = null

    try {
      const searchFilters: MessageSearchFilters = {
        query: filters.value.query.trim() || '', // Empty string if no query but has filters
        channelId: filters.value.channelId,
        userId: filters.value.userId,
        conversationId: filters.value.conversationId,
        serverId: filters.value.serverId,
        hasMedia: filters.value.hasMedia,
        hasUrl: filters.value.hasUrl,
        fromDate: filters.value.fromDate || undefined,
        toDate: filters.value.toDate || undefined,
        limit: 50,
        offset: offset.value
      }

      const response: MessageSearchResponse = await searchService.searchMessages(
        searchFilters,
        { signal: abortController.signal }
      )

      if (abortController.signal.aborted) {
        return
      }

      if (resetOffset) {
        searchResults.value = response.results
      } else {
        searchResults.value = [...searchResults.value, ...response.results]
      }

      try {
        ensureMessageEmbeds(response.results)
      } catch (error) {
        debug.warn('Failed to prepare embeds for search results:', error)
      }

      hasMore.value = response.hasMore
      offset.value += response.results.length

      if (filters.value.query.trim()) {
        addToRecentSearches(filters.value.query.trim())
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        // Search was cancelled, ignore
        return
      }

      debug.error('Search error:', err)
      error.value = err.message || 'Search failed'
      searchResults.value = []
      hasMore.value = false
    } finally {
      if (!abortController.signal.aborted) {
        isSearching.value = false
      }
    }
  }

  const searchDebounced = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    debounceTimer = setTimeout(() => {
      executeSearch(true)
    }, DEBOUNCE_MS)
  }

  const loadMore = async () => {
    if (!canLoadMore.value) {
      return
    }

    await executeSearch(false)
  }

  const addToRecentSearches = (query: string) => {
    if (!query.trim()) {
      return
    }

    const index = recentSearches.value.indexOf(query)
    if (index > -1) {
      recentSearches.value.splice(index, 1)
    }

    recentSearches.value.unshift(query)

    // Keep only last 10
    if (recentSearches.value.length > 10) {
      recentSearches.value = recentSearches.value.slice(0, 10)
    }

    // Persist to localStorage
    try {
      localStorage.setItem('harmony_recent_searches', JSON.stringify(recentSearches.value))
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  const loadRecentSearches = () => {
    try {
      const stored = localStorage.getItem('harmony_recent_searches')
      if (stored) {
        recentSearches.value = JSON.parse(stored)
      }
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  const clearRecentSearches = () => {
    recentSearches.value = []
    try {
      localStorage.removeItem('harmony_recent_searches')
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  loadRecentSearches()

  // Watch query changes for debounced search (only if there's actually a query or filters)
  watch(
    () => filters.value.query,
    (newQuery, oldQuery) => {
      // Only trigger if query actually changed (not just on initialization)
      if (oldQuery !== undefined && (newQuery.trim() || hasActiveFilters.value)) {
        searchDebounced()
      } else if (!newQuery.trim() && !hasActiveFilters.value) {
        searchResults.value = []
        hasMore.value = false
        error.value = null
      }
    }
  )

  // Watch filter changes (non-query) - only trigger if query exists or filters are active
  watch(
    [
      () => filters.value.channelId,
      () => filters.value.userId,
      () => filters.value.conversationId,
      () => filters.value.serverId,
      () => filters.value.hasMedia,
      () => filters.value.hasUrl,
      () => filters.value.fromDate,
      () => filters.value.toDate
    ],
    (newValues, oldValues) => {
      // Only execute if filters actually changed (not just on initialization)
      // and if there's a query or active filters
      if (oldValues !== undefined && (filters.value.query.trim() || hasActiveFilters.value)) {
        executeSearch(true)
      }
    }
  )

  return {
    // State
    isSearching,
    searchResults,
    hasMore,
    error,
    filters,
    recentSearches,
    hasActiveFilters,
    hasResults,
    canLoadMore,

    // Methods
    setQuery,
    setFilter,
    clearFilter,
    clearAllFilters,
    executeSearch,
    searchDebounced,
    loadMore,
    addToRecentSearches,
    clearRecentSearches
  }
}

