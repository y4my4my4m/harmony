import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import type { Server } from '@/types'
import { debug } from '@/utils/debug'

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
      const pinned = state.servers
        .filter(server => server.is_featured)
        .sort((a, b) => (((a as any).featured_order) || 0) - (((b as any).featured_order) || 0))

      if (pinned.length >= 6) return pinned.slice(0, 6)

      const remaining = state.servers
        .filter(s => !s.is_featured)
        .sort(() => Math.random() - 0.5)
        .slice(0, 6 - pinned.length)

      return [...pinned, ...remaining]
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
    
    isEmptySearch: (state) => !!state.searchQuery && state.searchResults.length === 0,

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
        debug.log('🔄 Fetching public servers...')

        const { data, error } = await supabase
          .from('servers')
          .select(`
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
          `)
          .eq('public', true)
          .neq('is_local_server', false)
          .order('created_at', { ascending: false })
          .limit(100)

        if (error) {
          debug.error('❌ Supabase query error:', error)
          throw error
        }

        debug.log(`📊 Fetched ${data?.length || 0} servers from database`)

        if (!data && this.servers.length === 0) {
          debug.log('⚠️ No servers in database, providing demo servers')
          this.servers = [
            {
              id: 'demo-1',
              name: 'Harmony Official',
              description: 'Welcome to the official Harmony community! Join us for updates, help, and general chat.',
              icon: '/img/app_icon_square.webp',
              owner: 'system',
              public: true,
              allow_cross_server_emojis: true,
              created_at: new Date().toISOString(),
              member_count: 42,
              category: 'Community',
              is_featured: true,
              last_activity: new Date().toISOString()
            },
            {
              id: 'demo-2', 
              name: 'Gaming Hub',
              description: 'A place for gamers to connect, share, and play together across all platforms.',
              icon: '/default_server.webp',
              owner: 'system',
              public: true,
              allow_cross_server_emojis: false,
              created_at: new Date().toISOString(),
              member_count: 127,
              category: 'Gaming',
              is_featured: false,
              last_activity: new Date().toISOString()
            }
          ];
        } else {
          const serverList = data || []

          let memberCounts = new Map<string, number>()
          try {
            const { getServerMemberCounts } = await import('@/services/serverMembershipService')
            memberCounts = await getServerMemberCounts(serverList.map(s => s.id))
          } catch (memberError) {
            debug.warn('⚠️ Could not batch get member counts:', memberError)
          }

          this.servers = serverList.map(server => {
            const memberCount = memberCounts.get(server.id) || 0

            return {
              ...server,
              member_count: memberCount,
              category: this.inferCategory(server.name, server.description),
              is_featured: server.is_featured || false,
              last_activity: new Date().toISOString(),
              allow_cross_server_emojis: server.allow_cross_server_emojis || false
            }
          })
        }

        this.hasLoaded = true
        this.lastFetchTime = Date.now()
        
        debug.log(`✅ Successfully loaded ${this.servers.length} public servers`)
      } catch (error) {
        debug.error('❌ Error fetching public servers:', error)
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
        debug.log(`🔍 Searching for "${this.searchQuery}"...`)

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
            created_at
          `)
          .eq('public', true)
          .or(`name.ilike.%${this.searchQuery}%,description.ilike.%${this.searchQuery}%`)
          .order('name')
          .limit(50)

        if (error) {
          debug.error('❌ Search query error:', error)
          throw error
        }

        this.searchResults = (data || []).map(server => ({
          ...server,
          member_count: Math.floor(Math.random() * 50) + 1,
          category: this.inferCategory(server.name, server.description),
          is_featured: false,
          last_activity: new Date().toISOString(),
          allow_cross_server_emojis: server.allow_cross_server_emojis || false
        }))

        debug.log(`🔍 Found ${this.searchResults.length} servers matching "${this.searchQuery}"`)
      } catch (error) {
        debug.error('❌ Error searching servers:', error)
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

    async forceRefresh(): Promise<void> {
      this.hasLoaded = false
      this.lastFetchTime = null
      await this.fetchPublicServers(true)
    },

    needsFreshData(): boolean {
      return !this.hasLoaded || this.servers.length === 0 || this.isDataStale
    },

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
