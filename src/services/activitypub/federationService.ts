/**
 * Professional ActivityPub Federation Service for Harmony (Monyverse)
 * 
 * Handles all ActivityPub protocol interactions including:
 * - Actor management and key generation
 * - Activity sending and receiving
 * - Remote user discovery and caching
 * - Federation delivery queue
 * - WebFinger resolution
 * 
 * Built with scalability, security, and DRY principles in mind
 */

import { supabase } from '@/supabase';
import type { 
  ActivityPubObject, 
  ActivityPubActor, 
  ActivityPubActivityObject,
  FederatedInstance,
  ActivityPubPost,
  Profile,
  FederatedUserSearchResult,
  ActivityPubFollow,
  MediaAttachment
} from '@/types';

export class ActivityPubFederationService {
  private static instance: ActivityPubFederationService
  private readonly domain: string
  private readonly apiBase: string

  private constructor() {
    this.domain = import.meta.env.VITE_DOMAIN || 'harmony.com'
    this.apiBase = import.meta.env.VITE_API_BASE || `https://${this.domain}`
  }

  static getInstance(): ActivityPubFederationService {
    if (!ActivityPubFederationService.instance) {
      ActivityPubFederationService.instance = new ActivityPubFederationService()
    }
    return ActivityPubFederationService.instance
  }

  // =============================================
  // ACTOR MANAGEMENT
  // =============================================

  /**
   * Create or update a local ActivityPub actor
   */
  async createOrUpdateLocalActor(profile: Profile): Promise<ActivityPubActor> {
    const actorId = this.getActorId(profile.username, this.domain)
    
    // Generate keys if not exists
    if (!profile.public_key || !profile.private_key) {
      await this.generateKeysForUser(profile.id)
    }

    const actor: ActivityPubActor = {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
      id: actorId,
      type: 'Person',
      preferredUsername: profile.username,
      name: profile.display_name,
      summary: profile.bio || '',
      icon: profile.avatar_url ? {
        type: 'Image',
        mediaType: 'image/jpeg',
        url: this.getFullUrl(profile.avatar_url)
      } : undefined,
      inbox: `${actorId}/inbox`,
      outbox: `${actorId}/outbox`,
      following: `${actorId}/following`,
      followers: `${actorId}/followers`,
      featured: `${actorId}/featured`,
      publicKey: {
        id: `${actorId}#main-key`,
        owner: actorId,
        publicKeyPem: profile.public_key || ''
      },
      endpoints: {
        sharedInbox: `${this.apiBase}/api/activitypub/inbox`
      },
      url: `${this.apiBase}/users/${profile.username}`
    }

    // Update profile with ActivityPub URLs
    await supabase
      .from('profiles')
      .update({
        federated_id: actorId,
        inbox_url: actor.inbox,
        outbox_url: actor.outbox,
        followers_url: actor.followers,
        following_url: actor.following,
        featured_url: actor.featured
      })
      .eq('id', profile.id)

    return actor
  }

  /**
   * Generate RSA key pair for a user
   */
  private async generateKeysForUser(userId: string): Promise<void> {
    // In a real implementation, this would generate proper RSA keys
    // For now, we'll use a placeholder implementation
    const keyPair = await this.generateRSAKeyPair()
    
    await supabase
      .from('profiles')
      .update({
        public_key: keyPair.publicKey,
        private_key: keyPair.privateKey // Should be encrypted in production
      })
      .eq('id', userId)
  }

  /**
   * Generate RSA key pair (placeholder implementation)
   */
  private async generateRSAKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
    // In production, use Web Crypto API or server-side key generation
    return {
      publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
      privateKey: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
    }
  }

  // =============================================
  // REMOTE USER RESOLUTION
  // =============================================

  /**
   * Resolve a remote user by their handle (@username@domain)
   */
  async resolveRemoteUser(handle: string): Promise<Profile | null> {
    // Accepts both "@username@domain" and "username@domain"
    const match = handle.match(/^@?([^@]+)@([^@]+)$/)
    const username = match?.[1]
    const domain = match?.[2]
    if (!username || !domain) return null

    // Check if already cached locally
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .eq('domain', domain)
      .single()

    if (existingProfile && this.isRecentlyFetched(existingProfile.last_synced_at)) {
      return existingProfile
    }

    try {
      // WebFinger lookup
      const actor = await this.webfingerLookup(username, domain)
      if (!actor) return null

      // Fetch actor document
      const actorData = await this.fetchActor(actor.href)
      if (!actorData) return null

      // Store or update remote user
      return await this.storeRemoteUser(actorData, domain)
    } catch (error) {
      console.error('Failed to resolve remote user:', error)
      return null
    }
  }

  /**
   * WebFinger lookup for remote users
   */
  private async webfingerLookup(username: string, domain: string): Promise<{ href: string } | null> {
    try {
      const response = await fetch(`https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`)
      if (!response.ok) return null

      const data = await response.json()
      const selfLink = data.links?.find((link: any) => link.rel === 'self' && link.type === 'application/activity+json')
      
      return selfLink ? { href: selfLink.href } : null
    } catch (error) {
      console.error('WebFinger lookup failed:', error)
      return null
    }
  }

  /**
   * Fetch ActivityPub actor document
   */
  private async fetchActor(actorUrl: string): Promise<ActivityPubActor | null> {
    try {
      const response = await fetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
        }
      })
      
      if (!response.ok) return null
      return await response.json()
    } catch (error) {
      console.error('Failed to fetch actor:', error)
      return null
    }
  }

  /**
   * Store remote user in local database
   */
  private async storeRemoteUser(actor: ActivityPubActor, domain: string): Promise<Profile> {
    const profileData = {
      username: actor.preferredUsername,
      display_name: actor.name || actor.preferredUsername,
      domain,
      avatar_url: actor.icon?.url,
      bio: actor.summary,
      federated_id: actor.id,
      public_key: actor.publicKey?.publicKeyPem,
      inbox_url: actor.inbox,
      outbox_url: actor.outbox,
      followers_url: actor.followers,
      following_url: actor.following,
      featured_url: actor.featured,
      is_local: false,
      last_synced_at: new Date().toISOString()
    }

    const { data, error } = await supabase
      .from('profiles')
      .upsert(profileData, {
        onConflict: 'username,domain',
        ignoreDuplicates: false
      })
      .select()
      .single()

    if (error) throw error
    return data
  }

  // =============================================
  // ACTIVITY SENDING
  // =============================================

  /**
   * Send an ActivityPub activity to remote instances
   */
  async sendActivity(activity: ActivityPubActivityObject, recipients: string[]): Promise<void> {
    // Store activity in local database
    const { data: storedActivity } = await supabase
      .from('ap_activities')
      .insert({
        ap_id: activity.id,
        ap_type: activity.type,
        actor_id: await this.getProfileIdFromActorUrl(activity.actor),
        activity_data: activity,
        is_local: true
      })
      .select()
      .single()

    if (!storedActivity) return

    // Queue for delivery to each recipient domain
    const deliveryTasks = recipients.map(async (recipient) => {
      const domain = new URL(recipient).hostname
      const inboxUrl = await this.getInboxUrl(recipient)
      
      if (inboxUrl) {
        await supabase
          .from('delivery_queue')
          .insert({
            activity_id: storedActivity.id,
            target_domain: domain,
            target_inbox_url: inboxUrl,
            status: 'pending'
          })
      }
    })

    await Promise.allSettled(deliveryTasks)
  }

  /**
   * Create and send a follow activity
   */
  async sendFollowActivity(followerId: string, followingId: string): Promise<void> {
    const follower = await this.getProfile(followerId)
    const following = await this.getProfile(followingId)
    
    if (!follower || !following) return

    const activity: ActivityPubActivityObject = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${this.getActorId(follower.username, follower.domain)}/follows/${Date.now()}`,
      type: 'Follow',
      actor: this.getActorId(follower.username, follower.domain),
      object: following.federated_id || this.getActorId(following.username, following.domain),
      published: new Date().toISOString()
    }

    // Store follow relationship
    await supabase
      .from('follows')
      .insert({
        follower_id: followerId,
        following_id: followingId,
        ap_id: activity.id,
        status: following.is_local ? 'accepted' : 'pending',
        is_local: following.is_local
      })

    // Send activity if following remote user
    if (!following.is_local && following.inbox_url) {
      await this.sendActivity(activity, [following.inbox_url])
    }
  }

  // =============================================
  // ACTIVITY PROCESSING
  // =============================================

  /**
   * Process incoming ActivityPub activity
   */
  async processIncomingActivity(activity: ActivityPubActivityObject): Promise<void> {
    try {
      // Verify activity signature (simplified)
      if (!await this.verifyActivitySignature(activity)) {
        console.error('Activity signature verification failed')
        return
      }

      // Store activity
      await supabase
        .from('ap_activities')
        .insert({
          ap_id: activity.id,
          ap_type: activity.type,
          activity_data: activity,
          origin_domain: new URL(activity.actor).hostname,
          status: 'processing'
        })

      // Process based on activity type
      switch (activity.type) {
        case 'Follow':
          await this.processFollowActivity(activity)
          break
        case 'Accept':
          await this.processAcceptActivity(activity)
          break
        case 'Reject':
          await this.processRejectActivity(activity)
          break
        case 'Create':
          await this.processCreateActivity(activity)
          break
        case 'Update':
          await this.processUpdateActivity(activity)
          break
        case 'Delete':
          await this.processDeleteActivity(activity)
          break
        case 'Like':
          await this.processLikeActivity(activity)
          break
        case 'Announce':
          await this.processAnnounceActivity(activity)
          break
        default:
          console.warn('Unhandled activity type:', activity.type)
      }

      // Mark as completed
      await supabase
        .from('ap_activities')
        .update({ status: 'completed', processed_at: new Date().toISOString() })
        .eq('ap_id', activity.id)

    } catch (error) {
      console.error('Failed to process activity:', error)
      await supabase
        .from('ap_activities')
        .update({ 
          status: 'failed', 
          error_message: error instanceof Error ? error.message : 'Unknown error',
          processed_at: new Date().toISOString()
        })
        .eq('ap_id', activity.id)
    }
  }

  /**
   * Process Follow activity
   */
  private async processFollowActivity(activity: ActivityPubActivityObject): Promise<void> {
    const followerActorUrl = activity.actor
    const followingActorUrl = typeof activity.object === 'string' ? activity.object : activity.object.id

    // Resolve users
    const follower = await this.resolveUserByActorUrl(followerActorUrl)
    const following = await this.resolveUserByActorUrl(followingActorUrl)

    if (!follower || !following) return

    // Auto-accept local follows for now (can be made configurable)
    const status = following.is_local ? 'accepted' : 'pending'

    // Store follow relationship
    await supabase
      .from('follows')
      .upsert({
        follower_id: follower.id,
        following_id: following.id,
        ap_id: activity.id,
        status,
        accepted_at: status === 'accepted' ? new Date().toISOString() : null,
        is_local: false
      }, {
        onConflict: 'follower_id,following_id'
      })

    // Send Accept activity if auto-accepting
    if (status === 'accepted') {
      await this.sendAcceptActivity(activity, following)
    }
  }

  /**
   * Send Accept activity in response to Follow
   */
  private async sendAcceptActivity(followActivity: ActivityPubActivityObject, acceptingUser: Profile): Promise<void> {
    const acceptActivity: ActivityPubActivityObject = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${this.getActorId(acceptingUser.username, acceptingUser.domain)}/accepts/${Date.now()}`,
      type: 'Accept',
      actor: this.getActorId(acceptingUser.username, acceptingUser.domain),
      object: followActivity,
      published: new Date().toISOString()
    }

    const followerInbox = await this.getInboxUrl(followActivity.actor)
    if (followerInbox) {
      await this.sendActivity(acceptActivity, [followerInbox])
    }
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  /**
   * Get ActivityPub actor ID for a user
   */
  private getActorId(username: string, domain: string): string {
    return `https://${domain}/users/${username}`
  }

  /**
   * Get full URL for relative paths
   */
  private getFullUrl(path: string): string {
    if (path.startsWith('http')) return path
    return `${this.apiBase}${path.startsWith('/') ? '' : '/'}${path}`
  }

  /**
   * Check if data was recently fetched (within 1 hour)
   */
  private isRecentlyFetched(lastSynced: string | null): boolean {
    if (!lastSynced) return false
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    return new Date(lastSynced) > oneHourAgo
  }

  /**
   * Get profile by ID
   */
  private async getProfile(profileId: string): Promise<Profile | null> {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', profileId)
      .single()
    
    return data
  }

  /**
   * Get profile ID from actor URL
   */
  private async getProfileIdFromActorUrl(actorUrl: string): Promise<string | null> {
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single()
    
    return data?.id || null
  }

  /**
   * Resolve user by actor URL
   */
  private async resolveUserByActorUrl(actorUrl: string): Promise<Profile | null> {
    // Try local lookup first
    const { data: localProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('federated_id', actorUrl)
      .single()

    if (localProfile) return localProfile

    // Try to fetch and cache remote user
    try {
      const actor = await this.fetchActor(actorUrl)
      if (actor) {
        const domain = new URL(actorUrl).hostname
        return await this.storeRemoteUser(actor, domain)
      }
    } catch (error) {
      console.error('Failed to resolve user by actor URL:', error)
    }

    return null
  }

  /**
   * Get inbox URL for an actor
   */
  private async getInboxUrl(actorUrl: string): Promise<string | null> {
    const actor = await this.fetchActor(actorUrl)
    return actor?.inbox || null
  }

  /**
   * Verify activity signature (simplified implementation)
   */
  private async verifyActivitySignature(activity: ActivityPubActivityObject): Promise<boolean> {
    // In production, implement proper HTTP signature verification
    // This is a simplified version for the demo
    return true
  }

  /**
   * Process other activity types (placeholder implementations)
   */
  private async processAcceptActivity(activity: ActivityPubActivityObject): Promise<void> {
    // Handle Follow Accept
    const originalFollow = activity.object as ActivityPubActivityObject
    if (originalFollow.type === 'Follow') {
      await supabase
        .from('follows')
        .update({ 
          status: 'accepted', 
          accepted_at: new Date().toISOString() 
        })
        .eq('ap_id', originalFollow.id)
    }
  }

  private async processRejectActivity(activity: ActivityPubActivityObject): Promise<void> {
    // Handle Follow Reject
    const originalFollow = activity.object as ActivityPubActivityObject
    if (originalFollow.type === 'Follow') {
      await supabase
        .from('follows')
        .update({ status: 'rejected' })
        .eq('ap_id', originalFollow.id)
    }
  }

  private async processCreateActivity(activity: ActivityPubActivityObject): Promise<void> {
    // Handle Create Note (post)
    if (typeof activity.object === 'object' && activity.object.type === 'Note') {
      // Store remote post - implementation would go here
    }
  }

  private async processUpdateActivity(activity: ActivityPubActivityObject): Promise<void> {
    // Handle profile/post updates
  }

  private async processDeleteActivity(activity: ActivityPubActivityObject): Promise<void> {
    // Handle deletions
  }

  private async processLikeActivity(activity: ActivityPubActivityObject): Promise<void> {
    // Handle likes/favorites
  }

  private async processAnnounceActivity(activity: ActivityPubActivityObject): Promise<void> {
    // Handle reblogs/boosts
  }

  // =============================================
  // SEARCH AND DISCOVERY
  // =============================================

  /**
   * Search for federated users
   */
  async searchFederatedUsers(query: string, limit: number = 10): Promise<FederatedUserSearchResult[]> {
    const { data, error } = await supabase
      .rpc('search_federated_users', {
        p_query: query,
        p_limit: limit
      })

    if (error) {
      console.error('Failed to search federated users:', error)
      return []
    }

    return data || []
  }

  /**
   * Get the instance domain
   */
  getInstanceDomain(): string {
    return this.domain
  }

  /**
   * Check if a domain is local
   */
  isLocalDomain(domain: string): boolean {
    return domain === this.domain
  }
}

// Export singleton instance
export const federationService = ActivityPubFederationService.getInstance()
