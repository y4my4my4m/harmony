/**
 * ProfileService - Simple profile management (LOCAL-FIRST)
 * 
 * SIMPLIFIED: Trust database triggers for federation, focus on local operations
 * - Simple direct Supabase operations
 * - No complex federation service calls  
 * - Trust database triggers for ActivityPub handling
 * 
 * PRESERVED: All existing APIs and return types
 */

import { getActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { userDataService } from './userDataService'
import { authContextService } from './AuthContextService'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import type { Profile, ProfileField } from '@/types'
import { debug } from '@/utils/debug'

export interface ProfileData {
  username?: string
  display_name?: string
  avatar_url?: string
  banner_url?: string
  bio?: string
  color?: string
  /**
   * Custom profile fields (name/value link rows). Persisted to the
   * `profiles.profile_fields` jsonb column; federated outbound as
   * PropertyValue attachments on the actor (see toActivityPub.ts).
   * Pass an empty array to clear all fields.
   */
  profile_fields?: ProfileField[]
}

export interface ProfileServiceError {
  code: string
  message: string
  details?: any
}

export class ProfileService {
  private static instance: ProfileService
  // Request deduplication: track pending profile fetches
  private pendingFetches = new Map<string, Promise<Profile | null>>()
  // Cache: store recently fetched profiles with TTL
  private cache = new Map<string, { profile: Profile; timestamp: number }>()
  private readonly CACHE_TTL = 2 * 60 * 1000 // 2 minutes

  static getInstance(): ProfileService {
    if (!ProfileService.instance) {
      ProfileService.instance = new ProfileService()
    }
    return ProfileService.instance
  }

  /**
   * Get current user's profile
   * Uses AuthContextService for efficient auth lookup
   */
  async getCurrentProfile(): Promise<Profile> {
    try {
      const context = await authContextService.getCurrentContext()
      if (!context.isAuthenticated) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', context.profileId)
        .single()

      if (error || !profile) {
        throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')
      }

      return profile
    } catch (error) {
      debug.error('❌ Failed to get current profile:', error)
      throw error
    }
  }

  /**
   * Update current user's profile (database triggers handle federation)
   * Uses AuthContextService for efficient auth lookup
   */
  async updateCurrentProfile(updates: ProfileData): Promise<Profile> {
    try {
      const context = await authContextService.getCurrentContext()
      if (!context.isAuthenticated) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      const allowEmojisInDisplayNames = getActivePinia()
        ? useInstanceSettingsStore().settings.allowCustomEmojisInDisplayNames
        : true

      if (updates.display_name && !allowEmojisInDisplayNames && /:([a-zA-Z0-9_+-]+):/.test(updates.display_name)) {
        throw this.createError('INVALID_INPUT', 'Custom emojis in display names are disabled on this instance. Please remove emoji shortcodes from your display name.')
      }

      // Pre-resolve display_name emojis for federation (only when allowed)
      const finalUpdates: any = { ...updates }
      if (updates.display_name) {
        const { data: existing } = await supabase
          .from('profiles')
          .select('federation_metadata')
          .eq('id', context.profileId)
          .single()
        const rawMeta = existing?.federation_metadata
        const meta = (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta) || {}

        if (allowEmojisInDisplayNames) {
          const displayNameEmojis = await this.resolveDisplayNameEmojis(updates.display_name)
          finalUpdates.federation_metadata = { ...meta, display_name_emojis: displayNameEmojis }
        } else {
          finalUpdates.federation_metadata = { ...meta, display_name_emojis: [] }
        }
      }

      const { data: profile, error } = await supabase
        .from('profiles')
        .update(finalUpdates)
        .eq('id', context.profileId)
        .select('*')
        .single()

      if (error || !profile) {
        throw this.createError('UPDATE_FAILED', 'Failed to update profile', error)
      }

      // Refresh userDataService cache
      try {
        await userDataService.fetchUserProfile(context.profileId, true)
      } catch (refreshError) {
        debug.warn('⚠️ Failed to refresh userDataService cache:', refreshError)
      }

      return profile
    } catch (error) {
      debug.error('❌ Failed to update profile:', error)
      throw error
    }
  }

  /**
   * Create a new profile (database triggers handle federation)
   */
  async createProfile(profileData: ProfileData & { auth_user_id: string }): Promise<Profile> {
    try {
      const allowEmojisInDisplayNames = getActivePinia()
        ? useInstanceSettingsStore().settings.allowCustomEmojisInDisplayNames
        : true

      // Validate display name emoji limits
      if (profileData.display_name) {
        const emojiMatches = profileData.display_name.match(/:([a-zA-Z0-9_+-]+):/g)
        if (emojiMatches && emojiMatches.length > 5) {
          throw this.createError('INVALID_INPUT', 'Display name can have at most 5 custom emojis')
        }
        if (!allowEmojisInDisplayNames && emojiMatches && emojiMatches.length > 0) {
          throw this.createError('INVALID_INPUT', 'Custom emojis in display names are disabled on this instance.')
        }
      }

      // Pre-resolve display_name emojis for federation metadata
      const finalData: any = { ...profileData }
      if (profileData.display_name && allowEmojisInDisplayNames) {
        const displayNameEmojis = await this.resolveDisplayNameEmojis(profileData.display_name)
        if (displayNameEmojis.length > 0) {
          const rawMeta = finalData.federation_metadata
          const existingMeta = (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta) || {}
          finalData.federation_metadata = { ...existingMeta, display_name_emojis: displayNameEmojis }
        }
      }

      const { data: profile, error } = await supabase
        .from('profiles')
        .insert([finalData])
        .select('*')
        .single()

      if (error || !profile) {
        throw this.createError('CREATE_FAILED', 'Failed to create profile', error)
      }

      // Clear AuthContextService cache. Some earlier call (e.g.
      // `activityPubStore.loadBlockingData()` from auth.ts SIGNED_IN /
      // initializeAuth) may have resolved getCurrentContext BEFORE the
      // profile existed. With the Fix A guard the loader no longer caches
      // the unauthenticated state, but if anything else cached it (e.g. an
      // in-flight `getCurrentContext` from a prior tick) we need a hard
      // invalidation so the very next call - typically the avatar/banner
      // `updateProfile` immediately after this returns - re-fetches and
      // finds the freshly-inserted row.
      authContextService.clearCache()

      // Ensure userDataService has the new profile in cache
      try {
        await userDataService.fetchUserProfile(profile.id, true)
      } catch (initError) {
        debug.warn('⚠️ Failed to refresh userDataService cache:', initError)
      }

      return profile
    } catch (error) {
      debug.error('❌ Failed to create profile:', error)
      throw error
    }
  }

  /**
   * Get profile by ID
   */
  async getProfileById(profileId: string): Promise<Profile> {
    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', profileId)
        .single()

      if (error || !profile) {
        throw this.createError('PROFILE_NOT_FOUND', 'Profile not found')
      }

      return profile
    } catch (error) {
      debug.error('❌ Failed to get profile by ID:', error)
      throw error
    }
  }

  /**
   * Get profile by username
   */
  async getProfileByUsername(username: string, domain?: string): Promise<Profile> {
    try {
      let query = supabase
        .from('profiles')
        .select('*')
        .eq('username', username)

      if (domain) {
        query = query.eq('domain', domain)
      } else {
        query = query.is('domain', null)
      }

      const { data: profile, error } = await query.single()

      if (error || !profile) {
        throw this.createError('PROFILE_NOT_FOUND', 'Profile not found')
      }

      return profile
    } catch (error) {
      debug.error('❌ Failed to get profile by username:', error)
      throw error
    }
  }

  /**
   * Search profiles
   */
  async searchProfiles(
    query: string,
    options: {
      limit?: number;
      offset?: number;
      includeFederated?: boolean;
    } = {}
  ): Promise<{
    profiles: Profile[];
    hasMore: boolean;
    total: number;
  }> {
    try {
      const { limit = 20, offset = 0, includeFederated = true } = options

      let searchQuery = supabase
        .from('profiles')
        .select('*', { count: 'exact' })
        .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
        .range(offset, offset + limit - 1)

      if (!includeFederated) {
        searchQuery = searchQuery.is('domain', null)
      }

      const { data: profiles, error, count } = await searchQuery

      if (error) {
        throw this.createError('SEARCH_FAILED', 'Failed to search profiles', error)
      }

      return {
        profiles: profiles || [],
        hasMore: (count || 0) > offset + limit,
        total: count || 0
      }
    } catch (error) {
      debug.error('❌ Failed to search profiles:', error)
      throw error
    }
  }

  /**
   * Check username availability
   */
  async checkUsernameAvailability(username: string): Promise<{
    available: boolean;
    reason?: string;
  }> {
    try {
      const { data: existing, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', username)
        .limit(1)

      if (error) {
        throw this.createError('CHECK_FAILED', 'Failed to check username availability', error)
      }

      return {
        available: !existing || existing.length === 0
      }
    } catch (error) {
      debug.error('❌ Failed to check username availability:', error)
      throw error
    }
  }

  /**
   * Resolve :shortcode: patterns in a display name to emoji data for federation.
   * Returns an array of { name, url, id } for each resolved custom emoji.
   */
  private async resolveDisplayNameEmojis(displayName: string): Promise<Array<{ name: string; url: string; id: string }>> {
    const regex = /:([a-zA-Z0-9_+-]+):/g
    const shortcodes: string[] = []
    let match: RegExpExecArray | null
    while ((match = regex.exec(displayName)) !== null) {
      shortcodes.push(match[1])
    }
    if (shortcodes.length === 0) return []

    // Only return custom emojis (with image URLs). Unicode emoji entries
    // in the emojis table have url = null and must be excluded so they
    // don't shadow the unified pack or a custom emoji with the same name.
    const { data: emojis } = await supabase
      .from('emojis')
      .select('id, name, url')
      .in('name', shortcodes)
      .not('url', 'is', null)

    return (emojis || []).map((e: any) => ({ name: e.name, url: e.url, id: e.id }))
  }

  private createError(code: string, message: string, details?: any): Error {
    const error = new Error(message) as any
    error.code = code
    error.details = details
    return error
  }

  /**
   * Update user status (for auth.ts and useServerUsers.ts compatibility)
   */
  async updateUserStatus(userId: string, status: number): Promise<any> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .update({ status })
        .eq('id', userId)

      if (error) {
        debug.error('Error updating status:', error)
        throw error
      }
      return data
    } catch (error) {
      debug.error('❌ Failed to update user status:', error)
      throw error
    }
  }

  /**
   * Fetch profile by ID (alias for compatibility with stores)
   * Includes request deduplication and caching
   */
  async fetchProfile(userId: string, useCache = true): Promise<Profile | null> {
    try {
      // Check cache first
      if (useCache) {
        const cached = this.cache.get(userId)
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
          debug.log(`✅ ProfileService: Using cached profile for ${userId}`)
          return cached.profile
        }
      }

      // Check if already fetching this profile
      const pending = this.pendingFetches.get(userId)
      if (pending) {
        debug.log(`⏳ ProfileService: Reusing pending fetch for ${userId}`)
        return pending
      }

      // Create fetch promise
      const fetchPromise = (async () => {
        try {
          const profile = await this.getProfileById(userId)
          // Cache the result
          if (profile && useCache) {
            this.cache.set(userId, { profile, timestamp: Date.now() })
          }
          return profile
        } finally {
          // Remove from pending
          this.pendingFetches.delete(userId)
        }
      })()

      // Track pending fetch
      this.pendingFetches.set(userId, fetchPromise)
      return fetchPromise
    } catch (error: any) {
      if (error.code === 'PROFILE_NOT_FOUND') {
        return null
      }
      throw error
    }
  }

  /**
   * Fetch profile by auth user ID (for store compatibility)
   */
  async fetchProfileByAuthUserId(authUserId: string): Promise<Profile | null> {
    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('auth_user_id', authUserId)
        .maybeSingle()

      if (error && error.code !== 'PGRST116') {
        debug.error('❌ Error fetching profile by auth user ID:', error)
        return null
      }

      return profile || null
    } catch (error) {
      debug.error('❌ Failed to get profile by auth user ID:', error)
      return null
    }
  }

  /**
   * Update profile (alias for updateCurrentProfile for store compatibility)
   */
  async updateProfile(profileData: ProfileData): Promise<Profile> {
    return this.updateCurrentProfile(profileData)
  }

  /**
   * Check if profile is complete (for store compatibility)
   */
  isProfileComplete(profile: Profile | null): boolean {
    return !!(profile && profile.username && profile.display_name)
  }

  /**
   * Get profile with avatar URL (for Vue component compatibility)
   */
  async getProfileWithAvatarUrl(userId: string): Promise<Profile | null> {
    try {
      const profile = await this.getProfileById(userId)
      // Avatar URL should already be included in the profile data
      return profile
    } catch (error: any) {
      if (error.code === 'PROFILE_NOT_FOUND') {
        return null
      }
      throw error
    }
  }

  /**
   * Upload avatar (wrapper for existing utility)
   */
  async uploadAvatar(file: File, userId: string): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
      // Import the utility function dynamically to avoid circular imports
      const { uploadAvatar } = await import('@/utils/fileUpload')
      const result = await uploadAvatar(file, userId)
      
      if (result.success && result.url) {
        // Update the profile with the new avatar URL
        await this.updateCurrentProfile({ avatar_url: result.url })
      }
      
      return {
        success: result.success,
        url: result.url,
        error: result.error
      }
    } catch (error: any) {
      debug.error('❌ Failed to upload avatar:', error)
      return {
        success: false,
        error: error.message || 'Failed to upload avatar'
      }
    }
  }

  /**
   * Upload banner (wrapper for existing utility)
   */
  async uploadBanner(file: File, userId: string): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
      // Import the utility function dynamically to avoid circular imports
      const { uploadBanner } = await import('@/utils/bannerUtils')
      const result = await uploadBanner(file, userId)
      
      if (result.success && result.url) {
        // Update the profile with the new banner URL
        await this.updateCurrentProfile({ banner_url: result.url })
      }
      
      return result
    } catch (error: any) {
      debug.error('❌ Failed to upload banner:', error)
      return {
        success: false,
        error: error.message || 'Failed to upload banner'
      }
    }
  }
}

// Singleton instance
const profileServiceInstance = ProfileService.getInstance()

// Export singleton as default and named export
export const profileService = profileServiceInstance

// Direct function exports for legacy compatibility
// These proxy to the singleton instance methods
export const updateUserStatus = profileServiceInstance.updateUserStatus.bind(profileServiceInstance)
export const getProfile = profileServiceInstance.fetchProfile.bind(profileServiceInstance)
export const getProfileWithAvatarUrl = profileServiceInstance.getProfileWithAvatarUrl.bind(profileServiceInstance)
export const getProfileByAuthUserId = profileServiceInstance.fetchProfileByAuthUserId.bind(profileServiceInstance)
export const updateProfile = profileServiceInstance.updateProfile.bind(profileServiceInstance)
export const uploadAvatar = profileServiceInstance.uploadAvatar.bind(profileServiceInstance)
export const uploadBanner = profileServiceInstance.uploadBanner.bind(profileServiceInstance)