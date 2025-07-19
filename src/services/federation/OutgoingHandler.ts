/**
 * Unified Outgoing Federation Handler
 * 
 * Single entry point for all outgoing ActivityPub activities.
 * Handles conversion from our local format to ActivityPub format.
 * 
 * This replaces scattered federation calls with a clean, unified approach.
 * Federation is optional - if disabled, this handler does nothing.
 */

import { supabase } from '@/supabase'
import type { Post, Message, MessagePart } from '@/types'

export interface OutgoingHandlerConfig {
  federationEnabled: boolean
  instanceDomain: string
  instanceUrl: string
}

export interface FederationTarget {
  domain: string
  inboxUrl: string
  priority?: number
}

export class OutgoingHandler {
  private config: OutgoingHandlerConfig
  
  constructor(config: OutgoingHandlerConfig) {
    this.config = config
  }
  
  /**
   * Federate a post to followers and mentioned users
   */
  async federatePost(post: {
    id: string
    content: MessagePart[]
    visibility: string
    author_id: string
    in_reply_to?: string
    content_warning?: string
  }): Promise<{ success: boolean; error?: string; targets?: string[] }> {
    console.log('📤 OutgoingHandler: Federating post:', post.id)
    
    // Early return if federation is disabled
    if (!this.config.federationEnabled) {
      console.log('🚫 Federation disabled, skipping post federation')
      return { success: false, error: 'Federation disabled' }
    }
    
    try {
      // Convert to ActivityPub format
      const activity = await this.convertPostToActivity(post)
      
      // Determine federation targets based on visibility and mentions
      const targets = await this.getPostFederationTargets(post)
      
      if (targets.length === 0) {
        console.log('📍 No federation targets for post, marking as local-only')
        return { success: true, targets: [] }
      }
      
      // Queue for delivery
      await this.queueActivityForDelivery(activity, targets, {
        sourceType: 'post',
        sourceId: post.id,
        priority: this.getPostPriority(post.visibility)
      })
      
      console.log(`✅ Post queued for federation to ${targets.length} targets`)
      return { success: true, targets: targets.map(t => t.domain) }
      
    } catch (error) {
      console.error('❌ Error federating post:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Federate a direct message to recipient
   */
  async federateDM(message: {
    id: string
    content: MessagePart[]
    user_id: string
    conversation_id: string
    recipient_id: string
  }): Promise<{ success: boolean; error?: string; targets?: string[] }> {
    console.log('📨 OutgoingHandler: Federating DM:', message.id)
    
    if (!this.config.federationEnabled) {
      console.log('🚫 Federation disabled, skipping DM federation')
      return { success: false, error: 'Federation disabled' }
    }
    
    try {
      // Check if recipient is remote
      const targets = await this.getDMFederationTargets(message.recipient_id)
      
      if (targets.length === 0) {
        console.log('📍 Recipient is local, no federation needed')
        return { success: true, targets: [] }
      }
      
      // Convert to ActivityPub format
      const activity = await this.convertDMToActivity(message)
      
      // Queue for delivery
      await this.queueActivityForDelivery(activity, targets, {
        sourceType: 'dm',
        sourceId: message.id,
        priority: 8 // High priority for DMs
      })
      
      console.log(`✅ DM queued for federation to ${targets.length} targets`)
      return { success: true, targets: targets.map(t => t.domain) }
      
    } catch (error) {
      console.error('❌ Error federating DM:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Federate a follow request
   */
  async federateFollow(followData: {
    follower_id: string
    following_id: string
    follow_id: string
  }): Promise<{ success: boolean; error?: string }> {
    console.log('👥 OutgoingHandler: Federating follow:', followData.follow_id)
    
    if (!this.config.federationEnabled) {
      return { success: false, error: 'Federation disabled' }
    }
    
    try {
      // Check if target user is remote
      const targets = await this.getFollowFederationTargets(followData.following_id)
      
      if (targets.length === 0) {
        console.log('📍 Target user is local, no federation needed')
        return { success: true }
      }
      
      const activity = await this.convertFollowToActivity(followData)
      
      await this.queueActivityForDelivery(activity, targets, {
        sourceType: 'follow',
        sourceId: followData.follow_id,
        priority: 6
      })
      
      console.log('✅ Follow queued for federation')
      return { success: true }
      
    } catch (error) {
      console.error('❌ Error federating follow:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Federate a like/reaction
   */
  async federateLike(likeData: {
    user_id: string
    post_id: string
    emoji?: string
  }): Promise<{ success: boolean; error?: string }> {
    console.log('❤️ OutgoingHandler: Federating like for post:', likeData.post_id)
    
    if (!this.config.federationEnabled) {
      return { success: false, error: 'Federation disabled' }
    }
    
    try {
      const targets = await this.getLikeFederationTargets(likeData.post_id)
      
      if (targets.length === 0) {
        return { success: true }
      }
      
      const activity = await this.convertLikeToActivity(likeData)
      
      await this.queueActivityForDelivery(activity, targets, {
        sourceType: 'like',
        sourceId: `${likeData.user_id}-${likeData.post_id}`,
        priority: 4
      })
      
      return { success: true }
      
    } catch (error) {
      console.error('❌ Error federating like:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Convert post to ActivityPub Create activity
   */
  private async convertPostToActivity(post: any): Promise<any> {
    // Get author profile
    const { data: author } = await supabase
      .from('profiles')
      .select('username, display_name, domain')
      .eq('id', post.author_id)
      .single()
    
    const actorUrl = `${this.config.instanceUrl}/users/${author.username}`
    const postUrl = `${this.config.instanceUrl}/posts/${post.id}`
    const activityId = `${actorUrl}#create-${post.id}`
    
    // Convert content to HTML
    const htmlContent = await this.convertContentToHTML(post.content)
    
    // Extract mentions and tags
    const { mentions, tags } = await this.extractMentionsAndTags(post.content)
    
    // Build addressing
    const addressing = await this.buildPostAddressing(post, mentions)
    
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Create',
      id: activityId,
      actor: actorUrl,
      published: new Date().toISOString(),
      to: addressing.to,
      cc: addressing.cc,
      object: {
        type: 'Note',
        id: postUrl,
        attributedTo: actorUrl,
        content: htmlContent,
        published: new Date().toISOString(),
        to: addressing.to,
        cc: addressing.cc,
        tag: [...mentions, ...tags],
        ...(post.in_reply_to && { inReplyTo: `${this.config.instanceUrl}/posts/${post.in_reply_to}` }),
        ...(post.content_warning && { summary: post.content_warning })
      }
    }
  }
  
  /**
   * Convert DM to ActivityPub Create activity
   */
  private async convertDMToActivity(message: any): Promise<any> {
    // Get sender and recipient profiles
    const { data: sender } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', message.user_id)
      .single()
      
    const { data: recipient } = await supabase
      .from('profiles')
      .select('username, federated_id')
      .eq('id', message.recipient_id)
      .single()
    
    const senderUrl = `${this.config.instanceUrl}/users/${sender.username}`
    const messageUrl = `${this.config.instanceUrl}/messages/${message.id}`
    const activityId = `${senderUrl}#dm-${message.id}`
    
    const htmlContent = await this.convertContentToHTML(message.content)
    const { mentions } = await this.extractMentionsAndTags(message.content)
    
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Create',
      id: activityId,
      actor: senderUrl,
      published: new Date().toISOString(),
      to: [recipient.federated_id],
      object: {
        type: 'Note',
        id: messageUrl,
        attributedTo: senderUrl,
        content: htmlContent,
        published: new Date().toISOString(),
        to: [recipient.federated_id],
        tag: mentions
      }
    }
  }
  
  /**
   * Convert follow to ActivityPub Follow activity
   */
  private async convertFollowToActivity(followData: any): Promise<any> {
    const { data: follower } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', followData.follower_id)
      .single()
      
    const { data: following } = await supabase
      .from('profiles')
      .select('federated_id')
      .eq('id', followData.following_id)
      .single()
    
    const followerUrl = `${this.config.instanceUrl}/users/${follower.username}`
    const activityId = `${followerUrl}#follow-${followData.follow_id}`
    
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Follow',
      id: activityId,
      actor: followerUrl,
      object: following.federated_id,
      published: new Date().toISOString()
    }
  }
  
  /**
   * Convert like to ActivityPub Like activity
   */
  private async convertLikeToActivity(likeData: any): Promise<any> {
    const { data: user } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', likeData.user_id)
      .single()
    
    const userUrl = `${this.config.instanceUrl}/users/${user.username}`
    const postUrl = `${this.config.instanceUrl}/posts/${likeData.post_id}`
    const activityId = `${userUrl}#like-${likeData.post_id}`
    
    const activity: any = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Like',
      id: activityId,
      actor: userUrl,
      object: postUrl,
      published: new Date().toISOString()
    }
    
    // Add Misskey-style reaction if emoji is provided
    if (likeData.emoji) {
      activity.content = likeData.emoji
      activity['_misskey_reaction'] = likeData.emoji
    }
    
    return activity
  }
  
  /**
   * Get federation targets for a post based on visibility and followers
   */
  private async getPostFederationTargets(post: any): Promise<FederationTarget[]> {
    const targets: FederationTarget[] = []
    
    if (post.visibility === 'private') {
      return targets // No federation for private posts
    }
    
    // Get domains of followers and mentioned users
    const { data: domains } = await supabase.rpc('get_post_federation_targets', {
      p_post_id: post.id,
      p_visibility: post.visibility,
      p_author_id: post.author_id
    })
    
    return domains?.map((domain: string) => ({
      domain,
      inboxUrl: `https://${domain}/inbox`
    })) || []
  }
  
  /**
   * Get federation targets for a DM
   */
  private async getDMFederationTargets(recipientId: string): Promise<FederationTarget[]> {
    const { data: recipient } = await supabase
      .from('profiles')
      .select('domain, inbox_url, is_local')
      .eq('id', recipientId)
      .single()
    
    if (!recipient || recipient.is_local) {
      return []
    }
    
    return [{
      domain: recipient.domain,
      inboxUrl: recipient.inbox_url
    }]
  }
  
  /**
   * Get federation targets for a follow
   */
  private async getFollowFederationTargets(followingId: string): Promise<FederationTarget[]> {
    const { data: user } = await supabase
      .from('profiles')
      .select('domain, inbox_url, is_local')
      .eq('id', followingId)
      .single()
    
    if (!user || user.is_local) {
      return []
    }
    
    return [{
      domain: user.domain,
      inboxUrl: user.inbox_url
    }]
  }
  
  /**
   * Get federation targets for a like
   */
  private async getLikeFederationTargets(postId: string): Promise<FederationTarget[]> {
    // For likes, we federate to the post author's domain
    const { data: post } = await supabase
      .from('posts')
      .select(`
        author_id,
        profiles!posts_author_id_fkey (domain, inbox_url, is_local)
      `)
      .eq('id', postId)
      .single()
    
    if (!post?.profiles || post.profiles.is_local) {
      return []
    }
    
    return [{
      domain: post.profiles.domain,
      inboxUrl: post.profiles.inbox_url
    }]
  }
  
  /**
   * Queue activity for delivery via edge functions
   */
  private async queueActivityForDelivery(
    activity: any, 
    targets: FederationTarget[], 
    metadata: {
      sourceType: string
      sourceId: string
      priority: number
    }
  ): Promise<void> {
    // Store activity in ap_activities table
    const { data: activityRecord, error: activityError } = await supabase
      .from('ap_activities')
      .insert({
        ap_id: activity.id,
        ap_type: activity.type,
        actor_id: await this.getActorIdFromUrl(activity.actor),
        activity_data: activity,
        status: 'pending',
        is_local: true,
        origin_domain: this.config.instanceDomain
      })
      .select('id')
      .single()
    
    if (activityError) {
      throw new Error(`Failed to store activity: ${activityError.message}`)
    }
    
    // Queue for delivery to each target domain
    const domains = targets.map(t => t.domain)
    await supabase.rpc('queue_activity_for_federation', {
      p_activity_id: activityRecord.id,
      p_target_domains: domains,
      p_priority: metadata.priority,
      p_immediate: true
    })
  }
  
  /**
   * Helper methods
   */
  private async convertContentToHTML(content: MessagePart[]): Promise<string> {
    // Use existing utility function
    const { convertUnifiedContentToHTML } = await import('@/utils/unifiedContentProcessing')
    return convertUnifiedContentToHTML(content)
  }
  
  private async extractMentionsAndTags(content: MessagePart[]): Promise<{
    mentions: any[]
    tags: any[]
  }> {
    const mentions: any[] = []
    const tags: any[] = []
    
    for (const part of content) {
      if (part.type === 'mention' && part.username && part.domain) {
        mentions.push({
          type: 'Mention',
          href: `https://${part.domain}/users/${part.username}`,
          name: `@${part.username}@${part.domain}`
        })
      } else if (part.type === 'hashtag' && part.text) {
        tags.push({
          type: 'Hashtag',
          href: `${this.config.instanceUrl}/tags/${part.text}`,
          name: `#${part.text}`
        })
      }
    }
    
    return { mentions, tags }
  }
  
  private async buildPostAddressing(post: any, mentions: any[]): Promise<{
    to: string[]
    cc: string[]
  }> {
    const to: string[] = []
    const cc: string[] = []
    
    switch (post.visibility) {
      case 'public':
        to.push('https://www.w3.org/ns/activitystreams#Public')
        cc.push(`${this.config.instanceUrl}/users/${post.author_id}/followers`)
        break
      case 'unlisted':
        cc.push('https://www.w3.org/ns/activitystreams#Public')
        to.push(`${this.config.instanceUrl}/users/${post.author_id}/followers`)
        break
      case 'followers':
        to.push(`${this.config.instanceUrl}/users/${post.author_id}/followers`)
        break
    }
    
    // Add mentions to addressing
    mentions.forEach(mention => to.push(mention.href))
    
    return { to, cc }
  }
  
  private async getActorIdFromUrl(actorUrl: string): Promise<string> {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single()
    
    return profile?.id
  }
  
  private getPostPriority(visibility: string): number {
    switch (visibility) {
      case 'public': return 5
      case 'unlisted': return 5
      case 'followers': return 6
      case 'mentioned': return 7
      default: return 5
    }
  }
}

/**
 * Factory function to create OutgoingHandler with current config
 */
export async function createOutgoingHandler(): Promise<OutgoingHandler> {
  // Get federation settings
  const { data: federationConfig } = await supabase
    .from('instance_config')
    .select('config_key, config_value')
    .in('config_key', ['federation_enabled', 'domain'])
  
  const federationEnabled = federationConfig?.find(c => c.config_key === 'federation_enabled')?.config_value === 'true'
  const instanceDomain = federationConfig?.find(c => c.config_key === 'domain')?.config_value?.replace(/"/g, '') || 'har.mony.lol'
  const instanceUrl = `https://${instanceDomain}`
  
  return new OutgoingHandler({
    federationEnabled,
    instanceDomain,
    instanceUrl
  })
}