import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { authContextService } from '@/services/AuthContextService'

export interface EmojiFavorite {
  id: string
  user_id: string
  emoji_id: string
  emoji_name: string
  emoji_url: string | null
  emoji_server_id: string | null
  created_at: string
}

const CACHE_TTL = 5 * 60 * 1000

export class EmojiFavoriteService {
  private static instance: EmojiFavoriteService

  private favoriteIds: Set<string> = new Set()
  private cacheInitialized = false

  private favoritesCache: EmojiFavorite[] | null = null
  private favoritesCacheTime = 0
  private pendingFavoritesRequest: Promise<EmojiFavorite[]> | null = null

  static getInstance(): EmojiFavoriteService {
    if (!EmojiFavoriteService.instance) {
      EmojiFavoriteService.instance = new EmojiFavoriteService()
    }
    return EmojiFavoriteService.instance
  }

  async initializeCache(): Promise<void> {
    if (this.cacheInitialized) return

    try {
      const isAuth = await authContextService.isAuthenticated()
      if (!isAuth) return

      const { data, error } = await supabase
        .from('emoji_favorites')
        .select('emoji_id')

      if (error) {
        debug.error('Failed to initialize emoji favorites cache:', error)
        return
      }

      this.favoriteIds = new Set((data || []).map(f => f.emoji_id))
      this.cacheInitialized = true
    } catch (error) {
      debug.error('Error initializing emoji favorites cache:', error)
    }
  }

  async addFavorite(
    emojiId: string,
    emojiName: string,
    emojiUrl: string | null = null,
    emojiServerId: string | null = null
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const context = await authContextService.getCurrentContext()
      if (!context.isAuthenticated) {
        return { success: false, error: 'User not authenticated' }
      }

      const { error } = await supabase
        .from('emoji_favorites')
        .insert({
          user_id: context.profileId,
          emoji_id: emojiId,
          emoji_name: emojiName,
          emoji_url: emojiUrl,
          emoji_server_id: emojiServerId
        })

      if (error) {
        if (error.code === '23505') {
          return { success: false, error: 'Emoji already in favorites' }
        }
        debug.error('Failed to add emoji to favorites:', error)
        return { success: false, error: error.message }
      }

      this.favoriteIds.add(emojiId)
      this.favoritesCache = null
      return { success: true }
    } catch (error) {
      debug.error('Error adding emoji to favorites:', error)
      return { success: false, error: 'Failed to add to favorites' }
    }
  }

  async removeFavorite(emojiId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const isAuth = await authContextService.isAuthenticated()
      if (!isAuth) {
        return { success: false, error: 'User not authenticated' }
      }

      const { error } = await supabase
        .from('emoji_favorites')
        .delete()
        .eq('emoji_id', emojiId)

      if (error) {
        debug.error('Failed to remove emoji from favorites:', error)
        return { success: false, error: error.message }
      }

      this.favoriteIds.delete(emojiId)
      this.favoritesCache = null
      return { success: true }
    } catch (error) {
      debug.error('Error removing emoji from favorites:', error)
      return { success: false, error: 'Failed to remove from favorites' }
    }
  }

  async toggleFavorite(
    emojiId: string,
    emojiName: string,
    emojiUrl: string | null = null,
    emojiServerId: string | null = null
  ): Promise<{ isFavorite: boolean; error?: string }> {
    const isCurrentlyFavorite = this.isFavorite(emojiId)

    if (isCurrentlyFavorite) {
      const result = await this.removeFavorite(emojiId)
      return { isFavorite: !result.success, error: result.error }
    } else {
      const result = await this.addFavorite(emojiId, emojiName, emojiUrl, emojiServerId)
      return { isFavorite: result.success, error: result.error }
    }
  }

  async getFavorites(): Promise<EmojiFavorite[]> {
    const now = Date.now()
    if (this.favoritesCache && (now - this.favoritesCacheTime) < CACHE_TTL) {
      return this.favoritesCache
    }

    if (this.pendingFavoritesRequest) {
      return this.pendingFavoritesRequest
    }

    this.pendingFavoritesRequest = this._fetchFavorites()

    try {
      return await this.pendingFavoritesRequest
    } finally {
      this.pendingFavoritesRequest = null
    }
  }

  private async _fetchFavorites(): Promise<EmojiFavorite[]> {
    try {
      const isAuth = await authContextService.isAuthenticated()
      if (!isAuth) return []

      const { data, error } = await supabase
        .from('emoji_favorites')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) {
        debug.error('Failed to get emoji favorites:', error)
        return []
      }

      const favorites = (data || []) as EmojiFavorite[]

      this.favoritesCache = favorites
      this.favoritesCacheTime = Date.now()
      this.favoriteIds = new Set(favorites.map(f => f.emoji_id))
      this.cacheInitialized = true

      return favorites
    } catch (error) {
      debug.error('Error getting emoji favorites:', error)
      return []
    }
  }

  isFavorite(emojiId: string): boolean {
    return this.favoriteIds.has(emojiId)
  }

  async isFavoriteAsync(emojiId: string): Promise<boolean> {
    if (!this.cacheInitialized) {
      await this.initializeCache()
    }
    return this.favoriteIds.has(emojiId)
  }

  clearCache(): void {
    this.favoriteIds.clear()
    this.cacheInitialized = false
    this.favoritesCache = null
    this.favoritesCacheTime = 0
    this.pendingFavoritesRequest = null
  }
}

export const emojiFavoriteService = EmojiFavoriteService.getInstance()
