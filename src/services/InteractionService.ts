import { supabase } from '@/supabase'
import type { Profile } from '@/types'
import { debug } from '@/utils/debug'

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

  async toggleFollow(targetUserId: string): Promise<FollowResult> {

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

    const profileId = await this.getCurrentUserProfileId()

    if (profileId === targetUserId) {
      throw this.createError('INVALID_ACTION', 'Cannot follow yourself')
    }

    const result = await coreInteractionService.toggleFollow(targetUserId)

    return result
  }

  async acceptFollowRequest(followerUserId: string): Promise<void> {

    await coreInteractionService.acceptFollowRequest(followerUserId)
  }

  async rejectFollowRequest(followerUserId: string): Promise<void> {

    await coreInteractionService.rejectFollowRequest(followerUserId)
  }

  async toggleBlock(targetUserId: string): Promise<{ blocking: boolean }> {

    const result = await coreInteractionService.toggleBlock(targetUserId)

    return { blocking: result.blocked }
  }

    async toggleMute(targetUserId: string): Promise<{ muting: boolean }> {

    const result = await coreInteractionService.toggleMute(targetUserId)

    return { muting: result.muted }
  }

  async getUserRelationships(userIds: string[]): Promise<{
    [userId: string]: RelationshipInfo;
  }> {

    // Core's UserRelationship shape differs slightly from RelationshipInfo;
    // cast through unknown since the consumers treat the result as a relationship map.
    const relationships = await coreInteractionService.getUserRelationships(userIds)

    return relationships as unknown as { [userId: string]: RelationshipInfo }
  }

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

    // Core's getFollowers signature is (userId, limit, cursor) and returns
    // { users, hasMore, nextCursor }; adapt to this service's existing
    // { followers, hasMore, total } shape so callers stay unchanged.
    const coreResult = await coreInteractionService.getFollowers(userId, options.limit) as any

    const result = {
      followers: (coreResult?.users ?? coreResult?.followers ?? []) as Profile[],
      hasMore: !!coreResult?.hasMore,
      total: coreResult?.total ?? (coreResult?.users?.length ?? coreResult?.followers?.length ?? 0),
    }

    return result
  }

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

    const { limit = 20, offset = 0 } = options

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

    return result
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

    const { limit = 20 } = options
    
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

    return transformedResult
  }

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

export const interactionService = InteractionService.getInstance()