import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import type { Server } from '@/types'
import { debug } from '@/utils/debug'
import {
  SERVER_CATEGORIES,
  buildServerSearchFilter,
  inferServerCategory,
  normalizeSearchTerm,
} from '@/utils/serverDiscovery'

export interface PublicServerWithStats extends Server {
  member_count?: number
  is_featured?: boolean
  featured_order?: number | null
  category?: string
}

export interface PublicServersState {
  servers: PublicServerWithStats[]
  searchResults: PublicServerWithStats[]
  categories: string[]
  isLoading: boolean
  isSearching: boolean
  searchQuery: string
  selectedCategory: string | null
  error: string | null
  hasLoaded: boolean
  lastFetchTime: number | null
}

const MAX_FEATURED = 6

const PUBLIC_SERVER_COLUMNS = `
  id,
  name,
  description,
  icon,
  banner,
  owner,
  public,
  allow_cross_server_emojis,
  created_at,
  is_local_server,
  is_featured,
  featured_order
`

// Discovery lists local public servers only; remote reference rows are excluded.
function publicServersQuery() {
  return supabase
    .from('servers')
    .select(PUBLIC_SERVER_COLUMNS)
    .eq('public', true)
    .neq('is_local_server', false)
}

async function withStats(rows: PublicServerWithStats[]): Promise<PublicServerWithStats[]> {
  let memberCounts = new Map<string, number>()
  try {
    const { getServerMemberCounts } = await import('@/services/serverMembershipService')
    memberCounts = await getServerMemberCounts(rows.map(s => s.id))
  } catch (memberError) {
    debug.warn('Could not batch get member counts:', memberError)
  }

  const ownerIds = [...new Set(rows.map(s => s.owner).filter((id): id is string => !!id))]
  if (ownerIds.length > 0) {
    void import('@/services/userDataService')
      .then(({ userDataService }) => userDataService.ensureUsersLoaded(ownerIds))
      .catch(err => debug.warn('Could not preload server owners:', err))
  }

  return rows.map(server => ({
    ...server,
    member_count: memberCounts.get(server.id) ?? 0,
    category: inferServerCategory(server.name, server.description),
    is_featured: server.is_featured || false,
    allow_cross_server_emojis: server.allow_cross_server_emojis || false,
  }))
}

// Monotonic token; a search response is applied only if no newer search or reset started since.
let searchGeneration = 0

export const usePublicServersStore = defineStore('publicServers', {
  state: (): PublicServersState => ({
    servers: [],
    searchResults: [],
    categories: [...SERVER_CATEGORIES],
    isLoading: false,
    isSearching: false,
    searchQuery: '',
    selectedCategory: null,
    error: null,
    hasLoaded: false,
    lastFetchTime: null
  }),

  getters: {
    filteredServers: (state) => {
      let servers = state.searchQuery ? state.searchResults : state.servers

      if (state.selectedCategory) {
        servers = servers.filter(server =>
          server.category === state.selectedCategory
        )
      }

      return servers
    },

    featuredServers: (state) => {
      return state.servers
        .filter(server => server.is_featured)
        .sort((a, b) => (a.featured_order ?? 0) - (b.featured_order ?? 0))
        .slice(0, MAX_FEATURED)
    },

    hasActiveFilter: (state) => !!state.searchQuery || !!state.selectedCategory,

    totalServers: (state) => state.servers.length,

    isEmpty: (state) => state.hasLoaded && state.servers.length === 0,

    isDataStale: (state) => {
      if (!state.lastFetchTime) return true
      return Date.now() - state.lastFetchTime > 5 * 60 * 1000
    }
  },

  actions: {
    async fetchPublicServers(force = false): Promise<void> {
      if (this.isLoading) {
        return
      }

      const shouldFetch = force ||
                         !this.hasLoaded ||
                         this.servers.length === 0 ||
                         this.isDataStale

      if (!shouldFetch) {
        return
      }

      this.isLoading = true
      this.error = null

      try {
        const { data, error } = await publicServersQuery()
          .order('created_at', { ascending: false })
          .limit(100)

        if (error) throw error

        this.servers = await withStats((data || []) as PublicServerWithStats[])
        this.hasLoaded = true
        this.lastFetchTime = Date.now()
      } catch (error) {
        debug.error('Error fetching public servers:', error)
        this.error = 'Failed to load servers. Please try again.'
      } finally {
        this.isLoading = false
      }
    },

    async searchServers(query: string): Promise<void> {
      const generation = ++searchGeneration
      this.searchQuery = normalizeSearchTerm(query)
      const filter = buildServerSearchFilter(this.searchQuery)

      if (!filter) {
        this.searchResults = []
        this.isSearching = false
        return
      }

      this.isSearching = true
      this.error = null

      try {
        const { data, error } = await publicServersQuery()
          .or(filter)
          .order('name')
          .limit(50)

        if (error) throw error

        const results = await withStats((data || []) as PublicServerWithStats[])
        if (generation !== searchGeneration) return
        this.searchResults = results
      } catch (error) {
        if (generation !== searchGeneration) return
        debug.error('Error searching servers:', error)
        this.searchResults = []
        this.error = 'Search failed. Please try again.'
      } finally {
        if (generation === searchGeneration) this.isSearching = false
      }
    },

    setSelectedCategory(category: string | null): void {
      this.selectedCategory = category
    },

    clearSearch(): void {
      searchGeneration++
      this.searchQuery = ''
      this.searchResults = []
      this.isSearching = false
    },

    resetFilters(): void {
      this.clearSearch()
      this.selectedCategory = null
      this.error = null
    },

    clearError(): void {
      this.error = null
    },

    async forceRefresh(): Promise<void> {
      this.hasLoaded = false
      this.lastFetchTime = null
      await this.fetchPublicServers(true)
    },

    async retry(): Promise<void> {
      if (this.searchQuery) {
        await this.searchServers(this.searchQuery)
      } else {
        await this.forceRefresh()
      }
    },

    needsFreshData(): boolean {
      return !this.hasLoaded || this.servers.length === 0 || this.isDataStale
    },

    reset(): void {
      this.resetFilters()
      this.servers = []
      this.hasLoaded = false
      this.lastFetchTime = null
      this.isLoading = false
    }
  }
})
