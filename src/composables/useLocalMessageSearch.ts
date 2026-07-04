/**
 * useLocalMessageSearch - Client-side search for encrypted/decrypted messages
 * 
 * This composable provides local (client-side) search functionality for messages
 * that are already loaded and decrypted in memory. This is essential for E2EE
 * messages where server-side search cannot access the decrypted content.
 * 
 * Use cases:
 * - Searching encrypted DM conversations
 * - Searching encrypted server channels
 * - Filtering loaded messages without server round-trips
 */

import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import type { Message, MessagePart } from '@/types'

export interface LocalSearchOptions {
  /** Minimum query length to trigger search (default: 2) */
  minQueryLength?: number
  /** Debounce delay in ms (default: 150) */
  debounceMs?: number
  /** Case sensitive search (default: false) */
  caseSensitive?: boolean
  /** Search in user mentions (default: true) */
  searchMentions?: boolean
  /** Search in URLs (default: true) */
  searchUrls?: boolean
}

export interface LocalSearchResult {
  message: Message
  /** Array of matching text snippets with context */
  matches: string[]
  /** Relevance score (higher = more matches) */
  score: number
}

/**
 * Extract searchable text from message content parts
 */
function extractTextFromContent(content: MessagePart[]): string {
  if (!content || !Array.isArray(content)) {
    return ''
  }

  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text || ''
        case 'mention':
          return (part as any).mention || part.username || ''
        case 'url':
          return part.url || ''
        case 'emoji':
          return part.emoji?.name ? `:${part.emoji.name}:` : ''
        case 'hashtag':
          return part.name ? `#${part.name}` : ''
        default:
          return ''
      }
    })
    .join(' ')
    .trim()
}

/**
 * Find matching snippets in text with context
 */
function findMatchingSnippets(
  text: string, 
  query: string, 
  caseSensitive: boolean,
  contextChars: number = 30
): string[] {
  const snippets: string[] = []
  const searchText = caseSensitive ? text : text.toLowerCase()
  const searchQuery = caseSensitive ? query : query.toLowerCase()
  
  let index = searchText.indexOf(searchQuery)
  while (index !== -1) {
    const start = Math.max(0, index - contextChars)
    const end = Math.min(text.length, index + query.length + contextChars)
    
    let snippet = text.slice(start, end)
    if (start > 0) snippet = '...' + snippet
    if (end < text.length) snippet = snippet + '...'
    
    snippets.push(snippet)
    index = searchText.indexOf(searchQuery, index + 1)
  }
  
  return snippets
}

/**
 * Local message search composable
 * 
 * @param messages - Reactive array of messages to search through
 * @param options - Search configuration options
 */
export function useLocalMessageSearch(
  messages: Ref<Message[]> | ComputedRef<Message[]>,
  options: LocalSearchOptions = {}
) {
  const {
    minQueryLength = 2,
    debounceMs = 150,
    caseSensitive = false,
    // eslint-disable-next-line unused-imports/no-unused-vars
    searchMentions = true,
    // eslint-disable-next-line unused-imports/no-unused-vars
    searchUrls = true
  } = options

  // State
  const query = ref('')
  const isSearching = ref(false)
  const searchResults = ref<LocalSearchResult[]>([])
  
  // Debounce timer
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  // Computed
  const hasQuery = computed(() => query.value.trim().length >= minQueryLength)
  const hasResults = computed(() => searchResults.value.length > 0)
  const resultCount = computed(() => searchResults.value.length)
  
  /**
   * Filter messages that are encrypted but not decrypted (can't search these)
   */
  const searchableMessages = computed(() => {
    return messages.value.filter(msg => {
      // Skip deleted messages
      if (msg.is_system) return false
      
      // If encrypted but not decrypted, we can't search it
      if (msg.encrypted && !msg.decrypted) {
        return false
      }
      
      // Has content to search
      return msg.content && Array.isArray(msg.content) && msg.content.length > 0
    })
  })
  
  /**
   * Count of encrypted messages that cannot be searched
   */
  const unsearchableCount = computed(() => {
    return messages.value.filter(msg => 
      msg.encrypted && !msg.decrypted && !msg.is_system
    ).length
  })

  /**
   * Execute local search
   */
  const executeSearch = () => {
    const searchQuery = query.value.trim()
    
    if (searchQuery.length < minQueryLength) {
      searchResults.value = []
      isSearching.value = false
      return
    }

    isSearching.value = true
    
    try {
      const results: LocalSearchResult[] = []
      
      for (const message of searchableMessages.value) {
        const text = extractTextFromContent(message.content)
        
        if (!text) continue
        
        const textToSearch = caseSensitive ? text : text.toLowerCase()
        const queryToSearch = caseSensitive ? searchQuery : searchQuery.toLowerCase()
        
        if (textToSearch.includes(queryToSearch)) {
          const matches = findMatchingSnippets(text, searchQuery, caseSensitive)
          
          const matchCount = (textToSearch.match(new RegExp(queryToSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
          
          results.push({
            message,
            matches,
            score: matchCount
          })
        }
      }
      
      // Sort by score (most matches first), then by date (newest first)
      results.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score
        }
        return new Date(b.message.created_at).getTime() - new Date(a.message.created_at).getTime()
      })
      
      searchResults.value = results
    } finally {
      isSearching.value = false
    }
  }

  /**
   * Execute search with debouncing
   */
  const searchDebounced = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    
    if (query.value.trim().length < minQueryLength) {
      searchResults.value = []
      return
    }
    
    isSearching.value = true
    
    debounceTimer = setTimeout(() => {
      executeSearch()
    }, debounceMs)
  }

  /**
   * Set search query
   */
  const setQuery = (newQuery: string) => {
    query.value = newQuery
  }

  /**
   * Clear search
   */
  const clearSearch = () => {
    query.value = ''
    searchResults.value = []
    isSearching.value = false
    
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  /**
   * Highlight matching text in a message's content
   */
  const highlightMatches = (text: string): string => {
    if (!hasQuery.value || !text) return text
    
    const searchQuery = query.value.trim()
    const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escapedQuery})`, caseSensitive ? 'g' : 'gi')
    
    return text.replace(regex, '<mark>$1</mark>')
  }

  /**
   * Navigate to a specific search result (for use with UI)
   */
  const getMessageIndex = (messageId: string): number => {
    return messages.value.findIndex(m => m.id === messageId)
  }

  // Watch query changes and trigger debounced search
  watch(query, (newQuery) => {
    if (newQuery.trim().length >= minQueryLength) {
      searchDebounced()
    } else {
      searchResults.value = []
    }
  })

  // Re-search when messages change (e.g., new messages loaded or decrypted)
  watch(
    () => messages.value.length,
    () => {
      if (hasQuery.value) {
        executeSearch()
      }
    }
  )

  return {
    // State
    query,
    isSearching,
    searchResults,
    
    // Computed
    hasQuery,
    hasResults,
    resultCount,
    searchableMessages,
    unsearchableCount,
    
    // Methods
    setQuery,
    clearSearch,
    executeSearch,
    searchDebounced,
    highlightMatches,
    getMessageIndex,
    
    // Utilities
    extractTextFromContent
  }
}

export type LocalMessageSearchReturn = ReturnType<typeof useLocalMessageSearch>

