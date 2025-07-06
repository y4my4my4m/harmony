import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import type { Server } from '@/types'

export interface PublicServerWithStats extends Server {
  member_count?: number
  is_featured?: boolean
  category?: string
  last_activity?: string
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

export interface PublicServersFilters {
  category?: string
  minMembers?: number
  maxMembers?: number
  sortBy?: 'name' | 'members' | 'activity' | 'created'
  sortOrder?: 'asc' | 'desc'
}

export const usePublicServersStore = defineStore('publicServers', {
  state: (): PublicServersState => ({
    servers: [],
    searchResults: [],
    categories: [
      'Gaming',
      'Technology',
      'Art & Design',
      'Music',
      'Education',
      'Entertainment',
      'Community',
      'Science',
      'Sports',
      'Other'
    ],
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
      return state.servers.filter(server => server.is_featured).slice(0, 6)
    },

    serversByCategory: (state) => {
      const grouped: Record<string, PublicServerWithStats[]> = {}
      
      state.servers.forEach(server => {
        const category = server.category || 'Other'
        if (!grouped[category]) {
          grouped[category] = []
        }
        grouped[category].push(server)
      })
      
      return grouped
    },

    totalServers: (state) => state.servers.length,
    
    isEmpty: (state) => state.hasLoaded && state.servers.length === 0,
    
    isEmptySearch: (state) => state.searchQuery && state.searchResults.length === 0,

    // Check if data is stale (older than 5 minutes)
    isDataStale: (state) => {
      if (!state.lastFetchTime) return true
      return Date.now() - state.lastFetchTime > 5 * 60 * 1000
    }
  },

  actions: {
    async fetchPublicServers(force = false): Promise<void> {
      // Skip if already loading, but be more aggressive on first load or when forced
      if (this.isLoading) {
        return
      }

      // For first-time loads or empty server lists, always fetch
      // This ensures new users see servers immediately after profile creation
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
        const { data, error } = await supabase
          .from('servers')
          .select(`
            id,
            name,
            description,
            icon,
            owner,
            public,
            allow_cross_server_emojis,
            created_at,
            member_count:user_servers(count)
          `)
          .eq('public', true)
          .order('created_at', { ascending: false })
          .limit(100)

        if (error) throw error

        // Process the data to include member counts and categories
        this.servers = (data || []).map(server => ({
          ...server,
          member_count: Array.isArray(server.member_count) ? server.member_count.length : 0,
          category: this.inferCategory(server.name, server.description),
          is_featured: Math.random() > 0.8, // Mock featured status
          last_activity: new Date().toISOString(),
          allow_cross_server_emojis: server.allow_cross_server_emojis || false
        }))

        this.hasLoaded = true
        this.lastFetchTime = Date.now()
        
        console.log(`✅ Loaded ${this.servers.length} public servers`)
      } catch (error) {
        console.error('❌ Error fetching public servers:', error)
        this.error = 'Failed to load servers. Please try again.'
      } finally {
        this.isLoading = false
      }
    },

    async searchServers(query: string): Promise<void> {
      this.searchQuery = query.trim()
      
      if (!this.searchQuery) {
        this.searchResults = []
        this.isSearching = false
        return
      }

      this.isSearching = true
      this.error = null

      try {
        const { data, error } = await supabase
          .from('servers')
          .select(`
            id,
            name,
            description,
            icon,
            owner,
            public,
            allow_cross_server_emojis,
            created_at,
            member_count:user_servers(count)
          `)
          .eq('public', true)
          .or(`name.ilike.%${this.searchQuery}%,description.ilike.%${this.searchQuery}%`)
          .order('name')
          .limit(50)

        if (error) throw error

        this.searchResults = (data || []).map(server => ({
          ...server,
          member_count: Array.isArray(server.member_count) ? server.member_count.length : 0,
          category: this.inferCategory(server.name, server.description),
          is_featured: false,
          last_activity: new Date().toISOString(),
          allow_cross_server_emojis: server.allow_cross_server_emojis || false
        }))

        // console.log(`🔍 Found ${this.searchResults.length} servers matching "${this.searchQuery}"`)
      } catch (error) {
        console.error('❌ Error searching servers:', error)
        this.error = 'Search failed. Please try again.'
      } finally {
        this.isSearching = false
      }
    },

    setSelectedCategory(category: string | null): void {
      this.selectedCategory = category
    },

    clearSearch(): void {
      this.searchQuery = ''
      this.searchResults = []
      this.isSearching = false
    },

    clearError(): void {
      this.error = null
    },

    // Force refresh servers - useful for new user flows and manual refresh
    async forceRefresh(): Promise<void> {
      this.hasLoaded = false
      this.lastFetchTime = null
      await this.fetchPublicServers(true)
    },

    // Check if we need fresh data (for reactive components)
    needsFreshData(): boolean {
      return !this.hasLoaded || this.servers.length === 0 || this.isDataStale
    },

    // Helper method to infer server category from name/description
    inferCategory(name: string, description?: string): string {
      const text = `${name} ${description || ''}`.toLowerCase()
      
      const categoryKeywords = {
        'Gaming': ['game', 'gaming', 'minecraft', 'league', 'wow', 'steam', 'esports'],
        'Technology': ['tech', 'programming', 'code', 'dev', 'ai', 'crypto', 'blockchain'],
        'Art & Design': ['art', 'design', 'creative', 'drawing', 'artist', 'graphics'],
        'Music': ['music', 'band', 'song', 'audio', 'sound', 'musician'],
        'Education': ['school', 'study', 'learn', 'education', 'homework', 'university'],
        'Entertainment': ['movie', 'tv', 'show', 'entertainment', 'fun', 'meme'],
        'Community': ['community', 'social', 'chat', 'friends', 'hangout'],
        'Science': ['science', 'research', 'physics', 'chemistry', 'biology', 'math'],
        'Sports': ['sport', 'football', 'basketball', 'soccer', 'fitness', 'workout']
      }

      for (const [category, keywords] of Object.entries(categoryKeywords)) {
        if (keywords.some(keyword => text.includes(keyword))) {
          return category
        }
      }

      return 'Other'
    },

    // Reset the store state
    reset(): void {
      this.servers = []
      this.searchResults = []
      this.searchQuery = ''
      this.selectedCategory = null
      this.error = null
      this.hasLoaded = false
      this.lastFetchTime = null
      this.isLoading = false
      this.isSearching = false
    }
  }
})
