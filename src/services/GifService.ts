/**
 * GifService - User GIF favorites management
 * 
 * Handles CRUD operations for user's favorite GIFs.
 * Supports GIFs from any source (Tenor, Giphy, or direct URLs).
 * Uses Supabase for storage with RLS policies ensuring users
 * can only access their own favorites.
 * 
 * OPTIMIZED: Uses AuthContextService for auth, caches favorites globally,
 * and deduplicates concurrent requests.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { authContextService } from '@/services/AuthContextService'
import type { Gif } from '@/types'

// Database row type for gif_favorites table
export type GifMediaType = 'gif' | 'sticker' | 'clip' | 'meme' | 'ai-emoji'

export interface GifFavorite {
  id: string
  user_id: string
  gif_url: string
  preview_url: string
  title: string | null
  created_at: string
  /** Distinguishes GIF favorites from sticker favorites. Defaults to 'gif'. */
  media_type?: GifMediaType
  /** True for AI emoji the user generated (vs. browsed-and-favorited). */
  is_generated?: boolean
  /**
   * Tenor's stable GIF identifier. Populated for Tenor-sourced favorites;
   * absent for direct-URL favorites. Surfaced to consumers (GifComponent)
   * for hover-preview keying and de-duplication.
   */
  tenor_id?: string
}

// Simplified type for favorites (same as database row)
export type FavoriteGif = GifFavorite

// Cache TTL: 5 minutes
const CACHE_TTL = 5 * 60 * 1000

export class GifService {
  private static instance: GifService
  
  // Local cache of favorite URLs for quick lookups
  private favoriteUrls: Set<string> = new Set()
  private cacheInitialized = false
  
  // Full favorites cache with TTL
  private favoritesCache: FavoriteGif[] | null = null
  private favoritesCacheTime = 0
  private pendingFavoritesRequest: Promise<FavoriteGif[]> | null = null

  static getInstance(): GifService {
    if (!GifService.instance) {
      GifService.instance = new GifService()
    }
    return GifService.instance
  }

  /**
   * Initialize the favorites cache for quick lookups
   * OPTIMIZED: Uses AuthContextService instead of direct auth call
   */
  async initializeCache(): Promise<void> {
    if (this.cacheInitialized) return

    try {
      const isAuth = await authContextService.isAuthenticated()
      if (!isAuth) return

      const { data, error } = await supabase
        .from('gif_favorites')
        .select('gif_url')

      if (error) {
        debug.error('Failed to initialize GIF favorites cache:', error)
        return
      }

      this.favoriteUrls = new Set((data || []).map(f => f.gif_url))
      this.cacheInitialized = true
      debug.log(`✅ GIF favorites cache initialized: ${this.favoriteUrls.size} favorites`)
    } catch (error) {
      debug.error('Error initializing GIF favorites cache:', error)
    }
  }

  /**
   * Add a GIF to favorites by URL
   * OPTIMIZED: Uses AuthContextService for cached profile ID
   */
  async addFavoriteByUrl(
    gifUrl: string, 
    previewUrl: string, 
    title: string | null = null,
    mediaType: GifMediaType = 'gif'
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const context = await authContextService.getCurrentContext()
      if (!context.isAuthenticated) {
        return { success: false, error: 'User not authenticated' }
      }

      const { error } = await supabase
        .from('gif_favorites')
        .insert({
          user_id: context.profileId,
          gif_url: gifUrl,
          preview_url: previewUrl,
          title: title,
          media_type: mediaType
        })

      if (error) {
        // Handle unique constraint violation (already favorited)
        if (error.code === '23505') {
          return { success: false, error: 'GIF already in favorites' }
        }
        debug.error('Failed to add GIF to favorites:', error)
        return { success: false, error: error.message }
      }

      // Update local caches
      this.favoriteUrls.add(gifUrl)
      // Invalidate full cache so next getFavorites() refreshes
      this.favoritesCache = null
      
      debug.log(`✅ Added GIF to favorites: ${gifUrl.substring(0, 50)}...`)
      return { success: true }
    } catch (error) {
      debug.error('Error adding GIF to favorites:', error)
      return { success: false, error: 'Failed to add to favorites' }
    }
  }

  /**
   * Remove a GIF from favorites by URL
   * OPTIMIZED: Uses AuthContextService for cached auth check
   */
  async removeFavoriteByUrl(gifUrl: string): Promise<{ success: boolean; error?: string }> {
    try {
      const isAuth = await authContextService.isAuthenticated()
      if (!isAuth) {
        return { success: false, error: 'User not authenticated' }
      }

      const { error } = await supabase
        .from('gif_favorites')
        .delete()
        .eq('gif_url', gifUrl)

      if (error) {
        debug.error('Failed to remove GIF from favorites:', error)
        return { success: false, error: error.message }
      }

      // Update local caches
      this.favoriteUrls.delete(gifUrl)
      // Invalidate full cache so next getFavorites() refreshes
      this.favoritesCache = null
      
      debug.log(`✅ Removed GIF from favorites: ${gifUrl.substring(0, 50)}...`)
      return { success: true }
    } catch (error) {
      debug.error('Error removing GIF from favorites:', error)
      return { success: false, error: 'Failed to remove from favorites' }
    }
  }

  /**
   * Toggle a GIF's favorite status by URL
   */
  async toggleFavoriteByUrl(
    gifUrl: string, 
    previewUrl: string, 
    title: string | null = null,
    mediaType: GifMediaType = 'gif'
  ): Promise<{ isFavorite: boolean; error?: string }> {
    const isCurrentlyFavorite = this.isFavoriteByUrl(gifUrl)
    
    if (isCurrentlyFavorite) {
      const result = await this.removeFavoriteByUrl(gifUrl)
      return { isFavorite: !result.success, error: result.error }
    } else {
      const result = await this.addFavoriteByUrl(gifUrl, previewUrl, title, mediaType)
      return { isFavorite: result.success, error: result.error }
    }
  }

  /**
   * Legacy method: Toggle favorite for a Tenor Gif object
   */
  async toggleFavorite(gif: Gif): Promise<{ isFavorite: boolean; error?: string }> {
    return this.toggleFavoriteByUrl(
      gif.media_formats.gif.url,
      gif.media_formats.gifpreview.url,
      gif.title || null
    )
  }

  /**
   * Legacy method: Add a Tenor Gif to favorites
   */
  async addFavorite(gif: Gif): Promise<{ success: boolean; error?: string }> {
    return this.addFavoriteByUrl(
      gif.media_formats.gif.url,
      gif.media_formats.gifpreview.url,
      gif.title || null
    )
  }

  /**
   * Legacy method: Remove favorite by Tenor ID (now removes by URL)
   */
  async removeFavorite(_tenorId: string): Promise<{ success: boolean; error?: string }> {
    // This method is kept for backwards compatibility but should use removeFavoriteByUrl
    debug.warn('removeFavorite(tenorId) is deprecated, use removeFavoriteByUrl(gifUrl)')
    // We can't easily map tenorId to URL, so this will need to be updated at call sites
    return { success: false, error: 'Use removeFavoriteByUrl instead' }
  }

  /**
   * Get all user's favorite GIFs
   * OPTIMIZED: Caches results with TTL, deduplicates concurrent requests,
   * uses AuthContextService for auth
   */
  async getFavorites(mediaType?: GifMediaType): Promise<FavoriteGif[]> {
    // Return cached data if still valid
    const now = Date.now()
    if (this.favoritesCache && (now - this.favoritesCacheTime) < CACHE_TTL) {
      return this.filterByType(this.favoritesCache, mediaType)
    }
    
    // Deduplicate concurrent requests
    if (this.pendingFavoritesRequest) {
      return this.filterByType(await this.pendingFavoritesRequest, mediaType)
    }
    
    this.pendingFavoritesRequest = this._fetchFavorites()
    
    try {
      const result = await this.pendingFavoritesRequest
      return this.filterByType(result, mediaType)
    } finally {
      this.pendingFavoritesRequest = null
    }
  }

  /** Rows missing media_type are legacy GIF favorites (column added later). */
  private filterByType(rows: FavoriteGif[], mediaType?: GifMediaType): FavoriteGif[] {
    if (!mediaType) return rows
    return rows.filter(r => (r.media_type ?? 'gif') === mediaType)
  }

  /**
   * The user's AI emoji generation history (newest first). Generated emoji are
   * stored as gif_favorites rows with is_generated = true.
   */
  async getGenerated(): Promise<FavoriteGif[]> {
    const all = await this.getFavorites('ai-emoji')
    return all.filter(r => r.is_generated === true)
  }

  /** Drop the cached favorites so the next read reflects a new generation. */
  invalidateCache(): void {
    this.favoritesCache = null
    this.favoritesCacheTime = 0
  }
  
  /**
   * Internal method to actually fetch favorites from DB
   */
  private async _fetchFavorites(): Promise<FavoriteGif[]> {
    try {
      const isAuth = await authContextService.isAuthenticated()
      if (!isAuth) {
        debug.warn('Cannot get favorites: User not authenticated')
        return []
      }

      const { data, error } = await supabase
        .from('gif_favorites')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) {
        debug.error('Failed to get GIF favorites:', error)
        return []
      }

      const favorites = (data || []) as FavoriteGif[]
      
      // Update caches
      this.favoritesCache = favorites
      this.favoritesCacheTime = Date.now()
      this.favoriteUrls = new Set(favorites.map(f => f.gif_url))
      this.cacheInitialized = true

      debug.log(`📋 GIF favorites loaded: ${favorites.length} items (cached for ${CACHE_TTL / 1000}s)`)
      return favorites
    } catch (error) {
      debug.error('Error getting GIF favorites:', error)
      return []
    }
  }

  /**
   * Check if a GIF URL is favorited (uses local cache for speed)
   */
  isFavoriteByUrl(gifUrl: string): boolean {
    return this.favoriteUrls.has(gifUrl)
  }

  /**
   * Check if a GIF URL is favorited (async version that ensures cache is initialized)
   */
  async isFavoriteByUrlAsync(gifUrl: string): Promise<boolean> {
    if (!this.cacheInitialized) {
      await this.initializeCache()
    }
    return this.favoriteUrls.has(gifUrl)
  }

  /**
   * Convert a FavoriteGif to Gif format for display/sending
   */
  favoriteToGif(favorite: FavoriteGif): Gif {
    return {
      id: favorite.id,
      media_formats: {
        gif: { url: favorite.gif_url },
        gifpreview: { url: favorite.preview_url },
        // These won't be available for favorites, but provide fallbacks
        mp4: { url: favorite.gif_url },
        webm: { url: favorite.gif_url }
      },
      title: favorite.title || undefined
    }
  }

  /**
   * Clear the local cache (useful when user logs out)
   */
  clearCache(): void {
    this.favoriteUrls.clear()
    this.cacheInitialized = false
    this.favoritesCache = null
    this.favoritesCacheTime = 0
    this.pendingFavoritesRequest = null
    debug.log('🧹 GIF favorites cache cleared')
  }
}

// Export singleton instance
export const gifService = GifService.getInstance()
