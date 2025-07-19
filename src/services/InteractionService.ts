/**
 * InteractionService - Orchestrated user interaction management
 * 
 * ORCHESTRATION PATTERN: Combines Core + Federation services
 * - CoreInteractionService: Pure local database operations
 * - FederationDecisionService: Federation decision logic
 * - FederationActivityService: ActivityPub activity creation
 * 
 * PRESERVED APIs: 
 * - ✅ Same method signatures as before
 * - ✅ Same return types and error formats
 * - ✅ Same local-first design (immediate UI updates)
 * - ✅ Same relationship management patterns
 * 
 * ENHANCED ARCHITECTURE:
 * - Clean separation of concerns
 * - Testable service components
 * - Professional orchestration patterns
 */

import { supabase } from '@/supabase'
import type { FederatedUser } from '@/types'

// Import core and federation services
import { coreInteractionService } from './core'
import { federationDecisionService, federationActivityService } from './federation'

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
  // FOLLOW MANAGEMENT (ORCHESTRATED: CORE + FEDERATION)
  // =====================================================

  /**
   * Follow/unfollow a user (orchestrated: local-first + conditional federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleFollow(targetUserId: string): Promise<FollowResult> {
    try {
      console.log(`🎭 Orchestration: Toggling follow for user: ${targetUserId}`)

      // Get current user for federation decisions
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      if (profileId === targetUserId) {
        throw this.createError('INVALID_ACTION', 'Cannot follow yourself')
      }

      // 1. Core operation: Pure local follow toggle
      const result = await coreInteractionService.toggleFollow(targetUserId)

      // 2. Federation decision: Should this follow federate?
      const decision = await federationDecisionService.shouldFederateFollow(profileId, targetUserId)
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Follow operation eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create Follow/Undo activity
        const operation = result.following ? 'follow' : 'unfollow'
        const activityResult = await federationActivityService.createFollowActivity(
          profileId, 
          targetUserId, 
          operation
        )
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Follow federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Follow federation failed (operation still applied locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Follow federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Follow toggled successfully: ${result.following ? 'following' : 'unfollowed'}`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to toggle follow:', error)
      throw error
    }
  }

  /**
   * Accept a follow request (orchestrated: local-first + conditional federation)
   * PRESERVES: Exact same API and return type
   */
  async acceptFollowRequest(followerUserId: string): Promise<void> {
    try {
      console.log(`🎭 Orchestration: Accepting follow request from user: ${followerUserId}`)

      // Get current user for federation decisions
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // 1. Core operation: Pure local follow request acceptance
      await coreInteractionService.acceptFollowRequest(followerUserId)

      // 2. Federation decision: Should this acceptance federate?
      const decision = await federationDecisionService.shouldFederateFollow(followerUserId, profileId)
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Follow request acceptance eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create Accept activity
        const activityResult = await federationActivityService.createFollowActivity(
          followerUserId, 
          profileId, 
          'accept'
        )
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Follow acceptance federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Follow acceptance federation failed (acceptance still applied locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Follow acceptance federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Follow request accepted successfully`)

    } catch (error) {
      console.error('❌ Orchestration: Failed to accept follow request:', error)
      throw error
    }
  }

  /**
   * Reject a follow request (orchestrated: local-first + conditional federation)
   * PRESERVES: Exact same API and return type
   */
  async rejectFollowRequest(followerUserId: string): Promise<void> {
    try {
      console.log(`🎭 Orchestration: Rejecting follow request from user: ${followerUserId}`)

      // Get current user for federation decisions
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // 1. Core operation: Pure local follow request rejection
      await coreInteractionService.rejectFollowRequest(followerUserId)

      // 2. Federation decision: Should this rejection federate?
      const decision = await federationDecisionService.shouldFederateFollow(followerUserId, profileId)
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Follow request rejection eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create Reject activity
        const activityResult = await federationActivityService.createFollowActivity(
          followerUserId, 
          profileId, 
          'reject'
        )
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Follow rejection federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Follow rejection federation failed (rejection still applied locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Follow rejection federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Follow request rejected successfully`)

    } catch (error) {
      console.error('❌ Orchestration: Failed to reject follow request:', error)
      throw error
    }
  }

  // =====================================================
  // BLOCK MANAGEMENT (ORCHESTRATED: CORE + FEDERATION)
  // =====================================================

  /**
   * Block/unblock a user (orchestrated: local-first + conditional federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleBlock(targetUserId: string): Promise<BlockResult> {
    try {
      console.log(`🎭 Orchestration: Toggling block for user: ${targetUserId}`)

      // Get current user for federation decisions
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      if (profileId === targetUserId) {
        throw this.createError('INVALID_ACTION', 'Cannot block yourself')
      }

      // 1. Core operation: Pure local block toggle (includes follow cleanup)
      const result = await coreInteractionService.toggleBlock(targetUserId)

      // 2. Federation decision: Should this block federate?
      const decision = await federationDecisionService.shouldFederateBlock(profileId, targetUserId)
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Block operation eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create Block/Undo activity
        const operation = result.blocked ? 'block' : 'unblock'
        const activityResult = await federationActivityService.createBlockActivity(
          profileId, 
          targetUserId, 
          operation
        )
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Block federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Block federation failed (operation still applied locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Block federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Block toggled successfully: ${result.blocked ? 'blocked' : 'unblocked'}`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to toggle block:', error)
      throw error
    }
  }

  // =====================================================
  // MUTE MANAGEMENT (DELEGATED TO CORE SERVICE - LOCAL-ONLY)
  // =====================================================

  /**
   * Mute/unmute a user (delegated to core service - local-only for notifications)
   * PRESERVES: Exact same API and return type
   */
  async toggleMute(targetUserId: string): Promise<MuteResult> {
    try {
      console.log(`🎭 Orchestration: Toggling mute for user: ${targetUserId}`)

      // Delegate to core service (mutes are local-only, affect notifications only)
      const result = await coreInteractionService.toggleMute(targetUserId)

      console.log(`✅ Orchestration: Mute toggled successfully: ${result.muted ? 'muted' : 'unmuted'}`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to toggle mute:', error)
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
  async getUserRelationships(targetUserIds: string[]): Promise<Record<string, {
    following: boolean;
    followedBy: boolean;
    blocking: boolean;
    blockedBy: boolean;
    muting: boolean;
    requested: boolean;
    pendingRequest: boolean;
  }>> {
    try {
      console.log(`🎭 Orchestration: Getting relationships for ${targetUserIds.length} users`)

      // Delegate to core service (no federation needed for reads)
      const relationships = await coreInteractionService.getUserRelationships(targetUserIds)

      console.log(`✅ Orchestration: Retrieved relationships for ${Object.keys(relationships).length} users`)
      return relationships

    } catch (error) {
      console.error('❌ Orchestration: Failed to get user relationships:', error)
      throw error
    }
  }

  /**
   * Get pending follow requests (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getFollowRequests(): Promise<FederatedUser[]> {
    try {
      console.log(`🎭 Orchestration: Getting follow requests`)

      // Delegate to core service (no federation needed for reads)
      const requests = await coreInteractionService.getFollowRequests()

      console.log(`✅ Orchestration: Retrieved ${requests.length} follow requests`)
      return requests

    } catch (error) {
      console.error('❌ Orchestration: Failed to get follow requests:', error)
      throw error
    }
  }

  /**
   * Get followers list (delegated to core service)
   * PRESERVES: Exact same API, pagination, and return type
   */
  async getFollowers(userId: string, limit: number = 20, cursor?: string): Promise<{
    users: FederatedUser[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      console.log(`🎭 Orchestration: Getting followers for user: ${userId}`)

      // Delegate to core service (no federation needed for reads)
      const result = await coreInteractionService.getFollowers(userId, limit, cursor)

      console.log(`✅ Orchestration: Retrieved ${result.users.length} followers`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to get followers:', error)
      throw error
    }
  }

  /**
   * Get following list (delegated to core service)
   * PRESERVES: Exact same API, pagination, and return type
   */
  async getFollowing(userId: string, limit: number = 20, cursor?: string): Promise<{
    users: FederatedUser[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      console.log(`🎭 Orchestration: Getting following for user: ${userId}`)

      // Delegate to core service (no federation needed for reads)
      const result = await coreInteractionService.getFollowing(userId, limit, cursor)

      console.log(`✅ Orchestration: Retrieved ${result.users.length} following`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to get following:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS (PRESERVED)
  // =====================================================

  /**
   * Get current user's profile ID
   * PRESERVES: Exact same helper logic
   */
  private async getCurrentUserProfileId(): Promise<string> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', user.id)
        .single()

      if (!profile) throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')

      return profile.id
    } catch (error) {
      console.error('❌ Orchestration: Failed to get current user profile ID:', error)
      throw error
    }
  }

  /**
   * Create standardized error object
   * PRESERVES: Exact same error handling
   */
  private createError(code: string, message: string, details?: any): InteractionServiceError {
    const secureDetails = process.env.NODE_ENV === 'development' ? details : undefined
    return { code, message, details: secureDetails }
  }
}

// Export singleton instance
export const interactionService = InteractionService.getInstance()