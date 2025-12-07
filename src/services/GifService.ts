/**
 * GifService - User GIF favorites management
 * 
 * Handles CRUD operations for user's favorite GIFs.
 * Supports GIFs from any source (Tenor, Giphy, or direct URLs).
 * Uses Supabase for storage with RLS policies ensuring users
 * can only access their own favorites.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import type { Gif } from '@/types'

// Database row type for gif_favorites table
export interface GifFavorite {
  id: string
  user_id: string
  gif_url: string
  preview_url: string
  title: string | null
  created_at: string
}

// Simplified type for favorites (same as database row)
export type FavoriteGif = GifFavorite

export class GifService {
  private static instance: GifService
  
  // Local cache of favorite URLs for quick lookups
  private favoriteUrls: Set<string> = new Set()
  private cacheInitialized = false

  static getInstance(): GifService {
    if (!GifService.instance) {
      GifService.instance = new GifService()
    }
    return GifService.instance
  }

  /**
   * Initialize the favorites cache for quick lookups
   */
  async initializeCache(): Promise<void> {
    if (this.cacheInitialized) return

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

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
   */
  async addFavoriteByUrl(
    gifUrl: string, 
    previewUrl: string, 
    title: string | null = null
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        return { success: false, error: 'User not authenticated' }
      }

      // Get user's profile ID
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', user.id)
        .single()

      if (profileError || !profile) {
        return { success: false, error: 'User profile not found' }
      }

      const { error } = await supabase
        .from('gif_favorites')
        .insert({
          user_id: profile.id,
          gif_url: gifUrl,
          preview_url: previewUrl,
          title: title
        })

      if (error) {
        // Handle unique constraint violation (already favorited)
        if (error.code === '23505') {
          return { success: false, error: 'GIF already in favorites' }
        }
        debug.error('Failed to add GIF to favorites:', error)
        return { success: false, error: error.message }
      }

      // Update local cache
      this.favoriteUrls.add(gifUrl)
      
      debug.log(`✅ Added GIF to favorites: ${gifUrl.substring(0, 50)}...`)
      return { success: true }
    } catch (error) {
      debug.error('Error adding GIF to favorites:', error)
      return { success: false, error: 'Failed to add to favorites' }
    }
  }

  /**
   * Remove a GIF from favorites by URL
   */
  async removeFavoriteByUrl(gifUrl: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
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

      // Update local cache
      this.favoriteUrls.delete(gifUrl)
      
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
    title: string | null = null
  ): Promise<{ isFavorite: boolean; error?: string }> {
    const isCurrentlyFavorite = this.isFavoriteByUrl(gifUrl)
    
    if (isCurrentlyFavorite) {
      const result = await this.removeFavoriteByUrl(gifUrl)
      return { isFavorite: !result.success, error: result.error }
    } else {
      const result = await this.addFavoriteByUrl(gifUrl, previewUrl, title)
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
  async removeFavorite(tenorId: string): Promise<{ success: boolean; error?: string }> {
    // This method is kept for backwards compatibility but should use removeFavoriteByUrl
    debug.warn('removeFavorite(tenorId) is deprecated, use removeFavoriteByUrl(gifUrl)')
    // We can't easily map tenorId to URL, so this will need to be updated at call sites
    return { success: false, error: 'Use removeFavoriteByUrl instead' }
  }

  /**
   * Get all user's favorite GIFs
   */
  async getFavorites(): Promise<FavoriteGif[]> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
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

      // Update cache while we have the data
      this.favoriteUrls = new Set((data || []).map(f => f.gif_url))
      this.cacheInitialized = true

      return (data || []) as FavoriteGif[]
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
  }
}

// Export singleton instance
export const gifService = GifService.getInstance()
