/** Local profile CRUD and search. */
import { supabase } from '@/supabase'
import { authContextService } from '@/services/AuthContextService'
import type { Profile } from '@/types'
import { debug } from '@/utils/debug'

export interface ProfileData {
  username?: string
  display_name?: string
  avatar_url?: string
  banner_url?: string
  bio?: string
  color?: string
}

export interface CoreProfileServiceError {
  code: string
  message: string
  details?: any
}

export interface ProfileSearchOptions {
  limit?: number
  includePrivate?: boolean
  signal?: AbortSignal
}

export interface UserStats {
  posts_count: number
  followers_count: number
  following_count: number
  profile_views: number
  /** Denormalized chat message count (profiles.message_count). */
  message_count?: number
  /** Denormalized voice minutes (profiles.voice_minutes). */
  voice_minutes?: number
}

export class CoreProfileService {
  private static instance: CoreProfileService
  
  // Security constants
  private readonly MAX_SEARCH_LIMIT = 50
  private readonly MAX_USERNAME_LENGTH = 30
  private readonly MAX_DISPLAY_NAME_LENGTH = 50
  private readonly MAX_DISPLAY_NAME_EMOJIS = 5
  private readonly MAX_BIO_LENGTH = 500
  
  static getInstance(): CoreProfileService {
    if (!this.instance) {
      this.instance = new CoreProfileService()
    }
    return this.instance
  }

  // PROFILE LOADING (SECURE & PRIVACY-AWARE)

  /**
   * Load profile by ID with privacy controls (pure local, secure)
   */
  async loadProfile(profileId: string): Promise<Profile | null> {
    try {
      // Input validation
      if (!profileId || typeof profileId !== 'string') {
        throw this.createError('INVALID_INPUT', 'Profile ID is required')
      }

      debug.log(`🔄 Core: Loading profile: ${profileId}`)

      const { data: profile, error } = await supabase
        .from('profiles')
        .select(`
          id,
          username,
          display_name,
          avatar_url,
          banner_url,
          bio,
          color,
          created_at,
          updated_at,
          is_local,
          domain,
          followers_count,
          following_count,
          posts_count,
          is_verified
        `)
        .eq('id', profileId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          debug.log(`ℹ️ Core: Profile not found: ${profileId}`)
          return null
        }
        throw this.createError('LOAD_PROFILE_FAILED', 'Failed to load profile', error)
      }

      // Privacy filtering (remove sensitive data if needed)
      const sanitizedProfile = this.sanitizeProfileForPublicView(profile)

      debug.log(`✅ Core: Profile loaded successfully: ${profileId}`)
      return sanitizedProfile
    } catch (error) {
      debug.error('❌ Core: Failed to load profile:', error)
      throw error
    }
  }

  /**
   * Load profile by auth user ID (secure ownership lookup)
   */
  async loadProfileByAuthUserId(authUserId: string): Promise<Profile | null> {
    try {
      // Input validation
      if (!authUserId || typeof authUserId !== 'string') {
        throw this.createError('INVALID_INPUT', 'Auth user ID is required')
      }

      debug.log(`🔄 Core: Loading profile by auth user ID`)

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('auth_user_id', authUserId)
        .maybeSingle()

      if (error && error.code !== 'PGRST116') {
        throw this.createError('LOAD_PROFILE_FAILED', 'Failed to load profile', error)
      }

      if (!profile) {
        debug.log(`ℹ️ Core: Profile not found for auth user`)
        return null
      }

      debug.log(`✅ Core: Profile loaded by auth user ID`)
      return profile
    } catch (error) {
      debug.error('❌ Core: Failed to load profile by auth user ID:', error)
      throw error
    }
  }

  /**
   * Search profiles with security filtering (pure local, secure)
   */
  async searchProfiles(
    query: string,
    options: ProfileSearchOptions = {}
  ): Promise<Profile[]> {
    try {
      const { limit = 20, signal } = options

      // Security validation
      if (!query || typeof query !== 'string') {
        throw this.createError('INVALID_INPUT', 'Search query is required')
      }

      if (query.length < 2) {
        throw this.createError('INVALID_INPUT', 'Search query must be at least 2 characters')
      }

      // Sanitize query to prevent injection
      const sanitizedQuery = this.sanitizeSearchQuery(query)
      const secureLimit = Math.min(limit, this.MAX_SEARCH_LIMIT)

      debug.log(`🔄 Core: Searching profiles: "${sanitizedQuery}"`)

      if (signal?.aborted) {
        throw this.createError('ABORTED', 'Search was aborted')
      }

      const queryBuilder = supabase
        .from('profiles')
        .select(`
          id,
          username,
          display_name,
          avatar_url,
          bio,
          is_local,
          domain,
          followers_count,
          is_verified,
          is_private
        `)
        .or(`username.ilike.%${sanitizedQuery}%,display_name.ilike.%${sanitizedQuery}%`)
        .limit(secureLimit)

      // Privacy filtering - removed (column doesn't exist yet)
      // if (!includePrivate) {
      //   queryBuilder = queryBuilder.or('is_private.is.null,is_private.eq.false')
      // }

      const { data: profiles, error } = await queryBuilder

      if (error) throw this.createError('SEARCH_FAILED', 'Failed to search profiles', error)

      // Additional privacy filtering
      const filteredProfiles = profiles?.map(profile => 
        this.sanitizeProfileForPublicView(profile)
      ) || []

      debug.log(`✅ Core: Found ${filteredProfiles.length} profiles for: "${sanitizedQuery}"`)
      return filteredProfiles
    } catch (error) {
      debug.error('❌ Core: Failed to search profiles:', error)
      throw error
    }
  }

  // PROFILE MANAGEMENT (SECURE OWNERSHIP VERIFICATION)

  /**
   * Update current user profile (SECURE ownership verification)
   */
  async updateProfile(profileData: ProfileData): Promise<Profile> {
    try {
      const profileId = await authContextService.getCurrentProfileId()
      const authUser = await authContextService.getCurrentAuthUser()

      // Input validation and sanitization
      const sanitizedData = this.sanitizeProfileData(profileData)
      this.validateProfileData(sanitizedData)

      debug.log('🔄 Core: Updating profile with secure validation')

      // Secure database update with ownership verification
      const { data: profile, error } = await supabase
        .from('profiles')
        .update({
          ...sanitizedData,
        })
        .eq('id', profileId)
        .eq('auth_user_id', authUser.id) // Double verification for security
        .select()
        .single()

      if (error) {
        // Check for unique constraint violations
        if (error.code === '23505') {
          if (error.message.includes('username')) {
            throw this.createError('USERNAME_TAKEN', 'Username is already taken')
          }
        }
        throw this.createError('UPDATE_FAILED', 'Failed to update profile', error)
      }

      if (!profile) {
        throw this.createError('UNAUTHORIZED', 'Not authorized to update this profile')
      }

      debug.log('✅ Core: Profile updated successfully with security verification')
      return profile
    } catch (error) {
      debug.error('❌ Core: Failed to update profile:', error)
      throw error
    }
  }

  /**
   * Create new user profile (SECURE registration)
   */
  async createProfile(profileData: Profile): Promise<Profile> {
    try {
      const authUser = await authContextService.getCurrentAuthUser()

      // Input validation and sanitization
      const sanitizedData = this.sanitizeProfileCreationData(profileData)
      this.validateProfileCreationData(sanitizedData)

      debug.log('🔄 Core: Creating profile with security validation')

      // Secure profile creation
      const { data: profile, error } = await supabase
        .from('profiles')
        .insert({
          ...sanitizedData,
          auth_user_id: authUser.id, // Secure user association
          is_local: true
        })
        .select()
        .single()

      if (error) {
        if (error.code === '23505') {
          if (error.message.includes('username')) {
            throw this.createError('USERNAME_TAKEN', 'Username is already taken')
          }
          if (error.message.includes('auth_user_id')) {
            throw this.createError('PROFILE_EXISTS', 'Profile already exists for this user')
          }
        }
        throw this.createError('CREATE_FAILED', 'Failed to create profile', error)
      }

      debug.log('✅ Core: Profile created successfully with security verification')
      return profile
    } catch (error) {
      debug.error('❌ Core: Failed to create profile:', error)
      throw error
    }
  }

  // USER STATISTICS (SECURE AGGREGATION)

  /**
   * Get user statistics with secure aggregation
   */
  async getUserStats(profileId: string): Promise<UserStats> {
    try {
      // Input validation
      if (!profileId || typeof profileId !== 'string') {
        throw this.createError('INVALID_INPUT', 'Profile ID is required')
      }

      debug.log(`🔄 Core: Loading user stats: ${profileId}`)

      // Secure aggregation query
      const { data: profile, error } = await supabase
        .from('profiles')
        .select(`
          posts_count,
          followers_count,
          following_count,
          message_count,
          voice_minutes
        `)
        .eq('id', profileId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          throw this.createError('PROFILE_NOT_FOUND', 'Profile not found')
        }
        throw this.createError('STATS_FAILED', 'Failed to load user statistics', error)
      }

      const stats: UserStats = {
        posts_count: profile.posts_count || 0,
        followers_count: profile.followers_count || 0,
        following_count: profile.following_count || 0,
        profile_views: 0, // Placeholder for future implementation
        message_count: Number(profile.message_count ?? 0),
        voice_minutes: Number(profile.voice_minutes ?? 0),
      }

      debug.log(`✅ Core: User stats loaded successfully`)
      return stats
    } catch (error) {
      debug.error('❌ Core: Failed to load user stats:', error)
      throw error
    }
  }

  // SECURITY HELPER METHODS

  private sanitizeProfileData(data: ProfileData): ProfileData {
    return {
      username: data.username?.trim().toLowerCase(),
      display_name: data.display_name?.trim(),
      avatar_url: data.avatar_url?.trim(),
      banner_url: data.banner_url?.trim(),
      bio: data.bio?.trim(),
      color: data.color?.trim()
    }
  }

  private sanitizeProfileCreationData(data: Profile): Partial<Profile> {
    return {
      username: data.username?.trim().toLowerCase(),
      display_name: data.display_name?.trim(),
      avatar_url: data.avatar_url?.trim(),
      banner_url: data.banner_url?.trim(),
      bio: data.bio?.trim(),
      color: data.color?.trim(),
      domain: data.domain?.trim()
    }
  }

  private sanitizeSearchQuery(query: string): string {
    return query.trim().replace(/[<>'";&]/g, '')
  }

  private sanitizeProfileForPublicView(profile: any): Profile {
    // Remove sensitive fields for public viewing
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { auth_user_id, ...publicProfile } = profile
    return publicProfile
  }

  private validateProfileData(data: ProfileData): void {
    if (data.username && data.username.length > this.MAX_USERNAME_LENGTH) {
      throw this.createError('INVALID_INPUT', `Username must be ${this.MAX_USERNAME_LENGTH} characters or less`)
    }

    // `display_name` is OPTIONAL on update (omitting it leaves the
    // existing value untouched) - but if it's present in the payload it
    // must be a non-empty, non-whitespace string. Previously a user could
    // PATCH their profile with `display_name: ""` and the row would
    // accept it, leaving the user nameless everywhere they were rendered.
    // The display-side fallbacks (`getUserDisplayName`) cover the
    // historical bad data; this check prevents new bad data.
    if (data.display_name !== undefined) {
      if (typeof data.display_name !== 'string' || data.display_name.trim().length === 0) {
        throw this.createError('INVALID_INPUT', 'Display name cannot be empty')
      }
      if (data.display_name.length > this.MAX_DISPLAY_NAME_LENGTH) {
        throw this.createError('INVALID_INPUT', `Display name must be ${this.MAX_DISPLAY_NAME_LENGTH} characters or less`)
      }
      const emojiMatches = data.display_name.match(/:([a-zA-Z0-9_+-]+):/g)
      if (emojiMatches && emojiMatches.length > this.MAX_DISPLAY_NAME_EMOJIS) {
        throw this.createError('INVALID_INPUT', `Display name can have at most ${this.MAX_DISPLAY_NAME_EMOJIS} custom emojis`)
      }
    }

    if (data.bio && data.bio.length > this.MAX_BIO_LENGTH) {
      throw this.createError('INVALID_INPUT', `Bio must be ${this.MAX_BIO_LENGTH} characters or less`)
    }

    if (data.username && !/^[a-zA-Z0-9_]+$/.test(data.username)) {
      throw this.createError('INVALID_INPUT', 'Username can only contain letters, numbers, and underscores')
    }
  }

  private validateProfileCreationData(data: Partial<Profile>): void {
    if (!data.username) {
      throw this.createError('INVALID_INPUT', 'Username is required')
    }

    if (!data.display_name) {
      throw this.createError('INVALID_INPUT', 'Display name is required')
    }

    this.validateProfileData(data as ProfileData)
  }

  private createError(code: string, message: string, details?: any): CoreProfileServiceError {
    // Security: Don't expose internal details in production
    const secureDetails = import.meta.env.DEV ? details : undefined
    return { code, message, details: secureDetails }
  }
}

export const coreProfileService = CoreProfileService.getInstance()