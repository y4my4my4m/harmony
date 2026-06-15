/**
 * FederationActivityService - Clean ActivityPub activity creation
 * 
 * Handles creation of ActivityPub activities and insertion into ap_activities table:
 * - Reaction activities (Like/Undo for emoji reactions)
 * - Post activities (Create/Update/Delete for posts)
 * - Follow activities (Follow/Undo for user relationships)
 * - Profile activities (Update for profile changes)
 * 
 * INTEGRATION POINTS:
 * - ✅ Inserts into your existing ap_activities table
 * - ✅ Uses your existing content conversion functions
 * - ✅ Compatible with your existing edge function pipeline
 * - ✅ Generates proper ActivityPub JSON for delivery
 * 
 * WORKS WITH YOUR ARCHITECTURE:
 * - Edge functions read from ap_activities → HTTP delivery ✅
 * - Content conversion functions handle format translation ✅
 * - HTTP signatures and delivery handled by edge functions ✅
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export interface ActivityCreationResult {
  success: boolean
  activityId?: string
  error?: string
}

export interface FederationActivityServiceError {
  code: string
  message: string
  details?: any
}

export class FederationActivityService {
  private static instance: FederationActivityService
  
  static getInstance(): FederationActivityService {
    if (!this.instance) {
      this.instance = new FederationActivityService()
    }
    return this.instance
  }

  // Reaction federation (posts, messages, channels) is handled server-side by
  // DB triggers -> BullMQ -> `resolveOutboundEmoji` (domain-qualified custom
  // emoji). The client must not build reaction activities; see reactionHandler.

  // =====================================================
  // POST ACTIVITIES (CREATE/UPDATE/DELETE)
  // =====================================================

  /**
   * Create post activity (Create/Update/Delete)
   */
  async createPostActivity(
    postId: string, 
    operation: 'create' | 'update' | 'delete'
  ): Promise<ActivityCreationResult> {
    try {
      debug.log(`📤 Federation: Creating post activity (${operation})`)

      // Get post data
      const postData = await this.getPostData(postId)
      if (!postData) {
        return { success: false, error: 'Missing required data for activity creation' }
      }
      const actorData = await this.getActorData(postData.author_id)

      if (!actorData) {
        return { success: false, error: 'Missing required data for activity creation' }
      }

      // Generate activity ID and determine type
      const instanceDomain = await this.getInstanceDomain()
      const activityId = `${instanceDomain}/activities/${crypto.randomUUID()}`
      
      let activityType: string
      switch (operation) {
        case 'create': activityType = 'Create'; break
        case 'update': activityType = 'Update'; break
        case 'delete': activityType = 'Delete'; break
        default: throw new Error(`Unknown post operation: ${operation}`)
      }

      // Create post activity data using your existing functions
      const activityData = await this.buildPostActivityData({
        activityId,
        activityType,
        actor: actorData,
        postData,
        operation
      })

      // Use RPC to bypass PostgREST schema cache
      const { data: activityIdResult, error } = await supabase.rpc('insert_ap_activity_outbound', {
        p_ap_id: activityId,
        p_ap_type: activityType,
        p_actor_id: postData.author_id,
        p_actor_ap_id: actorData.federated_id,
        p_activity_data: activityData,
        p_object_id: postId,
        p_object_type: 'Note'
      })

      if (error) {
        debug.error('❌ Federation: Failed to create post activity:', error)
        return { success: false, error: error.message }
      }

      debug.log(`✅ Federation: Post activity created: ${activityId}`)
      return { success: true, activityId: activityIdResult }

    } catch (error) {
      debug.error('❌ Federation: Error creating post activity:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  // =====================================================
  // FOLLOW ACTIVITIES (FOLLOW/UNDO)
  // =====================================================

  /**
   * Create follow activity
   */
  async createFollowActivity(
    followerId: string, 
    targetUserId: string, 
    operation: 'follow' | 'unfollow'
  ): Promise<ActivityCreationResult> {
    try {
      debug.log(`📤 Federation: Creating follow activity (${operation})`)

      // Get actor and target data
      const actorData = await this.getActorData(followerId)
      const targetData = await this.getActorData(targetUserId)

      if (!actorData || !targetData) {
        return { success: false, error: 'Missing required data for activity creation' }
      }

      // Generate activity ID and determine type
      const instanceDomain = await this.getInstanceDomain()
      const activityId = `${instanceDomain}/activities/${crypto.randomUUID()}`
      const activityType = operation === 'follow' ? 'Follow' : 'Undo'

      // Create follow activity data
      const activityData = await this.buildFollowActivityData({
        activityId,
        activityType,
        actor: actorData,
        target: targetData,
        operation
      })

      // Use RPC to bypass PostgREST schema cache
      const { data: activityIdResult, error } = await supabase.rpc('insert_ap_activity_outbound', {
        p_ap_id: activityId,
        p_ap_type: activityType,
        p_actor_id: followerId,
        p_actor_ap_id: actorData.federated_id,
        p_activity_data: activityData,
        p_object_id: targetUserId,
        p_object_type: operation === 'follow' ? 'Person' : 'Follow'
      })

      if (error) {
        debug.error('❌ Federation: Failed to create follow activity:', error)
        return { success: false, error: error.message }
      }

      debug.log(`✅ Federation: Follow activity created: ${activityId}`)
      return { success: true, activityId: activityIdResult }

    } catch (error) {
      debug.error('❌ Federation: Error creating follow activity:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  // =====================================================
  // PROFILE ACTIVITIES (UPDATE)
  // =====================================================

  /**
   * Create profile update activity
   */
  async createProfileUpdateActivity(userId: string): Promise<ActivityCreationResult> {
    try {
      debug.log(`📤 Federation: Creating profile update activity`)

      // Get actor data
      const actorData = await this.getActorData(userId)

      if (!actorData) {
        return { success: false, error: 'Missing required data for activity creation' }
      }

      // Generate activity ID
      const instanceDomain = await this.getInstanceDomain()
      const activityId = `${instanceDomain}/activities/${crypto.randomUUID()}`

      // Create profile update activity data
      const activityData = await this.buildProfileUpdateActivityData({
        activityId,
        actor: actorData
      })

      const { data: activityIdResult, error } = await supabase
        .rpc('insert_ap_activity_outbound', {
          p_ap_id: activityId,
          p_ap_type: 'Update',
          p_actor_id: userId,
          p_actor_ap_id: actorData.federated_id,
          p_activity_data: activityData,
          p_object_id: userId,
          p_object_type: 'Person'
        })

      if (error) {
        debug.error('❌ Federation: Failed to create profile update activity:', error)
        return { success: false, error: error.message }
      }

      debug.log(`✅ Federation: Profile update activity created: ${activityId}`)
      return { success: true, activityId: activityIdResult }

    } catch (error) {
      debug.error('❌ Federation: Error creating profile update activity:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  // =====================================================
  // ACTIVITY DATA BUILDERS (COMPATIBLE WITH YOUR EDGE FUNCTIONS)
  // =====================================================

  private async buildPostActivityData(params: {
    activityId: string
    activityType: string
    actor: any
    postData: any
    operation: string
  }) {
    const { activityId, activityType, actor, postData, operation } = params
    const instanceDomain = await this.getInstanceDomain()

    // Use your existing content conversion function
    const { data: htmlContent } = await supabase
      .rpc('convert_jsonb_to_ap', { content: postData.content })

    const noteObject = {
      id: `${instanceDomain}/posts/${postData.id}`,  // FIXED: instanceDomain now includes https://
      type: 'Note',
      published: postData.created_at,
      attributedTo: actor.federated_id,
      content: htmlContent,
      to: this.getAudienceForVisibility(postData.visibility),
      cc: []
    }

    if (operation === 'delete') {
      return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: activityId,  // FIXED: activityId now includes https:// from getInstanceDomain
        type: 'Delete',
        actor: actor.federated_id,
        object: noteObject,
        published: new Date().toISOString()
      }
    }

    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,  // FIXED: activityId now includes https:// from getInstanceDomain
      type: activityType,
      actor: actor.federated_id,
      object: noteObject,
      published: new Date().toISOString()
    }
  }

  private async buildFollowActivityData(params: {
    activityId: string
    activityType: string
    actor: any
    target: any
    operation: string
  }) {
    const { activityId, actor, target, operation } = params

    if (operation === 'follow') {
      return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: activityId,
        type: 'Follow',
        actor: actor.federated_id,
        object: target.federated_id,
        published: new Date().toISOString()
      }
    } else {
      return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: activityId,
        type: 'Undo',
        actor: actor.federated_id,
        object: {
          type: 'Follow',
          object: target.federated_id
        },
        published: new Date().toISOString()
      }
    }
  }

  private async buildProfileUpdateActivityData(params: {
    activityId: string
    actor: any
  }) {
    const { activityId, actor } = params
    const instanceDomain = await this.getInstanceDomain()

    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,
      type: 'Update',
      actor: actor.federated_id,
      object: {
        id: actor.federated_id,
        type: 'Person',
        preferredUsername: actor.username,
        name: actor.display_name,
        summary: actor.bio,
        icon: actor.avatar_url ? {
          type: 'Image',
          url: actor.avatar_url
        } : undefined,
        image: actor.banner_url ? {
          type: 'Image',
          url: actor.banner_url
        } : undefined,
        inbox: `${instanceDomain}/users/${actor.username}/inbox`,
        outbox: `${instanceDomain}/users/${actor.username}/outbox`,
        publicKey: {
          id: `${actor.federated_id}#main-key`,
          owner: actor.federated_id,
          publicKeyPem: actor.public_key
        }
      },
      published: new Date().toISOString()
    }
  }

  // =====================================================
  // DATA FETCHERS (INTEGRATE WITH YOUR DATABASE)
  // =====================================================

  private async getPostData(postId: string) {
    const { data, error } = await supabase
      .from('posts')
      .select('id, content, author_id, visibility, created_at, is_local, ap_id')
      .eq('id', postId)
      .single()

    return error ? null : data
  }

  private async getActorData(userId: string) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, bio, avatar_url, banner_url, federated_id, public_key')
      .eq('id', userId)
      .single()

    return error ? null : data
  }

  private async getInstanceDomain(): Promise<string> {
    try {
      const { data, error } = await supabase
        .rpc('get_instance_domain')

      if (error) {
        debug.warn('Failed to get instance domain, using fallback:', error)
        return 'https://localhost'  // FIXED: Include protocol in fallback
      }

      // FIXED: Ensure protocol is included
      const domain = data || 'localhost'
      return domain.startsWith('http') ? domain : `https://${domain}`
    } catch (error) {
      debug.warn('Failed to get instance domain, using fallback:', error)
      return 'https://localhost'  // FIXED: Include protocol in fallback
    }
  }

  private getAudienceForVisibility(visibility: string): string[] {
    switch (visibility) {
      case 'public':
        return ['https://www.w3.org/ns/activitystreams#Public']
      case 'unlisted':
        return ['https://www.w3.org/ns/activitystreams#Public']
      case 'followers':
        return [] // Will be populated with actual followers
      case 'private':
        return []
      default:
        return []
    }
  }

  private createError(code: string, message: string, details?: any): FederationActivityServiceError {
    const secureDetails = import.meta.env.DEV ? details : undefined
    return { code, message, details: secureDetails }
  }
}

// Export singleton instance
export const federationActivityService = FederationActivityService.getInstance()