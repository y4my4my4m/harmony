/**
 * RelationshipService - Clean interface for user relationships
 * 
 * Handles follows, unfollows, blocks, etc. with optional federation.
 * Local-first design: All operations work locally, federation is optional.
 * 
 * Features:
 * - Local-first operations
 * - Optional federation
 * - Clean error handling
 * - Federation status feedback
 * - Support for follow requests and auto-approval
 */

import { supabase } from '@/supabase'
import { createOutgoingHandler } from '@/services/federation/OutgoingHandler'

export interface RelationshipResult {
  success: boolean
  error?: string
  localSuccess: boolean
  federationStatus?: {
    attempted: boolean
    success: boolean
    error?: string
  }
}

export interface FollowResult extends RelationshipResult {
  requiresApproval?: boolean
  followId?: string
}

export interface RelationshipInfo {
  isFollowing: boolean
  isFollowedBy: boolean
  isBlocked: boolean
  isBlocking: boolean
  followStatus?: 'accepted' | 'pending' | 'rejected'
}

export class RelationshipService {
  private static instance: RelationshipService
  
  static getInstance(): RelationshipService {
    if (!RelationshipService.instance) {
      RelationshipService.instance = new RelationshipService()
    }
    return RelationshipService.instance
  }
  
  /**
   * Follow a user
   * Local-first: Creates follow locally, then federates if remote user
   */
  async followUser(followerId: string, followingId: string): Promise<FollowResult> {
    console.log('👥 RelationshipService: Following user:', followingId)
    
    try {
      // Step 1: Check if already following
      const existing = await this.getExistingFollow(followerId, followingId)
      if (existing) {
        return {
          success: true,
          localSuccess: true,
          followId: existing.id,
          requiresApproval: existing.status === 'pending',
          federationStatus: { attempted: false, success: true }
        }
      }
      
      // Step 2: Get target user info
      const { data: targetUser, error: userError } = await supabase
        .from('profiles')
        .select('is_local, domain, auto_accept_follows')
        .eq('id', followingId)
        .single()
      
      if (userError || !targetUser) {
        return {
          success: false,
          localSuccess: false,
          error: 'Target user not found',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      // Step 3: Determine follow status
      const requiresApproval = !targetUser.auto_accept_follows
      const status = requiresApproval ? 'pending' : 'accepted'
      
      // Step 4: Create follow locally
      const localResult = await this.createLocalFollow(followerId, followingId, status)
      
      if (!localResult.success) {
        return {
          success: false,
          localSuccess: false,
          error: localResult.error,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ Follow created locally:', localResult.followId)
      
      // Step 5: Attempt federation if target is remote
      const federationStatus = targetUser.is_local 
        ? { attempted: false, success: true }
        : await this.federateFollow(localResult.followId!, followerId, followingId)
      
      return {
        success: true,
        localSuccess: true,
        followId: localResult.followId,
        requiresApproval,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ RelationshipService: Error following user:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Unfollow a user
   */
  async unfollowUser(followerId: string, followingId: string): Promise<RelationshipResult> {
    console.log('💔 RelationshipService: Unfollowing user:', followingId)
    
    try {
      // Find existing follow
      const existing = await this.getExistingFollow(followerId, followingId)
      if (!existing) {
        return {
          success: true,
          localSuccess: true,
          federationStatus: { attempted: false, success: true }
        }
      }
      
      // Delete locally
      const { error } = await supabase
        .from('follows')
        .delete()
        .eq('id', existing.id)
      
      if (error) {
        return {
          success: false,
          localSuccess: false,
          error: error.message,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ Unfollowed locally')
      
      // TODO: Implement federation for unfollow (Undo Follow activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ RelationshipService: Error unfollowing user:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Block a user
   */
  async blockUser(blockerId: string, blockedId: string): Promise<RelationshipResult> {
    console.log('🚫 RelationshipService: Blocking user:', blockedId)
    
    try {
      // Check if already blocked
      const { data: existing } = await supabase
        .from('blocks')
        .select('id')
        .eq('blocker_id', blockerId)
        .eq('blocked_id', blockedId)
        .maybeSingle()
      
      if (existing) {
        return {
          success: true,
          localSuccess: true,
          federationStatus: { attempted: false, success: true }
        }
      }
      
      // Remove any existing follows
      await supabase
        .from('follows')
        .delete()
        .or(`and(follower_id.eq.${blockerId},following_id.eq.${blockedId}),and(follower_id.eq.${blockedId},following_id.eq.${blockerId})`)
      
      // Create block
      const { error } = await supabase
        .from('blocks')
        .insert([{
          blocker_id: blockerId,
          blocked_id: blockedId
        }])
      
      if (error) {
        return {
          success: false,
          localSuccess: false,
          error: error.message,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ User blocked locally')
      
      // TODO: Implement federation for block (Block activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ RelationshipService: Error blocking user:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Unblock a user
   */
  async unblockUser(blockerId: string, blockedId: string): Promise<RelationshipResult> {
    console.log('✅ RelationshipService: Unblocking user:', blockedId)
    
    try {
      const { error } = await supabase
        .from('blocks')
        .delete()
        .eq('blocker_id', blockerId)
        .eq('blocked_id', blockedId)
      
      if (error) {
        return {
          success: false,
          localSuccess: false,
          error: error.message,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ User unblocked locally')
      
      // TODO: Implement federation for unblock (Undo Block activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ RelationshipService: Error unblocking user:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Accept a follow request
   */
  async acceptFollowRequest(followId: string, userId: string): Promise<RelationshipResult> {
    console.log('✅ RelationshipService: Accepting follow request:', followId)
    
    try {
      // Verify this is a pending follow for the current user
      const { data: follow, error: fetchError } = await supabase
        .from('follows')
        .select('follower_id, following_id, status')
        .eq('id', followId)
        .eq('following_id', userId)
        .eq('status', 'pending')
        .single()
      
      if (fetchError || !follow) {
        return {
          success: false,
          localSuccess: false,
          error: 'Follow request not found',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      // Update to accepted
      const { error: updateError } = await supabase
        .from('follows')
        .update({ status: 'accepted' })
        .eq('id', followId)
      
      if (updateError) {
        return {
          success: false,
          localSuccess: false,
          error: updateError.message,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ Follow request accepted locally')
      
      // TODO: Implement federation for accept (Accept activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ RelationshipService: Error accepting follow request:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Reject a follow request
   */
  async rejectFollowRequest(followId: string, userId: string): Promise<RelationshipResult> {
    console.log('❌ RelationshipService: Rejecting follow request:', followId)
    
    try {
      // Verify this is a pending follow for the current user
      const { data: follow, error: fetchError } = await supabase
        .from('follows')
        .select('follower_id, following_id, status')
        .eq('id', followId)
        .eq('following_id', userId)
        .eq('status', 'pending')
        .single()
      
      if (fetchError || !follow) {
        return {
          success: false,
          localSuccess: false,
          error: 'Follow request not found',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      // Delete the follow request
      const { error: deleteError } = await supabase
        .from('follows')
        .delete()
        .eq('id', followId)
      
      if (deleteError) {
        return {
          success: false,
          localSuccess: false,
          error: deleteError.message,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ Follow request rejected locally')
      
      // TODO: Implement federation for reject (Reject activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ RelationshipService: Error rejecting follow request:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Get relationship info between two users
   */
  async getRelationshipInfo(userId: string, targetId: string): Promise<{
    success: boolean
    relationship?: RelationshipInfo
    error?: string
  }> {
    try {
      // Get follow relationships
      const { data: follows } = await supabase
        .from('follows')
        .select('follower_id, following_id, status')
        .or(`and(follower_id.eq.${userId},following_id.eq.${targetId}),and(follower_id.eq.${targetId},following_id.eq.${userId})`)
      
      // Get block relationships
      const { data: blocks } = await supabase
        .from('blocks')
        .select('blocker_id, blocked_id')
        .or(`and(blocker_id.eq.${userId},blocked_id.eq.${targetId}),and(blocker_id.eq.${targetId},blocked_id.eq.${userId})`)
      
      const isFollowing = follows?.some(f => f.follower_id === userId && f.following_id === targetId && f.status === 'accepted') || false
      const isFollowedBy = follows?.some(f => f.follower_id === targetId && f.following_id === userId && f.status === 'accepted') || false
      const isBlocking = blocks?.some(b => b.blocker_id === userId && b.blocked_id === targetId) || false
      const isBlocked = blocks?.some(b => b.blocker_id === targetId && b.blocked_id === userId) || false
      
      const followRequest = follows?.find(f => f.follower_id === userId && f.following_id === targetId)
      const followStatus = followRequest?.status
      
      const relationship: RelationshipInfo = {
        isFollowing,
        isFollowedBy,
        isBlocked,
        isBlocking,
        followStatus
      }
      
      return { success: true, relationship }
      
    } catch (error) {
      console.error('❌ RelationshipService: Error getting relationship info:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Get followers for a user
   */
  async getFollowers(userId: string, limit: number = 20, offset: number = 0): Promise<{
    success: boolean
    followers?: any[]
    total?: number
    error?: string
  }> {
    try {
      const { data: followers, error } = await supabase
        .from('follows')
        .select(`
          follower:profiles!follows_follower_id_fkey (
            id, username, display_name, avatar_url, domain, is_local
          )
        `)
        .eq('following_id', userId)
        .eq('status', 'accepted')
        .range(offset, offset + limit - 1)
      
      if (error) {
        return { success: false, error: error.message }
      }
      
      const { count } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('following_id', userId)
        .eq('status', 'accepted')
      
      return {
        success: true,
        followers: followers?.map(f => f.follower) || [],
        total: count || 0
      }
      
    } catch (error) {
      console.error('❌ RelationshipService: Error getting followers:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Get following for a user
   */
  async getFollowing(userId: string, limit: number = 20, offset: number = 0): Promise<{
    success: boolean
    following?: any[]
    total?: number
    error?: string
  }> {
    try {
      const { data: following, error } = await supabase
        .from('follows')
        .select(`
          following:profiles!follows_following_id_fkey (
            id, username, display_name, avatar_url, domain, is_local
          )
        `)
        .eq('follower_id', userId)
        .eq('status', 'accepted')
        .range(offset, offset + limit - 1)
      
      if (error) {
        return { success: false, error: error.message }
      }
      
      const { count } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('follower_id', userId)
        .eq('status', 'accepted')
      
      return {
        success: true,
        following: following?.map(f => f.following) || [],
        total: count || 0
      }
      
    } catch (error) {
      console.error('❌ RelationshipService: Error getting following:', error)
      return { success: false, error: error.message }
    }
  }
  
  // =============================================
  // PRIVATE METHODS
  // =============================================
  
  /**
   * Get existing follow relationship
   */
  private async getExistingFollow(followerId: string, followingId: string): Promise<{
    id: string
    status: string
  } | null> {
    const { data } = await supabase
      .from('follows')
      .select('id, status')
      .eq('follower_id', followerId)
      .eq('following_id', followingId)
      .maybeSingle()
    
    return data
  }
  
  /**
   * Create follow relationship locally
   */
  private async createLocalFollow(followerId: string, followingId: string, status: string): Promise<{
    success: boolean
    followId?: string
    error?: string
  }> {
    const { data: follow, error } = await supabase
      .from('follows')
      .insert([{
        follower_id: followerId,
        following_id: followingId,
        status
      }])
      .select('id')
      .single()
    
    if (error) {
      // Handle duplicate follows gracefully
      if (error.code === '23505') {
        const existing = await this.getExistingFollow(followerId, followingId)
        return { success: true, followId: existing?.id }
      }
      return { success: false, error: error.message }
    }
    
    return { success: true, followId: follow.id }
  }
  
  /**
   * Federate a follow request
   */
  private async federateFollow(followId: string, followerId: string, followingId: string): Promise<{
    attempted: boolean
    success: boolean
    error?: string
  }> {
    try {
      const outgoingHandler = await createOutgoingHandler()
      
      const result = await outgoingHandler.federateFollow({
        follower_id: followerId,
        following_id: followingId,
        follow_id: followId
      })
      
      return {
        attempted: true,
        success: result.success,
        error: result.error
      }
      
    } catch (error) {
      console.error('❌ Follow federation failed:', error)
      return {
        attempted: true,
        success: false,
        error: error.message
      }
    }
  }
}

// Export singleton instance
export const relationshipService = RelationshipService.getInstance()