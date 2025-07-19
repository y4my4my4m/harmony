/**
 * InteractionService - Local-first user interactions
 * 
 * Handles follows, blocks, mutes, and user relationships with local-first design:
 * - Immediate UI updates with optimistic actions
 * - Background federation for cross-instance interactions
 * - Consistent error handling across all interaction types
 */

import { supabase } from '@/supabase'
import type { FederatedUser } from '@/types'

export interface InteractionServiceError {
  code: string
  message: string
  details?: any
}

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

export class InteractionService {
  private static instance: InteractionService
  
  static getInstance(): InteractionService {
    if (!this.instance) {
      this.instance = new InteractionService()
    }
    return this.instance
  }

  // =====================================================
  // FOLLOW MANAGEMENT (LOCAL-FIRST)
  // =====================================================

  /**
   * Follow/unfollow a user (local-first with federation)
   */
  async toggleFollow(targetUserId: string): Promise<FollowResult> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      if (profileId === targetUserId) {
        throw this.createError('INVALID_ACTION', 'Cannot follow yourself')
      }

      // Check current follow status
      const { data: existingFollow } = await supabase
        .from('follows')
        .select('id, status')
        .eq('follower_id', profileId)
        .eq('followed_id', targetUserId)
        .maybeSingle()

      let following: boolean
      let pending: boolean = false

      if (existingFollow) {
        // Unfollow
        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('id', existingFollow.id)

        if (error) throw this.createError('UNFOLLOW_FAILED', error.message, error)
        following = false
      } else {
        // Check if target user requires approval
        const { data: targetUser } = await supabase
          .from('profiles')
          .select('federation_followers_only, is_local')
          .eq('id', targetUserId)
          .single()

        const requiresApproval = targetUser?.federation_followers_only || false
        const status = requiresApproval ? 'pending' : 'accepted'

        // Create follow
        const { error } = await supabase
          .from('follows')
          .insert({
            follower_id: profileId,
            followed_id: targetUserId,
            status: status
          })

        if (error) throw this.createError('FOLLOW_FAILED', error.message, error)
        
        following = status === 'accepted'
        pending = status === 'pending'
      }

      return { following, pending }
    } catch (error) {
      console.error('Failed to toggle follow:', error)
      throw error
    }
  }

  /**
   * Accept a follow request
   */
  async acceptFollowRequest(followerUserId: string): Promise<void> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      const { error } = await supabase
        .from('follows')
        .update({ status: 'accepted' })
        .eq('follower_id', followerUserId)
        .eq('followed_id', profileId)
        .eq('status', 'pending')

      if (error) throw this.createError('ACCEPT_FAILED', error.message, error)
    } catch (error) {
      console.error('Failed to accept follow request:', error)
      throw error
    }
  }

  /**
   * Reject a follow request
   */
  async rejectFollowRequest(followerUserId: string): Promise<void> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      const { error } = await supabase
        .from('follows')
        .delete()
        .eq('follower_id', followerUserId)
        .eq('followed_id', profileId)
        .eq('status', 'pending')

      if (error) throw this.createError('REJECT_FAILED', error.message, error)
    } catch (error) {
      console.error('Failed to reject follow request:', error)
      throw error
    }
  }

  // =====================================================
  // BLOCK MANAGEMENT (LOCAL-FIRST)
  // =====================================================

  /**
   * Block/unblock a user (local-first)
   */
  async toggleBlock(targetUserId: string): Promise<BlockResult> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      if (profileId === targetUserId) {
        throw this.createError('INVALID_ACTION', 'Cannot block yourself')
      }

      // Check current block status
      const { data: existingBlock } = await supabase
        .from('user_blocks')
        .select('id')
        .eq('blocker_id', profileId)
        .eq('blocked_user_id', targetUserId)
        .maybeSingle()

      let blocked: boolean

      if (existingBlock) {
        // Unblock
        const { error } = await supabase
          .from('user_blocks')
          .delete()
          .eq('id', existingBlock.id)

        if (error) throw this.createError('UNBLOCK_FAILED', error.message, error)
        blocked = false
      } else {
        // Block user (also remove any follow relationship)
        const { error: blockError } = await supabase
          .from('user_blocks')
          .insert({
            blocker_id: profileId,
            blocked_user_id: targetUserId
          })

        if (blockError) throw this.createError('BLOCK_FAILED', blockError.message, blockError)

        // Remove any existing follow relationships
        await supabase
          .from('follows')
          .delete()
          .or(`and(follower_id.eq.${profileId},followed_id.eq.${targetUserId}),and(follower_id.eq.${targetUserId},followed_id.eq.${profileId})`)

        blocked = true
      }

      return { blocked }
    } catch (error) {
      console.error('Failed to toggle block:', error)
      throw error
    }
  }

  // =====================================================
  // MUTE MANAGEMENT (LOCAL-FIRST)
  // =====================================================

  /**
   * Mute/unmute a user (local-first, affects notifications only)
   */
  async toggleMute(targetUserId: string): Promise<MuteResult> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      if (profileId === targetUserId) {
        throw this.createError('INVALID_ACTION', 'Cannot mute yourself')
      }

      // Check current mute status
      const { data: existingMute } = await supabase
        .from('user_mutes')
        .select('id')
        .eq('muter_id', profileId)
        .eq('muted_user_id', targetUserId)
        .maybeSingle()

      let muted: boolean

      if (existingMute) {
        // Unmute
        const { error } = await supabase
          .from('user_mutes')
          .delete()
          .eq('id', existingMute.id)

        if (error) throw this.createError('UNMUTE_FAILED', error.message, error)
        muted = false
      } else {
        // Mute user
        const { error } = await supabase
          .from('user_mutes')
          .insert({
            muter_id: profileId,
            muted_user_id: targetUserId
          })

        if (error) throw this.createError('MUTE_FAILED', error.message, error)
        muted = true
      }

      return { muted }
    } catch (error) {
      console.error('Failed to toggle mute:', error)
      throw error
    }
  }

  // =====================================================
  // RELATIONSHIP QUERIES
  // =====================================================

  /**
   * Get user relationships for current user (following, blocked, muted)
   */
  async getUserRelationships(targetUserIds: string[]): Promise<Record<string, {
    following: boolean
    followedBy: boolean
    followRequestPending: boolean
    blocked: boolean
    muted: boolean
  }>> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return {}

      const profileId = await this.getCurrentUserProfileId()
      const relationships: Record<string, any> = {}

      // Initialize all relationships as false
      targetUserIds.forEach(id => {
        relationships[id] = {
          following: false,
          followedBy: false,
          followRequestPending: false,
          blocked: false,
          muted: false
        }
      })

      // Get follows (outgoing - who current user follows)
      const { data: following } = await supabase
        .from('follows')
        .select('followed_id, status')
        .eq('follower_id', profileId)
        .in('followed_id', targetUserIds)

      following?.forEach(follow => {
        relationships[follow.followed_id].following = follow.status === 'accepted'
        relationships[follow.followed_id].followRequestPending = follow.status === 'pending'
      })

      // Get follows (incoming - who follows current user)
      const { data: followers } = await supabase
        .from('follows')
        .select('follower_id, status')
        .eq('followed_id', profileId)
        .in('follower_id', targetUserIds)
        .eq('status', 'accepted')

      followers?.forEach(follow => {
        relationships[follow.follower_id].followedBy = true
      })

      // Get blocks
      const { data: blocks } = await supabase
        .from('user_blocks')
        .select('blocked_user_id')
        .eq('blocker_id', profileId)
        .in('blocked_user_id', targetUserIds)

      blocks?.forEach(block => {
        relationships[block.blocked_user_id].blocked = true
      })

      // Get mutes
      const { data: mutes } = await supabase
        .from('user_mutes')
        .select('muted_user_id')
        .eq('muter_id', profileId)
        .in('muted_user_id', targetUserIds)

      mutes?.forEach(mute => {
        relationships[mute.muted_user_id].muted = true
      })

      return relationships
    } catch (error) {
      console.error('Failed to get user relationships:', error)
      return {}
    }
  }

  /**
   * Get follow requests for current user
   */
  async getFollowRequests(): Promise<FederatedUser[]> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      const { data: requests, error } = await supabase
        .from('follows')
        .select(`
          created_at,
          follower:profiles!follower_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          )
        `)
        .eq('followed_id', profileId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })

      if (error) throw this.createError('LOAD_REQUESTS_FAILED', error.message, error)

      return requests?.map(req => this.transformDatabaseUser(req.follower)) || []
    } catch (error) {
      console.error('Failed to get follow requests:', error)
      throw error
    }
  }

  /**
   * Get followers for a user
   */
  async getFollowers(userId: string, limit: number = 20, cursor?: string): Promise<{
    followers: FederatedUser[]
    hasMore: boolean
    nextCursor?: string
  }> {
    try {
      let query = supabase
        .from('follows')
        .select(`
          created_at,
          follower:profiles!follower_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          )
        `)
        .eq('followed_id', userId)
        .eq('status', 'accepted')
        .order('created_at', { ascending: false })
        .limit(limit + 1)

      if (cursor) {
        query = query.lt('created_at', cursor)
      }

      const { data: follows, error } = await query

      if (error) throw this.createError('LOAD_FOLLOWERS_FAILED', error.message, error)

      const hasMore = follows.length > limit
      const resultFollows = hasMore ? follows.slice(0, limit) : follows
      const nextCursor = hasMore ? follows[limit - 1].created_at : undefined

      return {
        followers: resultFollows.map(follow => this.transformDatabaseUser(follow.follower)),
        hasMore,
        nextCursor
      }
    } catch (error) {
      console.error('Failed to get followers:', error)
      throw error
    }
  }

  /**
   * Get following for a user
   */
  async getFollowing(userId: string, limit: number = 20, cursor?: string): Promise<{
    following: FederatedUser[]
    hasMore: boolean
    nextCursor?: string
  }> {
    try {
      let query = supabase
        .from('follows')
        .select(`
          created_at,
          followed:profiles!followed_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          )
        `)
        .eq('follower_id', userId)
        .eq('status', 'accepted')
        .order('created_at', { ascending: false })
        .limit(limit + 1)

      if (cursor) {
        query = query.lt('created_at', cursor)
      }

      const { data: follows, error } = await query

      if (error) throw this.createError('LOAD_FOLLOWING_FAILED', error.message, error)

      const hasMore = follows.length > limit
      const resultFollows = hasMore ? follows.slice(0, limit) : follows
      const nextCursor = hasMore ? follows[limit - 1].created_at : undefined

      return {
        following: resultFollows.map(follow => this.transformDatabaseUser(follow.followed)),
        hasMore,
        nextCursor
      }
    } catch (error) {
      console.error('Failed to get following:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

  private async getCurrentUserProfileId(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (error || !profile) {
      throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')
    }

    return profile.id
  }

  private transformDatabaseUser(user: any): FederatedUser {
    if (!user) {
      return {
        id: 'unknown',
        username: 'unknown',
        display_name: 'Unknown User',
        avatar_url: '/default_avatar.png',
        domain: 'har.mony.lol',
        bio: '',
        is_local: true,
        verified: false,
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        handle: '@unknown'
      }
    }

    const isLocal = user.is_local !== false
    const domain = user.domain || 'har.mony.lol'
    const handle = isLocal ? `@${user.username}` : `@${user.username}@${domain}`

    return {
      id: user.id,
      username: user.username,
      display_name: user.display_name || user.username,
      avatar_url: user.avatar_url || '/default_avatar.png',
      domain,
      bio: user.bio || '',
      is_local: isLocal,
      verified: false, // TODO: Add verification system
      followers_count: 0, // TODO: Add counts if needed
      following_count: 0,
      posts_count: 0,
      created_at: user.created_at,
      updated_at: user.updated_at || user.created_at,
      handle
    }
  }

  private createError(code: string, message: string, details?: any): InteractionServiceError {
    return { code, message, details }
  }
}

// Export singleton instance
export const interactionService = InteractionService.getInstance()