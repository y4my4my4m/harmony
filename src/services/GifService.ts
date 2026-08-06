/**
 * User GIF favorites: CRUD over the `gif_favorites` table.
 * Accepts GIFs from any source (Tenor, Giphy, direct URLs).
 * RLS restricts each user to their own rows.
 *
 * Auth goes through AuthContextService. Favorites are cached process-wide
 * with a TTL and concurrent fetches are deduplicated.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { authContextService } from '@/services/AuthContextService'
import type { Gif } from '@/types'

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
  /**
   * Tenor's stable GIF identifier. Present for Tenor-sourced favorites,
   * absent for direct-URL ones. GifComponent keys hover-preview and
   * de-duplication off it.
   */
  tenor_id?: string
}

export type FavoriteGif = GifFavorite

const CACHE_TTL = 5 * 60 * 1000

export class GifService {
  private static instance: GifService
  
  // URL-only set backing the synchronous isFavoriteByUrl lookup.
  private favoriteUrls: Set<string> = new Set()
  private cacheInitialized = false
  
  // Full rows, valid for CACHE_TTL.
  private favoritesCache: FavoriteGif[] | null = null
  private favoritesCacheTime = 0
  private pendingFavoritesRequest: Promise<FavoriteGif[]> | null = null

  static getInstance(): GifService {
    if (!GifService.instance) {
      GifService.instance = new GifService()
    }
    return GifService.instance
  }

  /** Populates favoriteUrls. No-op when already initialized or unauthenticated. */
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
      debug.log(`GIF favorites cache initialized: ${this.favoriteUrls.size} favorites`)
    } catch (error) {
      debug.error('Error initializing GIF favorites cache:', error)
    }
  }

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
        if (error.code === '23505') {
          return { success: false, error: 'GIF already in favorites' }
        }
        debug.error('Failed to add GIF to favorites:', error)
        return { success: false, error: error.message }
      }

      this.favoriteUrls.add(gifUrl)
      // Invalidate the full cache; next getFavorites() refetches.
      this.favoritesCache = null
      
      debug.log(`Added GIF to favorites: ${gifUrl.substring(0, 50)}...`)
      return { success: true }
    } catch (error) {
      debug.error('Error adding GIF to favorites:', error)
      return { success: false, error: 'Failed to add to favorites' }
    }
  }

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

      this.favoriteUrls.delete(gifUrl)
      // Invalidate the full cache; next getFavorites() refetches.
      this.favoritesCache = null
      
      debug.log(`Removed GIF from favorites: ${gifUrl.substring(0, 50)}...`)
      return { success: true }
    } catch (error) {
      debug.error('Error removing GIF from favorites:', error)
      return { success: false, error: 'Failed to remove from favorites' }
    }
  }

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

  /** Legacy: takes a Tenor Gif object instead of URLs. */
  async toggleFavorite(gif: Gif): Promise<{ isFavorite: boolean; error?: string }> {
    return this.toggleFavoriteByUrl(
      gif.media_formats.gif.url,
      gif.media_formats.gifpreview.url,
      gif.title || null
    )
  }

  /** Legacy: takes a Tenor Gif object instead of URLs. */
  async addFavorite(gif: Gif): Promise<{ success: boolean; error?: string }> {
    return this.addFavoriteByUrl(
      gif.media_formats.gif.url,
      gif.media_formats.gifpreview.url,
      gif.title || null
    )
  }

  /**
   * Deprecated. Always fails: favorites are keyed by URL and tenorId cannot be
   * mapped back to one. Call sites must use removeFavoriteByUrl.
   */
  async removeFavorite(_tenorId: string): Promise<{ success: boolean; error?: string }> {
    debug.warn('removeFavorite(tenorId) is deprecated, use removeFavoriteByUrl(gifUrl)')
    return { success: false, error: 'Use removeFavoriteByUrl instead' }
  }

  /** Served from the TTL cache when warm; concurrent misses share one fetch. */
  async getFavorites(mediaType?: GifMediaType): Promise<FavoriteGif[]> {
    const now = Date.now()
    if (this.favoritesCache && (now - this.favoritesCacheTime) < CACHE_TTL) {
      return this.filterByType(this.favoritesCache, mediaType)
    }
    
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
      
      this.favoritesCache = favorites
      this.favoritesCacheTime = Date.now()
      this.favoriteUrls = new Set(favorites.map(f => f.gif_url))
      this.cacheInitialized = true

      debug.log(`GIF favorites loaded: ${favorites.length} items (cached for ${CACHE_TTL / 1000}s)`)
      return favorites
    } catch (error) {
      debug.error('Error getting GIF favorites:', error)
      return []
    }
  }

  /** Reads the local set only; stale until initializeCache or getFavorites runs. */
  isFavoriteByUrl(gifUrl: string): boolean {
    return this.favoriteUrls.has(gifUrl)
  }

  /** isFavoriteByUrl, initializing the cache first. */
  async isFavoriteByUrlAsync(gifUrl: string): Promise<boolean> {
    if (!this.cacheInitialized) {
      await this.initializeCache()
    }
    return this.favoriteUrls.has(gifUrl)
  }

  favoriteToGif(favorite: FavoriteGif): Gif {
    return {
      id: favorite.id,
      media_formats: {
        gif: { url: favorite.gif_url },
        gifpreview: { url: favorite.preview_url },
        // Favorites store no video variants; fall back to the GIF URL.
        mp4: { url: favorite.gif_url },
        webm: { url: favorite.gif_url }
      },
      title: favorite.title || undefined
    }
  }

  /** Call on logout. */
  clearCache(): void {
    this.favoriteUrls.clear()
    this.cacheInitialized = false
    this.favoritesCache = null
    this.favoritesCacheTime = 0
    this.pendingFavoritesRequest = null
    debug.log('GIF favorites cache cleared')
  }
}

export const gifService = GifService.getInstance()
