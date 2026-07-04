/** Federation eligibility checks. */
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export interface FederationDecision {
  shouldFederate: boolean
  reason: string
  federationType?: 'dm' | 'post' | 'follow' | 'reaction'
}

export interface FederationDecisionServiceError {
  code: string
  message: string
  details?: any
}

export class FederationDecisionService {
  private static instance: FederationDecisionService
  
  static getInstance(): FederationDecisionService {
    if (!this.instance) {
      this.instance = new FederationDecisionService()
    }
    return this.instance
  }

  // REACTION FEDERATION DECISIONS (LOCAL-FIRST)

  /**
   * Decide if a reaction should be federated (clean local-first logic)
   */
  async shouldFederateReaction(messageId: string, userId: string): Promise<FederationDecision> {
    try {
      debug.log(`🤔 Federation: Deciding reaction federation for message: ${messageId}`)

      // 1. Check user federation settings
      const userDecision = await this.checkUserFederationEnabled(userId)
      if (!userDecision.shouldFederate) {
        return userDecision
      }

      // 2. Check instance federation settings
      const instanceDecision = await this.checkInstanceFederationEnabled()
      if (!instanceDecision.shouldFederate) {
        return instanceDecision
      }

      // 3. Determine message type (LOCAL-FIRST LOGIC)
      const messageType = await this.getMessageType(messageId)
      
      if (messageType === 'chat') {
        // Chat reactions stay local (your smart design!)
        return {
          shouldFederate: false,
          reason: 'Chat reactions stay local per local-first design',
          federationType: 'reaction'
        }
      }

      if (messageType === 'dm') {
        // DM reactions should federate  
        return {
          shouldFederate: true,
          reason: 'DM reaction eligible for federation',
          federationType: 'dm'
        }
      }

      // Unknown message type
      return {
        shouldFederate: false,
        reason: `Unknown message type: ${messageType}`,
        federationType: 'reaction'
      }

    } catch (error) {
      debug.error('❌ Federation: Failed to decide reaction federation:', error)
      return {
        shouldFederate: false,
        reason: `Error checking federation: ${(error as Error).message}`
      }
    }
  }

  /**
   * Decide if a post reaction should be federated
   */
  async shouldFederatePostReaction(postId: string, userId: string): Promise<FederationDecision> {
    try {
      debug.log(`🤔 Federation: Deciding post reaction federation for post: ${postId}`)

      // 1. Check user federation settings
      const userDecision = await this.checkUserFederationEnabled(userId)
      if (!userDecision.shouldFederate) {
        return userDecision
      }

      // 2. Check instance federation settings
      const instanceDecision = await this.checkInstanceFederationEnabled()
      if (!instanceDecision.shouldFederate) {
        return instanceDecision
      }

      // 3. Check post visibility and federation eligibility
      const postDecision = await this.checkPostFederationEligible(postId)
      if (!postDecision.shouldFederate) {
        return postDecision
      }

      // Post reactions should federate if all checks pass
      return {
        shouldFederate: true,
        reason: 'Post reaction eligible for federation',
        federationType: 'reaction'
      }

    } catch (error) {
      debug.error('❌ Federation: Failed to decide post reaction federation:', error)
      return {
        shouldFederate: false,
        reason: `Error checking federation: ${(error as Error).message}`
      }
    }
  }

  // POST FEDERATION DECISIONS

  /**
   * Decide if a post should be federated
   */
  async shouldFederatePost(postId: string, operation: 'create' | 'update' | 'delete'): Promise<FederationDecision> {
    try {
      debug.log(`🤔 Federation: Deciding post federation for post: ${postId} (${operation})`)

      const { data: post, error } = await supabase
        .from('posts')
        .select('author_id, visibility, is_local')
        .eq('id', postId)
        .single()

      if (error || !post) {
        return {
          shouldFederate: false,
          reason: 'Post not found or error retrieving post'
        }
      }

      // Only federate local posts
      if (!post.is_local) {
        return {
          shouldFederate: false,
          reason: 'Only local posts are federated'
        }
      }

      // 1. Check user federation settings
      const userDecision = await this.checkUserFederationEnabled(post.author_id)
      if (!userDecision.shouldFederate) {
        return userDecision
      }

      // 2. Check instance federation settings
      const instanceDecision = await this.checkInstanceFederationEnabled()
      if (!instanceDecision.shouldFederate) {
        return instanceDecision
      }

      // 3. Check post visibility (only public/unlisted posts federate)
      if (!['public', 'unlisted'].includes(post.visibility)) {
        return {
          shouldFederate: false,
          reason: `Posts with visibility '${post.visibility}' do not federate`,
          federationType: 'post'
        }
      }

      // Post should federate
      return {
        shouldFederate: true,
        reason: `Post ${operation} eligible for federation`,
        federationType: 'post'
      }

    } catch (error) {
      debug.error('❌ Federation: Failed to decide post federation:', error)
      return {
        shouldFederate: false,
        reason: `Error checking federation: ${(error as Error).message}`
      }
    }
  }

  // FOLLOW FEDERATION DECISIONS

  /**
   * Decide if a follow should be federated
   */
  async shouldFederateFollow(followerId: string, targetUserId: string, operation: 'follow' | 'unfollow'): Promise<FederationDecision> {
    try {
      debug.log(`🤔 Federation: Deciding follow federation: ${followerId} → ${targetUserId} (${operation})`)

      // 1. Check follower federation settings
      const followerDecision = await this.checkUserFederationEnabled(followerId)
      if (!followerDecision.shouldFederate) {
        return followerDecision
      }

      // 2. Check instance federation settings
      const instanceDecision = await this.checkInstanceFederationEnabled()
      if (!instanceDecision.shouldFederate) {
        return instanceDecision
      }

      // 3. Check if target user is remote (only federate to remote users)
      const { data: targetUser } = await supabase
        .from('profiles')
        .select('is_local, domain')
        .eq('id', targetUserId)
        .single()

      if (!targetUser) {
        return {
          shouldFederate: false,
          reason: 'Target user not found'
        }
      }

      if (targetUser.is_local) {
        return {
          shouldFederate: false,
          reason: 'Local follows do not require federation',
          federationType: 'follow'
        }
      }

      // Remote follow should federate
      return {
        shouldFederate: true,
        reason: `${operation} remote user eligible for federation`,
        federationType: 'follow'
      }

    } catch (error) {
      debug.error('❌ Federation: Failed to decide follow federation:', error)
      return {
        shouldFederate: false,
        reason: `Error checking federation: ${(error as Error).message}`
      }
    }
  }

  // PROFILE UPDATE FEDERATION DECISIONS

  /**
   * Decide if a profile update should be federated
   */
  async shouldFederateProfileUpdate(userId: string): Promise<FederationDecision> {
    try {
      debug.log(`🤔 Federation: Deciding profile update federation for user: ${userId}`)

      // 1. Check user federation settings
      const userDecision = await this.checkUserFederationEnabled(userId)
      if (!userDecision.shouldFederate) {
        return userDecision
      }

      // 2. Check instance federation settings
      const instanceDecision = await this.checkInstanceFederationEnabled()
      if (!instanceDecision.shouldFederate) {
        return instanceDecision
      }

      // 3. Check if user is local (only federate local profile updates)
      const { data: user } = await supabase
        .from('profiles')
        .select('is_local')
        .eq('id', userId)
        .single()

      if (!user || !user.is_local) {
        return {
          shouldFederate: false,
          reason: 'Only local profile updates are federated'
        }
      }

      // Profile update should federate
      return {
        shouldFederate: true,
        reason: 'Profile update eligible for federation'
      }

    } catch (error) {
      debug.error('❌ Federation: Failed to decide profile update federation:', error)
      return {
        shouldFederate: false,
        reason: `Error checking federation: ${(error as Error).message}`
      }
    }
  }

  // HELPER METHODS (CLEAN DECISION LOGIC)

  /**
   * Check if federation is enabled for a specific user
   */
  private async checkUserFederationEnabled(userId: string): Promise<FederationDecision> {
    try {
      // Use your existing database function (smart!)
      const { data, error } = await supabase
        .rpc('is_federation_enabled_for_user', { user_id: userId })

      if (error) {
        debug.error('❌ Federation: Error checking user federation settings:', error)
        return {
          shouldFederate: false,
          reason: 'Error checking user federation settings'
        }
      }

      if (!data) {
        return {
          shouldFederate: false,
          reason: 'Federation disabled for user'
        }
      }

      return {
        shouldFederate: true,
        reason: 'User federation enabled'
      }
    } catch (error) {
      return {
        shouldFederate: false,
        reason: 'Error checking user federation settings'
      }
    }
  }

  /**
   * Check if federation is enabled at instance level
   */
  private async checkInstanceFederationEnabled(): Promise<FederationDecision> {
    try {
      const { data, error } = await supabase
        .rpc('get_public_federation_settings')

      if (error || !data) {
        // Default to enabled if no settings found (your smart default)
        return {
          shouldFederate: true,
          reason: 'Instance federation enabled (default)'
        }
      }

      const federationEnabled = data?.federation_enabled ?? true

      if (!federationEnabled) {
        return {
          shouldFederate: false,
          reason: 'Federation disabled at instance level'
        }
      }

      return {
        shouldFederate: true,
        reason: 'Instance federation enabled'
      }
    } catch (error) {
      // Default to enabled on error (fail-open for federation)
      return {
        shouldFederate: true,
        reason: 'Instance federation enabled (error default)'
      }
    }
  }

  /**
   * Determine message type for federation decisions
   */
  private async getMessageType(messageId: string): Promise<'chat' | 'dm' | 'unknown'> {
    try {
      const { data: message, error } = await supabase
        .from('messages')
        .select(`
          conversation_id,
          channel_id,
          channels(server_id)
        `)
        .eq('id', messageId)
        .single()

      if (error || !message) {
        return 'unknown'
      }

      // DM: has conversation_id, no channel_id
      if (message.conversation_id && !message.channel_id) {
        return 'dm'
      }

      // Chat: has channel_id (server message)
      if (message.channel_id) {
        return 'chat'
      }

      return 'unknown'
    } catch (error) {
      debug.error('❌ Federation: Error determining message type:', error)
      return 'unknown'
    }
  }

  /**
   * Check if a post is eligible for federation
   */
  private async checkPostFederationEligible(postId: string): Promise<FederationDecision> {
    try {
      const { data: post, error } = await supabase
        .from('posts')
        .select('visibility, is_local')
        .eq('id', postId)
        .single()

      if (error || !post) {
        return {
          shouldFederate: false,
          reason: 'Post not found'
        }
      }

      if (!post.is_local) {
        return {
          shouldFederate: false,
          reason: 'Only local posts are eligible for federation'
        }
      }

      if (!['public', 'unlisted'].includes(post.visibility)) {
        return {
          shouldFederate: false,
          reason: `Posts with visibility '${post.visibility}' are not eligible for federation`
        }
      }

      return {
        shouldFederate: true,
        reason: 'Post is eligible for federation'
      }
    } catch (error) {
      return {
        shouldFederate: false,
        reason: 'Error checking post eligibility'
      }
    }
  }

  private createError(code: string, message: string, details?: any): FederationDecisionServiceError {
    const secureDetails = import.meta.env.DEV ? details : undefined
    return { code, message, details: secureDetails }
  }
}

export const federationDecisionService = FederationDecisionService.getInstance()