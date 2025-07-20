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

import { supabase } from '@/supabase'
import { userDataService } from './userDataService'
import type { Profile } from '@/types'

export interface ProfileData {
  username?: string
  display_name?: string
  avatar_url?: string
  banner_url?: string
  bio?: string
  color?: string
}

export interface ProfileServiceError {
  code: string
  message: string
  details?: any
}

export class ProfileService {
  private static instance: ProfileService

  static getInstance(): ProfileService {
    if (!ProfileService.instance) {
      ProfileService.instance = new ProfileService()
    }
    return ProfileService.instance
  }

  /**
   * Get current user's profile
   */
  async getCurrentProfile(): Promise<Profile> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('auth_user_id', user.id)
        .single()

      if (error || !profile) {
        throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')
      }

      return profile
    } catch (error) {
      console.error('❌ Failed to get current profile:', error)
      throw error
    }
  }

  /**
   * Update current user's profile (database triggers handle federation)
   */
  async updateCurrentProfile(updates: ProfileData): Promise<Profile> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      // Update profile - database triggers will handle federation automatically
      const { data: profile, error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('auth_user_id', user.id)
        .select('*')
        .single()

      if (error || !profile) {
        throw this.createError('UPDATE_FAILED', 'Failed to update profile', error)
      }

      // Refresh userDataService cache
      try {
        await userDataService.refreshCurrentUser()
      } catch (refreshError) {
        console.warn('⚠️ Failed to refresh userDataService cache:', refreshError)
      }

      return profile
    } catch (error) {
      console.error('❌ Failed to update profile:', error)
      throw error
    }
  }

  /**
   * Create a new profile (database triggers handle federation)
   */
  async createProfile(profileData: ProfileData & { auth_user_id: string }): Promise<Profile> {
    try {
      // Create profile - database triggers will handle federation automatically
      const { data: profile, error } = await supabase
        .from('profiles')
        .insert([profileData])
        .select('*')
        .single()

      if (error || !profile) {
        throw this.createError('CREATE_FAILED', 'Failed to create profile', error)
      }

      // Initialize userDataService
      try {
        await userDataService.refreshCurrentUser()
      } catch (initError) {
        console.warn('⚠️ Failed to initialize userDataService:', initError)
      }

      return profile
    } catch (error) {
      console.error('❌ Failed to create profile:', error)
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
      console.error('❌ Failed to get profile by ID:', error)
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
      console.error('❌ Failed to get profile by username:', error)
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
      console.error('❌ Failed to search profiles:', error)
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
      console.error('❌ Failed to check username availability:', error)
      throw error
    }
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
        console.error('Error updating status:', error)
        throw error
      }
      return data
    } catch (error) {
      console.error('❌ Failed to update user status:', error)
      throw error
    }
  }

  /**
   * Fetch profile by ID (alias for compatibility with stores)
   */
  async fetchProfile(userId: string, useCache = true): Promise<Profile | null> {
    try {
      // For now, ignore cache parameter since we simplified the service
      return await this.getProfileById(userId)
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
        .single()

      if (error || !profile) {
        return null
      }

      return profile
    } catch (error) {
      console.error('❌ Failed to get profile by auth user ID:', error)
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
      console.error('❌ Failed to upload avatar:', error)
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
      console.error('❌ Failed to upload banner:', error)
      return {
        success: false,
        error: error.message || 'Failed to upload banner'
      }
    }
  }
}

// Export singleton instance
export const profileService = ProfileService.getInstance()

// Export individual functions for compatibility with old imports
export const updateUserStatus = (userId: string, status: number) => 
  profileService.updateUserStatus(userId, status)

export const getProfile = (userId: string) => 
  profileService.fetchProfile(userId)

export const getProfileWithAvatarUrl = (userId: string) => 
  profileService.getProfileWithAvatarUrl(userId)

export const getProfileByAuthUserId = (authUserId: string) => 
  profileService.fetchProfileByAuthUserId(authUserId)

export const updateProfile = (profileData: ProfileData) => 
  profileService.updateProfile(profileData)

export const uploadAvatar = (file: File, userId: string) => 
  profileService.uploadAvatar(file, userId)

export const uploadBanner = (file: File, userId: string) => 
  profileService.uploadBanner(file, userId)