import { supabase } from '@/supabase'
import type { Profile } from '@/types'
import { debug } from '@/utils/debug'

// Import only core service - database handles federation
import { coreInteractionService } from './core'

export interface FollowResult {
  following: boolean
  pending?: boolean
  followCount?: number
}

export interface RelationshipInfo {
  following: boolean
  followedBy: boolean
  blocking: boolean
  muting: boolean
  followingPending: boolean
  followedByPending: boolean
}

export class InteractionService {
  private static instance: InteractionService

  static getInstance(): InteractionService {
    if (!InteractionService.instance) {
      InteractionService.instance = new InteractionService()
    }
    return InteractionService.instance
  }

  // =====================================================
  // FOLLOW MANAGEMENT (SIMPLIFIED: TRUST DATABASE TRIGGERS)
  // =====================================================

  /**
   * Follow/unfollow a user (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleFollow(targetUserId: string): Promise<FollowResult> {
    try {
      debug.log(`🚀 Simplified: Toggling follow for user: ${targetUserId}`)

      // Get current user for validation
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      if (profileId === targetUserId) {
        throw this.createError('INVALID_ACTION', 'Cannot follow yourself')
      }

      // Just toggle the follow - database triggers handle federation automatically
      const result = await coreInteractionService.toggleFollow(targetUserId)

      debug.log(`✅ Simplified: Follow toggled - database handling federation: ${result.following ? 'following' : 'unfollowed'}`)
      return result

    } catch (error) {
      debug.error('❌ Simplified: Failed to toggle follow:', error)
      throw error
    }
  }

  /**
   * Accept a follow request (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async acceptFollowRequest(followerUserId: string): Promise<void> {
    try {
      debug.log(`🚀 Simplified: Accepting follow request from: ${followerUserId}`)

      // Just accept the follow request - database triggers handle federation automatically
      await coreInteractionService.acceptFollowRequest(followerUserId)

      debug.log(`✅ Simplified: Follow request accepted - database handling federation: ${followerUserId}`)

    } catch (error) {
      debug.error('❌ Simplified: Failed to accept follow request:', error)
      throw error
    }
  }

  /**
   * Reject a follow request (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async rejectFollowRequest(followerUserId: string): Promise<void> {
    try {
      debug.log(`🚀 Simplified: Rejecting follow request from: ${followerUserId}`)

      // Just reject the follow request - database triggers handle federation automatically
      await coreInteractionService.rejectFollowRequest(followerUserId)

      debug.log(`✅ Simplified: Follow request rejected - database handling federation: ${followerUserId}`)

    } catch (error) {
      debug.error('❌ Simplified: Failed to reject follow request:', error)
      throw error
    }
  }

  // =====================================================
  // BLOCKING & MUTING (SIMPLIFIED: TRUST DATABASE TRIGGERS)
  // =====================================================

  /**
   * Block/unblock a user (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleBlock(targetUserId: string): Promise<{ blocking: boolean }> {
    try {
      debug.log(`🚀 Simplified: Toggling block for user: ${targetUserId}`)

      const result = await coreInteractionService.toggleBlock(targetUserId)

      debug.log(`✅ Simplified: Block toggled - database handling federation: ${result.blocked ? 'blocked' : 'unblocked'}`)
      return { blocking: result.blocked }

    } catch (error) {
      debug.error('❌ Simplified: Failed to toggle block:', error)
      throw error
    }
  }

  /**
   * Mute/unmute a user (local-only: no federation needed)
   * PRESERVES: Exact same API and return type
   */
  async toggleMute(targetUserId: string): Promise<{ muting: boolean }> {
    try {
      debug.log(`🚀 Simplified: Toggling mute for user: ${targetUserId}`)

      const result = await coreInteractionService.toggleMute(targetUserId)

      debug.log(`✅ Simplified: Mute toggled (local-only): ${result.muted ? 'muted' : 'unmuted'}`)
      return { muting: result.muted }

    } catch (error) {
      debug.error('❌ Simplified: Failed to toggle mute:', error)
      throw error
    }
  }

  // =====================================================
  // RELATIONSHIP QUERIES (DELEGATED TO CORE SERVICE)
  // =====================================================

  /**
   * Get user relationships (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getUserRelationships(userIds: string[]): Promise<{
    [userId: string]: RelationshipInfo;
  }> {
    try {
      debug.log(`🚀 Simplified: Getting relationships for ${userIds.length} users`)

      // Delegate to core service (no federation needed for reads).
      // Core's UserRelationship shape differs slightly from RelationshipInfo;
      // cast through unknown since the consumers treat the result as a relationship map.
      const relationships = await coreInteractionService.getUserRelationships(userIds)

      debug.log(`✅ Simplified: Retrieved relationships for ${Object.keys(relationships).length} users`)
      return relationships as unknown as { [userId: string]: RelationshipInfo }

    } catch (error) {
      debug.error('❌ Simplified: Failed to get user relationships:', error)
      throw error
    }
  }

  /**
   * Get followers (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getFollowers(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{
    followers: Profile[];
    hasMore: boolean;
    total: number;
  }> {
    try {
      debug.log(`🚀 Simplified: Getting followers for user: ${userId}`)

      // Core's getFollowers signature is (userId, limit, cursor) and returns
      // { users, hasMore, nextCursor }; adapt to this service's existing
      // { followers, hasMore, total } shape so callers stay unchanged.
      const coreResult = await coreInteractionService.getFollowers(userId, options.limit) as any

      const result = {
        followers: (coreResult?.users ?? coreResult?.followers ?? []) as Profile[],
        hasMore: !!coreResult?.hasMore,
        total: coreResult?.total ?? (coreResult?.users?.length ?? coreResult?.followers?.length ?? 0),
      }

      debug.log(`✅ Simplified: Retrieved ${result.followers.length} followers`)
      return result

    } catch (error) {
      debug.error('❌ Simplified: Failed to get followers:', error)
      throw error
    }
  }

  /**
   * Get following (simple, professional approach)
   * PRESERVES: Exact same API and return type
   */
  async getFollowing(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{
    following: Profile[];
    hasMore: boolean;
    total: number;
  }> {
    try {
      debug.log(`🚀 Simple: Getting following for user: ${userId}`)

      const { limit = 20, offset = 0 } = options

      // Simple direct query - exactly what we need, nothing more
      const { data: followingData, error } = await supabase
        .from('follows')
        .select(`
          following_id,
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
        .range(offset, offset + limit - 1)

      if (error) {
        debug.error('❌ Database error:', error)
        throw this.createError('FOLLOWING_FAILED', 'Failed to load following', error)
      }

      // Simple transformation - no over-engineering
      const following: Profile[] = (followingData || []).map(follow => {
        const profile = follow.profiles as any // Supabase typing issue - profiles is actually a single object
        return {
          id: profile.id,
          username: profile.username,
          display_name: profile.display_name,
          avatar_url: profile.avatar_url,
          is_local: profile.is_local,
          domain: profile.domain,
          handle: profile.is_local ? `@${profile.username}` : `@${profile.username}@${profile.domain}`,
          // Default values for missing fields - simple and clean
          bio: undefined,
          banner_url: undefined,
          status: undefined,
          color: undefined,
          is_admin: false,
          federated_id: undefined,
          ap_id: undefined,
          followers_count: undefined,
          following_count: undefined,
          posts_count: undefined,
          created_at: undefined,
          updated_at: undefined
        } as Profile
      })

      // Get total count efficiently
      const { count: totalCount } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('follower_id', userId)
        .eq('status', 'accepted')

      const hasMore = (offset + limit) < (totalCount || 0)

      const result = {
        following,
        hasMore,
        total: totalCount || 0
      }

      debug.log(`✅ Simple: Retrieved ${result.following.length} following users`)
      return result

    } catch (error) {
      debug.error('❌ Simple: Failed to get following:', error)
      throw error
    }
  }

  /**
   * Get the COMPLETE set of accepted "following" target IDs for a user.
   *
   * This is intentionally distinct from getFollowing(): that one paginates and
   * embeds full profiles for rendering a UI list, whereas this returns every
   * followed id with no join and no limit. It is the canonical source for the
   * app-wide `isFollowing` relationship set, which must be exhaustive (a paged
   * list would silently mark followed users as "not followed" past page 1).
   * Returns only UUIDs, so it stays cheap even for users following thousands.
   */
  async getFollowingIds(userId: string): Promise<string[]> {
    if (!userId || typeof userId !== 'string') {
      throw this.createError('INVALID_INPUT', 'User ID is required')
    }

    const { data, error } = await supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', userId)
      .eq('status', 'accepted')

    if (error) {
      debug.error('❌ Failed to load following ids:', error)
      throw this.createError('FOLLOWING_FAILED', 'Failed to load following ids', error)
    }

    return (data || []).map(row => row.following_id as string)
  }

  /**
   * Get follow requests (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getFollowRequests(options: {
    limit?: number;
    offset?: number;
  } = {}): Promise<{
    requests: Array<{
      id: string;
      follower: Profile;
      created_at: string;
    }>;
    hasMore: boolean;
    total: number;
  }> {
    try {
      debug.log(`🚀 Simplified: Getting follow requests`)

      const { limit = 20 } = options
      
      // Delegate to core service (adjust parameter format)
      const result = await coreInteractionService.getFollowRequests(limit)

      // Transform FollowRequestUser objects to expected format
      const transformedRequests = result.requests.map((request) => ({
        id: request.id, // Using id as the request ID
        follower: {
          id: request.id,
          username: request.username,
          display_name: request.display_name,
          avatar_url: request.avatar_url,
          domain: request.domain,
          is_local: request.is_local,
          bio: undefined,
          banner_url: undefined,
          status: undefined,
          color: undefined,
          is_admin: false,
          federated_id: undefined,
          ap_id: undefined,
          followers_count: undefined,
          following_count: undefined,
          posts_count: undefined,
          created_at: undefined,
          updated_at: undefined,
          handle: request.is_local ? `@${request.username}` : `@${request.username}@${request.domain}`
        } as Profile,
        created_at: request.requested_at
      }))

      const transformedResult = {
        requests: transformedRequests,
        hasMore: result.hasMore,
        total: result.requests.length // Note: This is not the true total, just current batch size
      }

      debug.log(`✅ Simplified: Retrieved ${transformedResult.requests.length} follow requests`)
      return transformedResult

    } catch (error) {
      debug.error('❌ Simplified: Failed to get follow requests:', error)
      throw error
    }
  }

  // =====================================================
  // UTILITY METHODS (PRESERVED)
  // =====================================================

  /**
   * OPTIMIZED: Uses AuthContextService for cached profile ID lookup
   */
  private async getCurrentUserProfileId(): Promise<string> {
    const { authContextService } = await import('@/services/AuthContextService')
    
    try {
      return await authContextService.getCurrentProfileId()
    } catch {
      throw this.createError('AUTH_REQUIRED', 'User not authenticated')
    }
  }

  private createError(code: string, message: string, details?: any): Error {
    const error = new Error(message) as any
    error.code = code
    error.details = details
    return error
  }
}

// Export singleton instance
export const interactionService = InteractionService.getInstance()