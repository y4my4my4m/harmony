/**
 * GifService - User GIF favorites management
 * 
 * Handles CRUD operations for user's favorite GIFs.
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
  tenor_id: string
  gif_url: string
  preview_url: string
  title: string | null
  created_at: string
}

// Simplified Gif type for favorites (we store minimal data)
export interface FavoriteGif {
  id: string // our database id
  tenor_id: string
  gif_url: string
  preview_url: string
  title: string | null
  created_at: string
}

export class GifService {
  private static instance: GifService
  
  // Local cache for quick isFavorite checks
  private favoriteTenorIds: Set<string> = new Set()
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
        .select('tenor_id')

      if (error) {
        debug.error('Failed to initialize GIF favorites cache:', error)
        return
      }

      this.favoriteTenorIds = new Set((data || []).map(f => f.tenor_id))
      this.cacheInitialized = true
      debug.log(`✅ GIF favorites cache initialized: ${this.favoriteTenorIds.size} favorites`)
    } catch (error) {
      debug.error('Error initializing GIF favorites cache:', error)
    }
  }

  /**
   * Add a GIF to favorites
   */
  async addFavorite(gif: Gif): Promise<{ success: boolean; error?: string }> {
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
          tenor_id: gif.id,
          gif_url: gif.media_formats.gif.url,
          preview_url: gif.media_formats.gifpreview.url,
          title: gif.title || null
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
      this.favoriteTenorIds.add(gif.id)
      
      debug.log(`✅ Added GIF to favorites: ${gif.id}`)
      return { success: true }
    } catch (error) {
      debug.error('Error adding GIF to favorites:', error)
      return { success: false, error: 'Failed to add to favorites' }
    }
  }

  /**
   * Remove a GIF from favorites
   */
  async removeFavorite(tenorId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        return { success: false, error: 'User not authenticated' }
      }

      const { error } = await supabase
        .from('gif_favorites')
        .delete()
        .eq('tenor_id', tenorId)

      if (error) {
        debug.error('Failed to remove GIF from favorites:', error)
        return { success: false, error: error.message }
      }

      // Update local cache
      this.favoriteTenorIds.delete(tenorId)
      
      debug.log(`✅ Removed GIF from favorites: ${tenorId}`)
      return { success: true }
    } catch (error) {
      debug.error('Error removing GIF from favorites:', error)
      return { success: false, error: 'Failed to remove from favorites' }
    }
  }

  /**
   * Toggle a GIF's favorite status
   */
  async toggleFavorite(gif: Gif): Promise<{ isFavorite: boolean; error?: string }> {
    const isCurrentlyFavorite = this.isFavorite(gif.id)
    
    if (isCurrentlyFavorite) {
      const result = await this.removeFavorite(gif.id)
      return { isFavorite: !result.success, error: result.error }
    } else {
      const result = await this.addFavorite(gif)
      return { isFavorite: result.success, error: result.error }
    }
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
      this.favoriteTenorIds = new Set((data || []).map(f => f.tenor_id))
      this.cacheInitialized = true

      return (data || []).map(row => ({
        id: row.id,
        tenor_id: row.tenor_id,
        gif_url: row.gif_url,
        preview_url: row.preview_url,
        title: row.title,
        created_at: row.created_at
      }))
    } catch (error) {
      debug.error('Error getting GIF favorites:', error)
      return []
    }
  }

  /**
   * Check if a GIF is favorited (uses local cache for speed)
   */
  isFavorite(tenorId: string): boolean {
    return this.favoriteTenorIds.has(tenorId)
  }

  /**
   * Check if a GIF is favorited (async version that ensures cache is initialized)
   */
  async isFavoriteAsync(tenorId: string): Promise<boolean> {
    if (!this.cacheInitialized) {
      await this.initializeCache()
    }
    return this.favoriteTenorIds.has(tenorId)
  }

  /**
   * Convert a FavoriteGif to Gif format for display/sending
   */
  favoriteToGif(favorite: FavoriteGif): Gif {
    return {
      id: favorite.tenor_id,
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
    this.favoriteTenorIds.clear()
    this.cacheInitialized = false
  }
}

// Export singleton instance
export const gifService = GifService.getInstance()

