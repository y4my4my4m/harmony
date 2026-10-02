import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { supabase } from '@/supabase'
import { getServerMemberCounts } from '@/services/serverMembershipService'
import type { Server } from '@/types'
import { debug } from '@/utils/debug'
import {
  SERVER_CATEGORIES,
  buildServerSearchFilter,
  normalizeSearchTerm,
  resolveServerCategory,
  reuseUnchangedRows,
  type ServerCategory,
} from '@/utils/serverDiscovery'

export interface PublicServerWithStats extends Server {
  member_count?: number
  is_featured?: boolean
  featured_order?: number | null
  /** servers.category when set, otherwise inferred; see resolveServerCategory. */
  discovery_category?: ServerCategory
}

export interface PublicServersState {
  servers: PublicServerWithStats[]
  searchResults: PublicServerWithStats[]
  categories: ServerCategory[]
  isLoading: boolean
  isSearching: boolean
  searchQuery: string
  selectedCategory: string | null
  error: string | null
  hasLoaded: boolean
  lastFetchTime: number | null
}

const MAX_FEATURED = 6

// Age past which an open revalidates the list in the background.
const STALE_AFTER_MS = 60 * 1000

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
  featured_order,
  category
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
  // Started before the member-count await so both requests run concurrently.
  const ownerIds = [...new Set(rows.map(s => s.owner).filter((id): id is string => !!id))]
  if (ownerIds.length > 0) {
    void import('@/services/userDataService')
      .then(({ userDataService }) => userDataService.ensureUsersLoaded(ownerIds))
      .catch(err => debug.warn('Could not preload server owners:', err))
  }

  let memberCounts = new Map<string, number>()
  try {
    memberCounts = await getServerMemberCounts(rows.map(s => s.id))
  } catch (memberError) {
    debug.warn('Could not batch get member counts:', memberError)
  }

  return rows.map(server => ({
    ...server,
    member_count: memberCounts.get(server.id) ?? 0,
    discovery_category: resolveServerCategory(server),
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
          server.discovery_category === state.selectedCategory
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

    /** First load only; a refresh keeps the cached list on screen. */
    isInitialLoading: (state) => state.isLoading && !state.hasLoaded,

    totalServers: (state) => state.servers.length,

    isEmpty: (state) => state.hasLoaded && state.servers.length === 0,

    isDataStale: (state) => {
      if (!state.lastFetchTime) return true
      return Date.now() - state.lastFetchTime > STALE_AFTER_MS
    }
  },

  actions: {
    /**
     * Loads the list when absent or stale. A refresh replaces only rows that
     * changed, so unchanged cards keep their props and do not re-render; a
     * failed refresh keeps the cached list.
     */
    async fetchPublicServers(force = false): Promise<void> {
      if (this.isLoading) {
        return
      }

      if (!force && !this.needsFreshData()) {
        return
      }

      this.isLoading = true
      this.error = null

      try {
        const { data, error } = await publicServersQuery()
          .order('created_at', { ascending: false })
          .limit(100)

        if (error) throw error

        const rows = await withStats((data || []) as PublicServerWithStats[])
        const prev = toRaw(this.servers)
        const next = reuseUnchangedRows(prev, rows)
        if (next !== prev) this.servers = next
        this.hasLoaded = true
        this.lastFetchTime = Date.now()
      } catch (error) {
        debug.error('Error fetching public servers:', error)
        if (!this.hasLoaded) this.error = 'Failed to load servers. Please try again.'
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

    markStale(): void {
      this.lastFetchTime = null
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
