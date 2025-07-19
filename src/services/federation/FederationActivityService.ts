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

  // =====================================================
  // REACTION ACTIVITIES (LIKE/UNDO WITH EMOJI SUPPORT)
  // =====================================================

  /**
   * Create reaction activity for message reactions (DMs only)
   */
  async createMessageReactionActivity(
    messageId: string, 
    emojiId: string, 
    userId: string, 
    operation: 'add' | 'remove'
  ): Promise<ActivityCreationResult> {
    try {
      console.log(`📤 Federation: Creating message reaction activity (${operation})`)

      // Get message and emoji data
      const messageData = await this.getMessageData(messageId)
      const emojiData = await this.getEmojiData(emojiId)
      const actorData = await this.getActorData(userId)

      if (!messageData || !emojiData || !actorData) {
        return { success: false, error: 'Missing required data for activity creation' }
      }

      // Generate activity ID and determine type
      const instanceDomain = await this.getInstanceDomain()
      const activityId = `${instanceDomain}/activities/${crypto.randomUUID()}`
      const activityType = operation === 'add' ? 'Like' : 'Undo'

      // Create reaction activity data compatible with your edge functions
      const activityData = await this.buildReactionActivityData({
        activityId,
        activityType,
        actor: actorData,
        messageData,
        emojiData,
        operation
      })

      // Insert into ap_activities table (your edge functions read from here)
      const { data, error } = await supabase
        .from('ap_activities')
        .insert({
          ap_id: activityId,
          ap_type: activityType,
          actor_id: userId,
          actor_ap_id: actorData.federated_id,
          object_id: `message-${messageId}`,
          object_type: operation === 'add' ? 'Note' : 'Like',
          activity_data: activityData,
          status: 'pending',
          is_local: true,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single()

      if (error) {
        console.error('❌ Federation: Failed to create reaction activity:', error)
        return { success: false, error: error.message }
      }

      console.log(`✅ Federation: Message reaction activity created: ${activityId}`)
      return { success: true, activityId: data.id }

    } catch (error) {
      console.error('❌ Federation: Error creating message reaction activity:', error)
      return { success: false, error: error.message }
    }
  }

  /**
   * Create reaction activity for post reactions
   */
  async createPostReactionActivity(
    postId: string, 
    emojiId: string, 
    userId: string, 
    operation: 'add' | 'remove'
  ): Promise<ActivityCreationResult> {
    try {
      console.log(`📤 Federation: Creating post reaction activity (${operation})`)

      // Get post and emoji data
      const postData = await this.getPostData(postId)
      const emojiData = await this.getEmojiData(emojiId)
      const actorData = await this.getActorData(userId)

      if (!postData || !emojiData || !actorData) {
        return { success: false, error: 'Missing required data for activity creation' }
      }

      // Generate activity ID and determine type
      const instanceDomain = await this.getInstanceDomain()
      const activityId = `${instanceDomain}/activities/${crypto.randomUUID()}`
      const activityType = operation === 'add' ? 'Like' : 'Undo'

      // Create reaction activity data
      const activityData = await this.buildPostReactionActivityData({
        activityId,
        activityType,
        actor: actorData,
        postData,
        emojiData,
        operation
      })

      // Insert into ap_activities table
      const { data, error } = await supabase
        .from('ap_activities')
        .insert({
          ap_id: activityId,
          ap_type: activityType,
          actor_id: userId,
          actor_ap_id: actorData.federated_id,
          object_id: postId,
          object_type: operation === 'add' ? 'Note' : 'Like',
          activity_data: activityData,
          status: 'pending',
          is_local: true,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single()

      if (error) {
        console.error('❌ Federation: Failed to create post reaction activity:', error)
        return { success: false, error: error.message }
      }

      console.log(`✅ Federation: Post reaction activity created: ${activityId}`)
      return { success: true, activityId: data.id }

    } catch (error) {
      console.error('❌ Federation: Error creating post reaction activity:', error)
      return { success: false, error: error.message }
    }
  }

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
      console.log(`📤 Federation: Creating post activity (${operation})`)

      // Get post data
      const postData = await this.getPostData(postId)
      const actorData = await this.getActorData(postData.author_id)

      if (!postData || !actorData) {
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

      // Insert into ap_activities table
      const { data, error } = await supabase
        .from('ap_activities')
        .insert({
          ap_id: activityId,
          ap_type: activityType,
          actor_id: postData.author_id,
          actor_ap_id: actorData.federated_id,
          object_id: postId,
          object_type: 'Note',
          activity_data: activityData,
          status: 'pending',
          is_local: true,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single()

      if (error) {
        console.error('❌ Federation: Failed to create post activity:', error)
        return { success: false, error: error.message }
      }

      console.log(`✅ Federation: Post activity created: ${activityId}`)
      return { success: true, activityId: data.id }

    } catch (error) {
      console.error('❌ Federation: Error creating post activity:', error)
      return { success: false, error: error.message }
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
      console.log(`📤 Federation: Creating follow activity (${operation})`)

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

      // Insert into ap_activities table
      const { data, error } = await supabase
        .from('ap_activities')
        .insert({
          ap_id: activityId,
          ap_type: activityType,
          actor_id: followerId,
          actor_ap_id: actorData.federated_id,
          object_id: targetUserId,
          object_type: operation === 'follow' ? 'Person' : 'Follow',
          activity_data: activityData,
          status: 'pending',
          is_local: true,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single()

      if (error) {
        console.error('❌ Federation: Failed to create follow activity:', error)
        return { success: false, error: error.message }
      }

      console.log(`✅ Federation: Follow activity created: ${activityId}`)
      return { success: true, activityId: data.id }

    } catch (error) {
      console.error('❌ Federation: Error creating follow activity:', error)
      return { success: false, error: error.message }
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
      console.log(`📤 Federation: Creating profile update activity`)

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

      // Insert into ap_activities table
      const { data, error } = await supabase
        .from('ap_activities')
        .insert({
          ap_id: activityId,
          ap_type: 'Update',
          actor_id: userId,
          actor_ap_id: actorData.federated_id,
          object_id: userId,
          object_type: 'Person',
          activity_data: activityData,
          status: 'pending',
          is_local: true,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single()

      if (error) {
        console.error('❌ Federation: Failed to create profile update activity:', error)
        return { success: false, error: error.message }
      }

      console.log(`✅ Federation: Profile update activity created: ${activityId}`)
      return { success: true, activityId: data.id }

    } catch (error) {
      console.error('❌ Federation: Error creating profile update activity:', error)
      return { success: false, error: error.message }
    }
  }

  // =====================================================
  // ACTIVITY DATA BUILDERS (COMPATIBLE WITH YOUR EDGE FUNCTIONS)
  // =====================================================

  private async buildReactionActivityData(params: {
    activityId: string
    activityType: string
    actor: any
    messageData: any
    emojiData: any
    operation: 'add' | 'remove'
  }) {
    const { activityId, activityType, actor, messageData, emojiData, operation } = params
    const instanceDomain = await this.getInstanceDomain()

    if (operation === 'add') {
      // Like activity with emoji support (Pleroma/Misskey compatible)
      return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: activityId,
        type: 'Like',
        actor: actor.federated_id,
        object: `${instanceDomain}/messages/${messageData.id}`,
        published: new Date().toISOString(),
        content: emojiData.shortcode,
        tag: [{
          id: emojiData.url,
          type: 'Emoji',
          name: emojiData.shortcode,
          icon: {
            type: 'Image',
            url: emojiData.url
          }
        }]
      }
    } else {
      // Undo Like activity
      return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: activityId,
        type: 'Undo',
        actor: actor.federated_id,
        object: {
          type: 'Like',
          object: `${instanceDomain}/messages/${messageData.id}`,
          content: emojiData.shortcode
        },
        published: new Date().toISOString()
      }
    }
  }

  private async buildPostReactionActivityData(params: {
    activityId: string
    activityType: string
    actor: any
    postData: any
    emojiData: any
    operation: 'add' | 'remove'
  }) {
    const { activityId, activityType, actor, postData, emojiData, operation } = params
    const instanceDomain = await this.getInstanceDomain()

    if (operation === 'add') {
      // Like activity with emoji support
      return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: activityId,
        type: 'Like',
        actor: actor.federated_id,
        object: `${instanceDomain}/posts/${postData.id}`,
        published: new Date().toISOString(),
        content: emojiData.shortcode,
        tag: [{
          id: emojiData.url,
          type: 'Emoji',
          name: emojiData.shortcode,
          icon: {
            type: 'Image',
            url: emojiData.url
          }
        }]
      }
    } else {
      // Undo Like activity
      return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: activityId,
        type: 'Undo',
        actor: actor.federated_id,
        object: {
          type: 'Like',
          object: `${instanceDomain}/posts/${postData.id}`,
          content: emojiData.shortcode
        },
        published: new Date().toISOString()
      }
    }
  }

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
      id: `${instanceDomain}/posts/${postData.id}`,
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
        id: activityId,
        type: 'Delete',
        actor: actor.federated_id,
        object: noteObject,
        published: new Date().toISOString()
      }
    }

    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,
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
    const { activityId, activityType, actor, target, operation } = params

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

  private async getMessageData(messageId: string) {
    const { data, error } = await supabase
      .from('messages')
      .select('id, content, user_id, created_at')
      .eq('id', messageId)
      .single()

    return error ? null : data
  }

  private async getPostData(postId: string) {
    const { data, error } = await supabase
      .from('posts')
      .select('id, content, author_id, visibility, created_at, is_local')
      .eq('id', postId)
      .single()

    return error ? null : data
  }

  private async getEmojiData(emojiId: string) {
    const { data, error } = await supabase
      .from('custom_emojis')
      .select('id, shortcode, url')
      .eq('id', emojiId)
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
    const { data } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'domain')
      .single()

    return data?.config_value?.replace(/"/g, '') || 'localhost'
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
    const secureDetails = process.env.NODE_ENV === 'development' ? details : undefined
    return { code, message, details: secureDetails }
  }
}

// Export singleton instance
export const federationActivityService = FederationActivityService.getInstance()