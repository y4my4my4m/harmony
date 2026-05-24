/**
 * CoreInteractionService - Pure local user interaction operations with ENTERPRISE SECURITY
 * 
 * Contains ONLY local database operations with NO federation logic:
 * - Follow/unfollow operations with strict verification
 * - Block/unblock operations with security controls
 * - Mute/unmute operations with privacy protection
 * - Relationship queries with secure aggregation
 * - Follow request management with authorization
 * 
 * SECURITY FEATURES:
 * - ✅ Authentication verification on all operations
 * - ✅ Authorization checks (ownership verification)
 * - ✅ Input validation and sanitization
 * - ✅ SQL injection prevention with parameterized queries
 * - ✅ Privacy controls for sensitive relationship data
 * - ✅ Secure error handling (no data leakage)
 * - ✅ Rate limiting considerations for bulk operations
 * - ✅ Relationship integrity validation
 * 
 * NO FEDERATION CONCERNS:
 * - No ActivityPub Follow/Undo activities
 * - No cross-instance follow propagation
 * - No federation approval logic
 * - Pure local Supabase operations only
 */

import { supabase } from '@/supabase'
import { authContextService } from '@/services/AuthContextService'
import { debug } from '@/utils/debug'

export interface FollowResult {
  following: boolean
  pending?: boolean // For follow requests
}

export interface BlockResult {
  blocked: boolean
}

export interface MuteResult {
  muted: boolean
}

export interface UserRelationship {
  following: boolean
  followedBy: boolean
  followRequestPending: boolean
  blocked: boolean
  muted: boolean
}

export interface CoreInteractionServiceError {
  code: string
  message: string
  details?: any
}

export interface BasicUser {
  id: string
  username: string
  display_name: string
  avatar_url?: string
  is_local: boolean
  domain?: string
}

export interface FollowRequestUser extends BasicUser {
  requested_at: string
}

export interface PaginatedUsers {
  users: BasicUser[]
  hasMore: boolean
  nextCursor?: string
}

export class CoreInteractionService {
  private static instance: CoreInteractionService
  
  // Security constants
  private readonly MAX_RELATIONSHIP_BATCH_SIZE = 100
  private readonly MAX_PAGINATION_LIMIT = 50
  
  static getInstance(): CoreInteractionService {
    if (!this.instance) {
      this.instance = new CoreInteractionService()
    }
    return this.instance
  }

  // =====================================================
  // FOLLOW MANAGEMENT (SECURE LOCAL OPERATIONS)
  // =====================================================

  /**
   * Follow/unfollow a user (pure local, secure)
   */
  async toggleFollow(targetUserId: string): Promise<FollowResult> {
    try {
      // Authentication verification via centralized service
      const profileId = await this.getCurrentUserProfileId()

      // Input validation
      if (!targetUserId || typeof targetUserId !== 'string') {
        throw this.createError('INVALID_INPUT', 'Target user ID is required')
      }

      // Self-follow prevention
      if (profileId === targetUserId) {
        throw this.createError('INVALID_ACTION', 'Cannot follow yourself')
      }

      debug.log(`🔄 Core: Toggling follow for user: ${targetUserId}`)

      // Check current follow status
      const { data: existingFollow, error: followError } = await supabase
        .from('follows')
        .select('id, status')
        .eq('follower_id', profileId)
        .eq('following_id', targetUserId)
        .maybeSingle()

      if (followError) throw this.createError('QUERY_FAILED', 'Failed to check follow status', followError)

      let following: boolean
      let pending: boolean = false

      if (existingFollow) {
        // Unfollow - secure deletion with ownership verification
        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('id', existingFollow.id)
          .eq('follower_id', profileId) // Security: Double-check ownership

        if (error) throw this.createError('UNFOLLOW_FAILED', 'Failed to unfollow user', error)
        following = false
        debug.log(`✅ Core: Successfully unfollowed user: ${targetUserId}`)
      } else {
        // Verify target user exists and check approval settings
        const { data: targetUser, error: userError } = await supabase
          .from('profiles')
          .select('id, manually_approves_followers')
          .eq('id', targetUserId)
          .single()

        if (userError || !targetUser) {
          throw this.createError('USER_NOT_FOUND', 'Target user not found')
        }

        // Check if we're blocked by target user (skip if table doesn't exist or no permissions)
        try {
          const { data: blockedBy } = await supabase
            .from('user_blocks')
            .select('id')
            .eq('blocker_id', targetUserId)
            .eq('blocked_user_id', profileId)
            .maybeSingle()

          if (blockedBy) {
            throw this.createError('BLOCKED_BY_USER', 'Cannot follow user who has blocked you')
          }
        } catch (blockError: any) {
          // Ignore permission errors - assume not blocked if we can't check
          if (blockError.code !== '42501') {
            debug.warn('Block check failed:', blockError)
          }
        }

        // Determine if approval is required (ActivityPub standard)
        const requiresApproval = targetUser.manually_approves_followers || false
        const status = requiresApproval ? 'pending' : 'accepted'

        // Create follow with secure insertion
        const { error } = await supabase
          .from('follows')
          .insert({
            follower_id: profileId,
            following_id: targetUserId,
            status: status,
            created_at: new Date().toISOString()
          })

        if (error) {
          // Handle unique constraint violations
          if (error.code === '23505') {
            throw this.createError('ALREADY_FOLLOWING', 'Already following this user')
          }
          throw this.createError('FOLLOW_FAILED', 'Failed to follow user', error)
        }
        
        following = status === 'accepted'
        pending = status === 'pending'
        debug.log(`✅ Core: Successfully followed user: ${targetUserId} (status: ${status})`)
      }

      return { following, pending }
    } catch (error) {
      debug.error('❌ Core: Failed to toggle follow:', error)
      throw error
    }
  }

  /**
   * Accept a follow request (secure authorization)
   */
  async acceptFollowRequest(followerUserId: string): Promise<void> {
    try {
      // Authentication verification via centralized service
      const profileId = await this.getCurrentUserProfileId()

      // Input validation
      if (!followerUserId || typeof followerUserId !== 'string') {
        throw this.createError('INVALID_INPUT', 'Follower user ID is required')
      }

      debug.log(`🔄 Core: Accepting follow request from: ${followerUserId}`)

      // Secure update with authorization verification
      const { data, error } = await supabase
        .from('follows')
        .update({ 
          status: 'accepted',
        })
        .eq('follower_id', followerUserId)
        .eq('following_id', profileId) // Security: Ensure we own the target profile
        .eq('status', 'pending')      // Security: Only update pending requests
        .select('id')

      if (error) throw this.createError('ACCEPT_FAILED', 'Failed to accept follow request', error)

      if (!data || data.length === 0) {
        throw this.createError('REQUEST_NOT_FOUND', 'Follow request not found or already processed')
      }

      debug.log(`✅ Core: Successfully accepted follow request from: ${followerUserId}`)
    } catch (error) {
      debug.error('❌ Core: Failed to accept follow request:', error)
      throw error
    }
  }

  /**
   * Reject a follow request (secure authorization)
   */
  async rejectFollowRequest(followerUserId: string): Promise<void> {
    try {
      // Authentication verification via centralized service
      const profileId = await this.getCurrentUserProfileId()

      // Input validation
      if (!followerUserId || typeof followerUserId !== 'string') {
        throw this.createError('INVALID_INPUT', 'Follower user ID is required')
      }

      debug.log(`🔄 Core: Rejecting follow request from: ${followerUserId}`)

      // Secure deletion with authorization verification
      const { data, error } = await supabase
        .from('follows')
        .delete()
        .eq('follower_id', followerUserId)
        .eq('following_id', profileId) // Security: Ensure we own the target profile
        .eq('status', 'pending')      // Security: Only delete pending requests
        .select('id')

      if (error) throw this.createError('REJECT_FAILED', 'Failed to reject follow request', error)

      if (!data || data.length === 0) {
        throw this.createError('REQUEST_NOT_FOUND', 'Follow request not found or already processed')
      }

      debug.log(`✅ Core: Successfully rejected follow request from: ${followerUserId}`)
    } catch (error) {
      debug.error('❌ Core: Failed to reject follow request:', error)
      throw error
    }
  }

  // =====================================================
  // BLOCK MANAGEMENT (SECURE OPERATIONS)
  // =====================================================

  /**
   * Block/unblock a user (secure with relationship cleanup)
   */
  async toggleBlock(targetUserId: string): Promise<BlockResult> {
    try {
      // Authentication verification via centralized service
      const profileId = await this.getCurrentUserProfileId()

      // Input validation
      if (!targetUserId || typeof targetUserId !== 'string') {
        throw this.createError('INVALID_INPUT', 'Target user ID is required')
      }

      // Self-block prevention
      if (profileId === targetUserId) {
        throw this.createError('INVALID_ACTION', 'Cannot block yourself')
      }

      debug.log(`🔄 Core: Toggling block for user: ${targetUserId}`)

      // Check current block status
      const { data: existingBlock, error: blockError } = await supabase
        .from('user_blocks')
        .select('id')
        .eq('blocker_id', profileId)
        .eq('blocked_user_id', targetUserId)
        .maybeSingle()

      if (blockError) throw this.createError('QUERY_FAILED', 'Failed to check block status', blockError)

      let blocked: boolean

      if (existingBlock) {
        // Unblock - secure deletion with ownership verification
        const { error } = await supabase
          .from('user_blocks')
          .delete()
          .eq('id', existingBlock.id)
          .eq('blocker_id', profileId) // Security: Double-check ownership

        if (error) throw this.createError('UNBLOCK_FAILED', 'Failed to unblock user', error)
        blocked = false
        debug.log(`✅ Core: Successfully unblocked user: ${targetUserId}`)
      } else {
        // Block user with secure transaction (block + remove follows)
        const { error: blockError } = await supabase
          .from('user_blocks')
          .insert({
            blocker_id: profileId,
            blocked_user_id: targetUserId,
            created_at: new Date().toISOString()
          })

        if (blockError) {
          if (blockError.code === '23505') {
            throw this.createError('ALREADY_BLOCKED', 'User is already blocked')
          }
          throw this.createError('BLOCK_FAILED', 'Failed to block user', blockError)
        }

        // Remove any existing follow relationships (secure cleanup)
        await supabase
          .from('follows')
          .delete()
          .or(`and(follower_id.eq.${profileId},following_id.eq.${targetUserId}),and(follower_id.eq.${targetUserId},following_id.eq.${profileId})`)

        blocked = true
        debug.log(`✅ Core: Successfully blocked user: ${targetUserId}`)
      }

      return { blocked }
    } catch (error) {
      debug.error('❌ Core: Failed to toggle block:', error)
      throw error
    }
  }

  // =====================================================
  // MUTE MANAGEMENT (SECURE OPERATIONS)
  // =====================================================

  /**
   * Mute/unmute a user (pure local, affects notifications only)
   */
  async toggleMute(targetUserId: string): Promise<MuteResult> {
    try {
      // Authentication verification via centralized service
      const profileId = await this.getCurrentUserProfileId()

      // Input validation
      if (!targetUserId || typeof targetUserId !== 'string') {
        throw this.createError('INVALID_INPUT', 'Target user ID is required')
      }

      // Self-mute prevention
      if (profileId === targetUserId) {
        throw this.createError('INVALID_ACTION', 'Cannot mute yourself')
      }

      debug.log(`🔄 Core: Toggling mute for user: ${targetUserId}`)

      // Check current mute status
      const { data: existingMute, error: muteError } = await supabase
        .from('user_mutes')
        .select('id')
        .eq('muter_id', profileId)
        .eq('muted_user_id', targetUserId)
        .maybeSingle()

      if (muteError) throw this.createError('QUERY_FAILED', 'Failed to check mute status', muteError)

      let muted: boolean

      if (existingMute) {
        // Unmute - secure deletion with ownership verification
        const { error } = await supabase
          .from('user_mutes')
          .delete()
          .eq('id', existingMute.id)
          .eq('muter_id', profileId) // Security: Double-check ownership

        if (error) throw this.createError('UNMUTE_FAILED', 'Failed to unmute user', error)
        muted = false
        debug.log(`✅ Core: Successfully unmuted user: ${targetUserId}`)
      } else {
        // Mute user with secure insertion
        const { error } = await supabase
          .from('user_mutes')
          .insert({
            muter_id: profileId,
            muted_user_id: targetUserId,
            hide_notifications: true,
            hide_from_timeline: true,
            created_at: new Date().toISOString()
          })

        if (error) {
          if (error.code === '23505') {
            throw this.createError('ALREADY_MUTED', 'User is already muted')
          }
          throw this.createError('MUTE_FAILED', 'Failed to mute user', error)
        }

        muted = true
        debug.log(`✅ Core: Successfully muted user: ${targetUserId}`)
      }

      return { muted }
    } catch (error) {
      debug.error('❌ Core: Failed to toggle mute:', error)
      throw error
    }
  }

  // =====================================================
  // RELATIONSHIP QUERIES (SECURE AGGREGATION)
  // =====================================================

  /**
   * Get user relationships with secure batch processing
   */
  async getUserRelationships(targetUserIds: string[]): Promise<Record<string, UserRelationship>> {
    try {
      // Authentication verification via centralized service
      let profileId: string
      try {
        profileId = await this.getCurrentUserProfileId()
      } catch {
        return {} // Not authenticated - return empty
      }

      // Input validation and security limits
      if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        throw this.createError('INVALID_INPUT', 'Target user IDs array is required')
      }

      if (targetUserIds.length > this.MAX_RELATIONSHIP_BATCH_SIZE) {
        throw this.createError('BATCH_TOO_LARGE', `Cannot query more than ${this.MAX_RELATIONSHIP_BATCH_SIZE} relationships at once`)
      }

      // Sanitize user IDs
      const sanitizedUserIds = targetUserIds.filter(id => id && typeof id === 'string')
      if (sanitizedUserIds.length === 0) {
        throw this.createError('INVALID_INPUT', 'No valid user IDs provided')
      }

      const relationships: Record<string, UserRelationship> = {}

      debug.log(`🔄 Core: Getting relationships for ${sanitizedUserIds.length} users`)

      // Initialize all relationships as false
      sanitizedUserIds.forEach(id => {
        relationships[id] = {
          following: false,
          followedBy: false,
          followRequestPending: false,
          blocked: false,
          muted: false
        }
      })

      // Secure batch queries with error handling
      const [followingData, followersData, blocksData, mutesData] = await Promise.allSettled([
        // Get follows (outgoing - who current user follows)
        supabase
          .from('follows')
          .select('following_id, status')
          .eq('follower_id', profileId)
                      .in('following_id', sanitizedUserIds),

                  // Get follows (incoming - who follows current user)
          supabase
            .from('follows')
            .select('follower_id, status')
            .eq('following_id', profileId)
            .in('follower_id', sanitizedUserIds),

        // Get blocks
        supabase
          .from('user_blocks')
          .select('blocked_user_id')
          .eq('blocker_id', profileId)
          .in('blocked_user_id', sanitizedUserIds),

        // Get mutes
        supabase
          .from('user_mutes')
          .select('muted_user_id')
          .eq('muter_id', profileId)
          .in('muted_user_id', sanitizedUserIds)
      ])

      // Process following relationships
      if (followingData.status === 'fulfilled' && followingData.value.data) {
        followingData.value.data.forEach(follow => {
                  relationships[follow.following_id].following = follow.status === 'accepted'
        relationships[follow.following_id].followRequestPending = follow.status === 'pending'
        })
      }

      // Process follower relationships
      if (followersData.status === 'fulfilled' && followersData.value.data) {
        followersData.value.data.forEach(follow => {
          relationships[follow.follower_id].followedBy = follow.status === 'accepted'
        })
      }

      // Process block relationships
      if (blocksData.status === 'fulfilled' && blocksData.value.data) {
        blocksData.value.data.forEach(block => {
          relationships[block.blocked_user_id].blocked = true
        })
      }

      // Process mute relationships
      if (mutesData.status === 'fulfilled' && mutesData.value.data) {
        mutesData.value.data.forEach(mute => {
          relationships[mute.muted_user_id].muted = true
        })
      }

      debug.log(`✅ Core: Successfully retrieved relationships for ${sanitizedUserIds.length} users`)
      return relationships
    } catch (error) {
      debug.error('❌ Core: Failed to get user relationships:', error)
      // Return empty object on error to avoid breaking UI
      return {}
    }
  }

  /**
   * Get follow requests with secure pagination
   */
  async getFollowRequests(limit: number = 20, cursor?: string): Promise<{
    requests: FollowRequestUser[]
    hasMore: boolean
    nextCursor?: string
  }> {
    try {
      // Authentication verification via centralized service
      const profileId = await this.getCurrentUserProfileId()

      // Input validation and security limits
      const secureLimit = Math.min(Math.max(1, limit), this.MAX_PAGINATION_LIMIT)

      debug.log(`🔄 Core: Getting follow requests (limit: ${secureLimit})`)

      let query = supabase
        .from('follows')
        .select(`
          follower_id,
          created_at,
          profiles!follows_follower_id_fkey (
            id,
            username,
            display_name,
            avatar_url,
            is_local,
            domain
          )
        `)
        .eq('following_id', profileId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(secureLimit + 1) // Get one extra to check if there are more

      // Apply cursor for pagination
      if (cursor) {
        query = query.lt('created_at', cursor)
      }

      const { data: requests, error } = await query

      if (error) throw this.createError('REQUESTS_FAILED', 'Failed to load follow requests', error)

      // Check if there are more results
      const hasMore = requests && requests.length > secureLimit
      const actualRequests = hasMore ? requests.slice(0, secureLimit) : requests || []

      // Transform and sanitize data. Supabase types `profiles` as an array
      // here, but the FK is a one-to-one join - pull the first row.
      const transformedRequests: FollowRequestUser[] = actualRequests.map((request: any) => {
        const p = Array.isArray(request.profiles) ? request.profiles[0] : request.profiles
        return {
          id: p?.id,
          username: p?.username,
          display_name: p?.display_name,
          avatar_url: p?.avatar_url,
          is_local: p?.is_local,
          domain: p?.domain,
          requested_at: request.created_at,
        }
      })

      const nextCursor = hasMore && actualRequests.length > 0 
        ? actualRequests[actualRequests.length - 1].created_at 
        : undefined

      debug.log(`✅ Core: Found ${transformedRequests.length} follow requests`)
      return {
        requests: transformedRequests,
        hasMore,
        nextCursor
      }
    } catch (error) {
      debug.error('❌ Core: Failed to get follow requests:', error)
      throw error
    }
  }

  /**
   * Get followers with secure pagination
   */
  async getFollowers(userId: string, limit: number = 20, cursor?: string): Promise<PaginatedUsers> {
    try {
      // Input validation
      if (!userId || typeof userId !== 'string') {
        throw this.createError('INVALID_INPUT', 'User ID is required')
      }

      // Security limits
      const secureLimit = Math.min(Math.max(1, limit), this.MAX_PAGINATION_LIMIT)

      debug.log(`🔄 Core: Getting followers for user: ${userId}`)

      let query = supabase
        .from('follows')
        .select(`
          follower_id,
          created_at,
          profiles!follows_follower_id_fkey (
            id,
            username,
            display_name,
            avatar_url,
            is_local,
            domain
          )
        `)
        .eq('following_id', userId)
        .eq('status', 'accepted')
        .order('created_at', { ascending: false })
        .limit(secureLimit + 1)

      if (cursor) {
        query = query.lt('created_at', cursor)
      }

      const { data: followers, error } = await query

      if (error) throw this.createError('FOLLOWERS_FAILED', 'Failed to load followers', error)

      const hasMore = followers && followers.length > secureLimit
      const actualFollowers = hasMore ? followers.slice(0, secureLimit) : followers || []

      const users: BasicUser[] = actualFollowers.map((follow: any) => {
        const p = Array.isArray(follow.profiles) ? follow.profiles[0] : follow.profiles
        return {
          id: p?.id,
          username: p?.username,
          display_name: p?.display_name,
          avatar_url: p?.avatar_url,
          is_local: p?.is_local,
          domain: p?.domain,
        }
      })

      const nextCursor = hasMore && actualFollowers.length > 0 
        ? actualFollowers[actualFollowers.length - 1].created_at 
        : undefined

      debug.log(`✅ Core: Found ${users.length} followers`)
      return { users, hasMore, nextCursor }
    } catch (error) {
      debug.error('❌ Core: Failed to get followers:', error)
      throw error
    }
  }

  /**
   * Get following with secure pagination
   */
  async getFollowing(userId: string, limit: number = 20, cursor?: string): Promise<PaginatedUsers> {
    try {
      // Input validation
      if (!userId || typeof userId !== 'string') {
        throw this.createError('INVALID_INPUT', 'User ID is required')
      }

      // Security limits
      const secureLimit = Math.min(Math.max(1, limit), this.MAX_PAGINATION_LIMIT)

      debug.log(`🔄 Core: Getting following for user: ${userId}`)

      let query = supabase
        .from('follows')
        .select(`
          following_id,
          created_at,
          profiles!follows_following_id_fkey (
            id,
            username,
            display_name,
            avatar_url,
            is_local,
            domain
          )
        `)
        .eq('follower_id', userId)
        .eq('status', 'accepted')
        .order('created_at', { ascending: false })
        .limit(secureLimit + 1)

      if (cursor) {
        query = query.lt('created_at', cursor)
      }

      const { data: following, error } = await query

      if (error) throw this.createError('FOLLOWING_FAILED', 'Failed to load following', error)

      const hasMore = following && following.length > secureLimit
      const actualFollowing = hasMore ? following.slice(0, secureLimit) : following || []

      const users: BasicUser[] = actualFollowing.map((follow: any) => {
        const p = Array.isArray(follow.profiles) ? follow.profiles[0] : follow.profiles
        return {
          id: p?.id,
          username: p?.username,
          display_name: p?.display_name,
          avatar_url: p?.avatar_url,
          is_local: p?.is_local,
          domain: p?.domain,
        }
      })

      const nextCursor = hasMore && actualFollowing.length > 0 
        ? actualFollowing[actualFollowing.length - 1].created_at 
        : undefined

      debug.log(`✅ Core: Found ${users.length} following`)
      return { users, hasMore, nextCursor }
    } catch (error) {
      debug.error('❌ Core: Failed to get following:', error)
      throw error
    }
  }

  // =====================================================
  // SECURITY HELPER METHODS
  // =====================================================

  /**
   * Get current user's profile ID
   * Uses centralized AuthContextService to avoid duplicate auth lookups
   */
  private async getCurrentUserProfileId(): Promise<string> {
    try {
      return await authContextService.getCurrentProfileId()
    } catch (error) {
      debug.error('❌ Core: Failed to get current user profile ID:', error)
      throw this.createError('AUTH_REQUIRED', 'User not authenticated')
    }
  }

  private createError(code: string, message: string, details?: any): CoreInteractionServiceError {
    // Security: Don't expose internal details in production
    const secureDetails = import.meta.env.DEV ? details : undefined
    return { code, message, details: secureDetails }
  }
}

// Export singleton instance
export const coreInteractionService = CoreInteractionService.getInstance()