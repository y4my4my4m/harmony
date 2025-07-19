/**
 * Unified Incoming Federation Handler
 * 
 * Single entry point for all incoming ActivityPub activities.
 * Handles conversion from ActivityPub format to our local format.
 * 
 * This replaces the scattered federation functions with a clean, unified approach.
 * Federation is optional - if disabled, this handler does nothing.
 */

import { supabase } from '@/supabase'
import type { ActivityPubActivity, ActivityPubActivityType } from '@/types'

export interface IncomingHandlerConfig {
  federationEnabled: boolean
  instanceDomain: string
  instanceUrl: string
}

export class IncomingHandler {
  private config: IncomingHandlerConfig
  
  constructor(config: IncomingHandlerConfig) {
    this.config = config
  }
  
  /**
   * Main entry point for incoming activities
   * Validates, processes, and converts to local format
   */
  async processActivity(activity: ActivityPubActivity): Promise<{ success: boolean; error?: string }> {
    console.log('🌐 IncomingHandler: Processing activity:', activity.type, activity.id)
    
    // Early return if federation is disabled
    if (!this.config.federationEnabled) {
      console.log('🚫 Federation disabled, skipping incoming activity')
      return { success: false, error: 'Federation disabled' }
    }
    
    try {
      // Validate activity structure
      if (!this.validateActivity(activity)) {
        return { success: false, error: 'Invalid activity structure' }
      }
      
      // Check if actor is blocked
      const isBlocked = await this.isActorBlocked(activity.actor)
      if (isBlocked) {
        console.log('🚫 Blocked actor attempted activity:', activity.actor)
        return { success: false, error: 'Actor blocked' }
      }
      
      // Route to specific handler based on activity type
      const result = await this.routeActivity(activity)
      
      console.log(`✅ Successfully processed ${activity.type} activity`)
      return result
      
    } catch (error) {
      console.error('❌ Error processing incoming activity:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Route activity to appropriate handler
   */
  private async routeActivity(activity: ActivityPubActivity): Promise<{ success: boolean; error?: string }> {
    switch (activity.type) {
      case 'Create':
        return this.handleCreate(activity)
      case 'Update':
        return this.handleUpdate(activity)
      case 'Delete':
        return this.handleDelete(activity)
      case 'Follow':
        return this.handleFollow(activity)
      case 'Accept':
        return this.handleAccept(activity)
      case 'Reject':
        return this.handleReject(activity)
      case 'Undo':
        return this.handleUndo(activity)
      case 'Like':
        return this.handleLike(activity)
      case 'Announce':
        return this.handleAnnounce(activity)
      case 'Block':
        return this.handleBlock(activity)
      default:
        console.warn(`⚠️ Unsupported activity type: ${activity.type}`)
        return { success: false, error: `Unsupported activity type: ${activity.type}` }
    }
  }
  
  /**
   * Handle Create activities (posts, messages, etc.)
   */
  private async handleCreate(activity: any): Promise<{ success: boolean; error?: string }> {
    const object = activity.object
    
    if (!object || !object.type) {
      return { success: false, error: 'Invalid Create activity object' }
    }
    
    switch (object.type) {
      case 'Note':
        return this.handleCreateNote(activity, object)
      case 'Article':
        return this.handleCreateArticle(activity, object)
      default:
        console.warn(`⚠️ Unsupported object type in Create: ${object.type}`)
        return { success: false, error: `Unsupported object type: ${object.type}` }
    }
  }
  
  /**
   * Handle Create Note (posts and messages)
   * Determines if it's a post or DM based on addressing
   */
  private async handleCreateNote(activity: any, note: any): Promise<{ success: boolean; error?: string }> {
    try {
      // Determine if this is a direct message or public post
      const isDM = this.isDirectMessage(activity, note)
      
      if (isDM) {
        // Handle as DM
        return this.handleIncomingDM(activity, note)
      } else {
        // Handle as post
        return this.handleIncomingPost(activity, note)
      }
    } catch (error) {
      console.error('❌ Error handling Create Note:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Handle incoming direct message
   */
  private async handleIncomingDM(activity: any, note: any): Promise<{ success: boolean; error?: string }> {
    console.log('📨 Processing incoming DM from:', activity.actor)
    
    // Call existing database function for DM processing
    const { error } = await supabase.rpc('handle_incoming_dm_activity', {
      activity_data: activity,
      note_data: note,
      instance_domain: this.config.instanceDomain
    })
    
    if (error) {
      console.error('❌ Failed to process incoming DM:', error)
      return { success: false, error: error.message }
    }
    
    return { success: true }
  }
  
  /**
   * Handle incoming post
   */
  private async handleIncomingPost(activity: any, note: any): Promise<{ success: boolean; error?: string }> {
    console.log('📝 Processing incoming post from:', activity.actor)
    
    // Call existing database function for post processing
    const { error } = await supabase.rpc('handle_incoming_post_activity', {
      activity_data: activity,
      note_data: note,
      instance_domain: this.config.instanceDomain
    })
    
    if (error) {
      console.error('❌ Failed to process incoming post:', error)
      return { success: false, error: error.message }
    }
    
    return { success: true }
  }
  
  /**
   * Handle Follow activities
   */
  private async handleFollow(activity: any): Promise<{ success: boolean; error?: string }> {
    console.log('👥 Processing follow request from:', activity.actor)
    
    const { error } = await supabase.rpc('handle_incoming_follow_activity', {
      activity_data: activity,
      instance_domain: this.config.instanceDomain
    })
    
    if (error) {
      console.error('❌ Failed to process follow:', error)
      return { success: false, error: error.message }
    }
    
    return { success: true }
  }
  
  /**
   * Handle Like activities
   */
  private async handleLike(activity: any): Promise<{ success: boolean; error?: string }> {
    console.log('❤️ Processing like from:', activity.actor)
    
    const { error } = await supabase.rpc('handle_incoming_like_activity', {
      activity_data: activity,
      instance_domain: this.config.instanceDomain
    })
    
    if (error) {
      console.error('❌ Failed to process like:', error)
      return { success: false, error: error.message }
    }
    
    return { success: true }
  }
  
  /**
   * Handle other activity types (simplified for now)
   */
  private async handleUpdate(activity: any): Promise<{ success: boolean; error?: string }> {
    console.log('🔄 Processing update activity')
    // TODO: Implement update handling
    return { success: true }
  }
  
  private async handleDelete(activity: any): Promise<{ success: boolean; error?: string }> {
    console.log('🗑️ Processing delete activity')
    // TODO: Implement delete handling
    return { success: true }
  }
  
  private async handleAccept(activity: any): Promise<{ success: boolean; error?: string }> {
    console.log('✅ Processing accept activity')
    // TODO: Implement accept handling
    return { success: true }
  }
  
  private async handleReject(activity: any): Promise<{ success: boolean; error?: string }> {
    console.log('❌ Processing reject activity')
    // TODO: Implement reject handling
    return { success: true }
  }
  
  private async handleUndo(activity: any): Promise<{ success: boolean; error?: string }> {
    console.log('↩️ Processing undo activity')
    // TODO: Implement undo handling
    return { success: true }
  }
  
  private async handleAnnounce(activity: any): Promise<{ success: boolean; error?: string }> {
    console.log('📢 Processing announce activity')
    // TODO: Implement announce handling
    return { success: true }
  }
  
  private async handleBlock(activity: any): Promise<{ success: boolean; error?: string }> {
    console.log('🚫 Processing block activity')
    // TODO: Implement block handling
    return { success: true }
  }
  
  private async handleCreateArticle(activity: any, article: any): Promise<{ success: boolean; error?: string }> {
    console.log('📄 Processing article creation')
    // TODO: Implement article handling
    return { success: true }
  }
  
  /**
   * Validate activity structure
   */
  private validateActivity(activity: any): boolean {
    return !!(
      activity &&
      activity.type &&
      activity.id &&
      activity.actor
    )
  }
  
  /**
   * Check if actor is blocked
   */
  private async isActorBlocked(actorUrl: string): Promise<boolean> {
    try {
      const actorDomain = new URL(actorUrl).hostname
      
      const { data, error } = await supabase
        .from('federated_instances')
        .select('is_blocked')
        .eq('domain', actorDomain)
        .maybeSingle()
        
      if (error && error.code !== 'PGRST116') {
        console.error('Error checking blocked status:', error)
        return false
      }
      
      return data?.is_blocked || false
    } catch (error) {
      console.error('Error parsing actor URL:', error)
      return false
    }
  }
  
  /**
   * Determine if activity represents a direct message
   * Based on ActivityPub addressing patterns
   */
  private isDirectMessage(activity: any, note: any): boolean {
    // DMs typically have:
    // 1. 'to' field with specific users (not public collections)
    // 2. No 'cc' field or only mentions
    // 3. All recipients mentioned in 'tag'
    
    const toActors = Array.isArray(activity.to) ? activity.to : [activity.to]
    const publicCollections = [
      'https://www.w3.org/ns/activitystreams#Public',
      'as:Public',
      'Public'
    ]
    
    // If addressing public collections, it's not a DM
    const hasPublicAddressing = toActors.some(actor => 
      publicCollections.includes(actor)
    )
    
    if (hasPublicAddressing) {
      return false
    }
    
    // Check if all recipients are mentioned (DM requirement)
    const mentions = note.tag?.filter((tag: any) => tag.type === 'Mention') || []
    const mentionedActors = mentions.map((mention: any) => mention.href)
    
    const allRecipientsAreMentioned = toActors.every((actor: string) => 
      mentionedActors.includes(actor) || actor === activity.actor
    )
    
    return allRecipientsAreMentioned
  }
}

/**
 * Factory function to create IncomingHandler with current config
 */
export async function createIncomingHandler(): Promise<IncomingHandler> {
  // Get federation settings
  const { data: federationConfig } = await supabase
    .from('instance_config')
    .select('config_key, config_value')
    .in('config_key', ['federation_enabled', 'domain'])
  
  const federationEnabled = federationConfig?.find(c => c.config_key === 'federation_enabled')?.config_value === 'true'
  const instanceDomain = federationConfig?.find(c => c.config_key === 'domain')?.config_value?.replace(/"/g, '') || 'har.mony.lol'
  const instanceUrl = `https://${instanceDomain}`
  
  return new IncomingHandler({
    federationEnabled,
    instanceDomain,
    instanceUrl
  })
}