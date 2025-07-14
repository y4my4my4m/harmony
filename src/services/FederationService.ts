/**
 * Federation Service - Professional ActivityPub federation management
 * Handles all federation operations in a modular, scalable way
 */

import { supabase } from '@/supabase';
import { 
  extractMentions, 
  resolveMentions, 
  generateMentionTags, 
  getDeliveryInboxes, 
  formatMentionsForActivityPub,
  resolveRemoteMention
} from '@/utils/mentionUtils';
import type { 
  ActivityPubActivity, 
  ActivityPubActivityObject,
  ActivityPubActivityType, 
  ActivityPubObjectType,
  Post,
  FederatedUser 
} from '@/types';

interface FederationConfig {
  instanceUrl: string;
  domain: string;
  sharedInboxUrl: string;
}

interface DeliveryTarget {
  inboxUrl: string;
  domain: string;
  sharedInbox?: boolean;
}

interface ActivityPayload {
  type: ActivityPubActivityType;
  actor: string;
  object: any;
  target?: string;
  to?: string[];
  cc?: string[];
}

export class FederationService {
  private config: FederationConfig;
  
  constructor() {
    this.config = {
      instanceUrl: 'https://har.mony.lol',
      domain: 'har.mony.lol',
      sharedInboxUrl: 'https://har.mony.lol/api/activitypub/inbox'
    };
  }

  // =============================================================================
  // CORE FEDERATION OPERATIONS
  // =============================================================================

  /**
   * Queue an activity for federation to remote instances
   */
  async queueActivity(activity: ActivityPayload, targets?: DeliveryTarget[]): Promise<string> {
    try {
      // Generate activity ID
      const activityId = crypto.randomUUID();
      const activityUrl = `${this.config.instanceUrl}/activities/${activityId}`;

      // Build full ActivityPub activity
      const fullActivity: ActivityPubActivityObject = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: activityUrl,
        type: activity.type,
        actor: activity.actor,
        object: activity.object,
        published: new Date().toISOString(),
        to: activity.to || ['https://www.w3.org/ns/activitystreams#Public'],
        cc: activity.cc || []
      };

      // Store activity in ap_activities table
      const { data: activityRecord, error: activityError } = await supabase
        .from('ap_activities')
        .insert({
          id: activityId,
          ap_id: activityUrl,
          ap_type: activity.type,
          actor_id: await this.extractUserIdFromActor(activity.actor),
          actor_ap_id: activity.actor, // ActivityPub URL of the actor
          activity_data: fullActivity,
          target_id: activity.target,
          target_type: this.inferTargetType(activity),
          status: 'pending'
        })
        .select()
        .single();

      if (activityError) throw activityError;

      // Queue for delivery if targets provided
      if (targets && targets.length > 0) {
        await this.queueDeliveries(activityId, fullActivity, targets);
      } else {
        // Auto-discover targets based on activity type
        const autoTargets = await this.discoverDeliveryTargets(activity);
        if (autoTargets.length > 0) {
          await this.queueDeliveries(activityId, fullActivity, autoTargets);
        }
      }

      return activityId;
    } catch (error) {
      console.error('❌ Failed to queue activity:', error);
      throw error;
    }
  }

  /**
   * Queue activity deliveries to specific targets
   */
  private async queueDeliveries(
    activityId: string, 
    activity: ActivityPubActivityObject, 
    targets: DeliveryTarget[]
  ): Promise<void> {
    const deliveries = targets.map(target => ({
      activity_id: activityId,
      target_domain: target.domain,
      target_inbox: target.inboxUrl,
      activity_data: activity,
      status: 'pending' as const,
      next_attempt_at: new Date().toISOString(),
      attempt_count: 0
    }));

    const { error } = await supabase
      .from('federation_delivery_queue')
      .insert(deliveries);

    if (error) throw error;

    console.log(`📤 Queued ${deliveries.length} deliveries for activity ${activityId}`);
  }

  /**
   * Discover delivery targets based on activity type and content
   */
  private async discoverDeliveryTargets(activity: ActivityPayload): Promise<DeliveryTarget[]> {
    const targets: DeliveryTarget[] = [];

    try {
      // For Create/Update/Delete activities, target followers
      if (['Create', 'Update', 'Delete'].includes(activity.type)) {
        const actorId = await this.extractUserIdFromActor(activity.actor);
        const followerTargets = await this.getFollowerInboxes(actorId);
        targets.push(...followerTargets);
      }

      // For Follow activities, target the specific user
      if (activity.type === 'Follow') {
        const targetUser = await this.resolveActorInbox(activity.object);
        if (targetUser) targets.push(targetUser);
      }

      // For Like/Announce activities, target the original post author
      if (['Like', 'Announce'].includes(activity.type)) {
        const originalAuthor = await this.getPostAuthorInbox(activity.object);
        if (originalAuthor) targets.push(originalAuthor);
      }

      return targets;
    } catch (error) {
      console.error('❌ Failed to discover delivery targets:', error);
      return [];
    }
  }

  // =============================================================================
  // POST FEDERATION
  // =============================================================================

  /**
   * Federate a newly created post with mention extraction and delivery
   */
  async federatePost(post: Post, authorProfile: any): Promise<string> {
    const actor = `${this.config.instanceUrl}/users/${authorProfile.username}`;
    const objectUrl = `${this.config.instanceUrl}/posts/${post.id}`;

    // Extract and resolve mentions from post content
    const { processedContent, mentionTags, deliveryInboxes } = await this.processMentions(post.content);

    // Build ActivityPub Note object
    const noteObject = {
      id: objectUrl,
      type: 'Note' as ActivityPubObjectType,
      attributedTo: actor,
      content: processedContent,
      published: post.created_at,
      to: this.buildAudience(post.visibility, actor),
      cc: [],
      url: objectUrl,
      mediaType: 'text/html',
      ...(mentionTags.length > 0 && { tag: mentionTags }),
      ...(post.content_warning && { summary: post.content_warning }),
      ...(post.in_reply_to && { inReplyTo: await this.resolveReplyTarget(post.in_reply_to) }),
      ...(post.media_attachments && post.media_attachments.length > 0 && {
        attachment: this.formatMediaAttachments(post.media_attachments)
      })
    };

    // Update post with ActivityPub data
    await supabase
      .from('posts')
      .update({
        ap_id: objectUrl,
        ap_type: 'Note',
        url: objectUrl,
        is_federated: true,
        federation_status: 'federating',
        last_federated_at: new Date().toISOString()
      })
      .eq('id', post.id);

    // Queue Create activity with enhanced delivery targets
    const activityId = await this.queueActivity({
      type: 'Create',
      actor,
      object: noteObject,
      target: post.id,
      to: noteObject.to,
      cc: noteObject.cc
    });

    // 🌐 DELIVER TO MENTIONED USERS: Send directly to remote inboxes
    if (deliveryInboxes.length > 0) {
      console.log(`📬 Delivering post ${post.id} to ${deliveryInboxes.length} mentioned users:`, deliveryInboxes);
      
      const createActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actor}/activities/create/${Date.now()}`,
        type: 'Create',
        actor,
        object: noteObject,
        published: new Date().toISOString(),
        to: noteObject.to,
        cc: noteObject.cc
      };

      await this.deliverActivity(createActivity, deliveryInboxes);
    }

    return activityId;
  }

  /**
   * Federate post update (edit)
   */
  async federatePostUpdate(post: Post, authorProfile: any): Promise<string> {
    const actor = `${this.config.instanceUrl}/users/${authorProfile.username}`;
    const objectUrl = `${this.config.instanceUrl}/posts/${post.id}`;

    const noteObject = {
      id: objectUrl,
      type: 'Note' as ActivityPubObjectType,
      attributedTo: actor,
      content: this.formatContentForActivityPub(post.content),
      updated: new Date().toISOString(),
      to: this.buildAudience(post.visibility, actor),
      cc: []
    };

    return await this.queueActivity({
      type: 'Update',
      actor,
      object: noteObject,
      target: post.id
    });
  }

  /**
   * Federate post deletion
   */
  async federatePostDelete(postId: string, authorProfile: any): Promise<string> {
    const actor = `${this.config.instanceUrl}/users/${authorProfile.username}`;
    const objectUrl = `${this.config.instanceUrl}/posts/${postId}`;

    // Create Tombstone object
    const tombstone = {
      id: objectUrl,
      type: 'Tombstone' as ActivityPubObjectType,
      deleted: new Date().toISOString()
    };

    return await this.queueActivity({
      type: 'Delete',
      actor,
      object: tombstone,
      target: postId
    });
  }

  // =============================================================================
  // INTERACTION FEDERATION
  // =============================================================================

  /**
   * Federate a like/favorite interaction
   */
  async federateLike(postId: string, userId: string, isLike: boolean): Promise<string | null> {
    try {
      const userProfile = await this.getUserProfile(userId);
      if (!userProfile) throw new Error('User profile not found');

      const post = await this.getPost(postId);
      if (!post) throw new Error('Post not found');

      const actor = `${this.config.instanceUrl}/users/${userProfile.username}`;
      const objectUrl = post.ap_id || `${this.config.instanceUrl}/posts/${postId}`;

      if (isLike) {
        // Create Like activity
        return await this.queueActivity({
          type: 'Like',
          actor,
          object: objectUrl,
          target: postId
        });
      } else {
        // Create Undo Like activity
        const likeId = `${this.config.instanceUrl}/activities/${crypto.randomUUID()}`;
        return await this.queueActivity({
          type: 'Undo',
          actor,
          object: {
            id: likeId,
            type: 'Like',
            actor,
            object: objectUrl
          },
          target: postId
        });
      }
    } catch (error) {
      console.error('❌ Failed to federate like:', error);
      return null;
    }
  }

  /**
   * Federate a follow request
   */
  async federateFollow(followerId: string, followingId: string, isFollow: boolean): Promise<string | null> {
    try {
      const followerProfile = await this.getUserProfile(followerId);
      const followingProfile = await this.getUserProfile(followingId);
      
      if (!followerProfile || !followingProfile) {
        throw new Error('User profiles not found');
      }

      const actor = `${this.config.instanceUrl}/users/${followerProfile.username}`;
      const target = followingProfile.is_local 
        ? `${this.config.instanceUrl}/users/${followingProfile.username}`
        : followingProfile.federated_id;

      if (isFollow) {
        return await this.queueActivity({
          type: 'Follow',
          actor,
          object: target,
          target: followingId
        });
      } else {
        // Undo follow
        const followId = `${this.config.instanceUrl}/activities/${crypto.randomUUID()}`;
        return await this.queueActivity({
          type: 'Undo',
          actor,
          object: {
            id: followId,
            type: 'Follow',
            actor,
            object: target
          },
          target: followingId
        });
      }
    } catch (error) {
      console.error('❌ Failed to federate follow:', error);
      return null;
    }
  }

  /**
   * Federate an Announce (reblog/boost) activity
   */
  async federateAnnounce(postId: string, userId: string, isAnnounce: boolean): Promise<string | null> {
    try {
      const userProfile = await this.getUserProfile(userId);
      const post = await this.getPost(postId);
      
      if (!userProfile || !post) {
        throw new Error('User profile or post not found');
      }

      // Only federate if the post is federated
      if (!post.is_federated) {
        console.log('Post is not federated, skipping announce federation');
        return null;
      }

      const actor = `${this.config.instanceUrl}/users/${userProfile.username}`;
      const objectUrl = post.ap_id || `${this.config.instanceUrl}/posts/${postId}`;

      if (isAnnounce) {
        // Create Announce activity
        return await this.queueActivity({
          type: 'Announce',
          actor,
          object: objectUrl,
          target: postId
        });
      } else {
        // Create Undo Announce activity
        const announceId = `${this.config.instanceUrl}/activities/${crypto.randomUUID()}`;
        return await this.queueActivity({
          type: 'Undo',
          actor,
          object: {
            id: announceId,
            type: 'Announce',
            actor,
            object: objectUrl
          },
          target: postId
        });
      }
    } catch (error) {
      console.error('❌ Failed to federate announce:', error);
      return null;
    }
  }

  // =============================================================================
  // INBOX PROCESSING
  // =============================================================================

  /**
   * Process incoming ActivityPub activity
   */
  async processIncomingActivity(activity: ActivityPubActivity, signature?: string): Promise<boolean> {
    try {
      console.log(`📨 Processing incoming ${activity.type} activity:`, activity.id);

      // Verify activity signature (simplified for now)
      if (!await this.verifyActivitySignature(activity, signature)) {
        console.warn('⚠️ Activity signature verification failed');
        return false;
      }

      // Process based on activity type
      switch (activity.type) {
        case 'Create':
          return await this.processCreateActivity(activity);
        case 'Update':
          return await this.processUpdateActivity(activity);
        case 'Delete':
          return await this.processDeleteActivity(activity);
        case 'Follow':
          return await this.processFollowActivity(activity);
        case 'Accept':
          return await this.processAcceptActivity(activity);
        case 'Reject':
          return await this.processRejectActivity(activity);
        case 'Like':
          return await this.processLikeActivity(activity);
        case 'Undo':
          return await this.processUndoActivity(activity);
        default:
          console.warn(`⚠️ Unsupported activity type: ${activity.type}`);
          return false;
      }
    } catch (error) {
      console.error('❌ Failed to process incoming activity:', error);
      return false;
    }
  }

  /**
   * Process Create activity (new post)
   */
  private async processCreateActivity(activity: ActivityPubActivity): Promise<boolean> {
    if (activity.object.type !== 'Note') return false;

    try {
      // Resolve actor
      const actor = await this.resolveActor(activity.actor);
      if (!actor) return false;

      // Check if post already exists
      const existingPost = await supabase
        .from('posts')
        .select('id')
        .eq('ap_id', activity.object.id)
        .single();

      if (existingPost.data) {
        console.log('📝 Post already exists, skipping');
        return true;
      }

      // Create federated post
      const { error } = await supabase
        .from('posts')
        .insert({
          ap_id: activity.object.id,
          ap_type: 'Note',
          content: this.parseActivityPubContent(activity.object.content),
          author_id: actor.id,
          visibility: this.parseVisibility(activity.object.to, activity.object.cc),
          is_local: false,
          is_federated: true,
          url: activity.object.url || activity.object.id,
          language: activity.object.contentMap?.en ? 'en' : 'unknown',
          content_warning: activity.object.summary,
          in_reply_to: activity.object.inReplyTo ? await this.resolveReplyId(activity.object.inReplyTo) : null,
          media_attachments: activity.object.attachment ? this.parseMediaAttachments(activity.object.attachment) : [],
          is_sensitive: !!activity.object.sensitive
        });

      if (error) throw error;

      console.log('✅ Created federated post from ActivityPub');
      return true;
    } catch (error) {
      console.error('❌ Failed to process Create activity:', error);
      return false;
    }
  }

  // =============================================================================
  // MENTION PROCESSING AND DELIVERY
  // =============================================================================

  /**
   * Process mentions in post content for federation
   */
  private async processMentions(content: any): Promise<{
    processedContent: string;
    mentionTags: any[];
    deliveryInboxes: string[];
  }> {
    const textContent = this.formatContentForActivityPub(content);
    
    // Extract mentions from content
    const mentions = extractMentions(textContent);
    console.log(`📋 Found ${mentions.length} mentions in post:`, mentions.map(m => m.full));

    if (mentions.length === 0) {
      return {
        processedContent: textContent,
        mentionTags: [],
        deliveryInboxes: []
      };
    }

    // Resolve mentions to users (local and remote)
    const resolvedMentions = await resolveMentions(mentions);
    
    // Try to resolve any unresolved remote mentions via WebFinger
    for (let i = 0; i < resolvedMentions.length; i++) {
      const rm = resolvedMentions[i];
      if (!rm.user && rm.mention.domain && rm.mention.domain !== this.config.domain) {
        console.log(`🔍 Attempting WebFinger resolution for ${rm.mention.full}`);
        const remoteUser = await resolveRemoteMention(rm.mention.username, rm.mention.domain);
        if (remoteUser) {
          rm.user = remoteUser;
          rm.actorUrl = remoteUser.federated_id;
          rm.inboxUrl = remoteUser.inbox_url;
          console.log(`✅ Resolved remote mention: ${rm.mention.full} -> ${rm.actorUrl}`);
        }
      }
    }

    // Generate ActivityPub mention tags
    const mentionTags = generateMentionTags(resolvedMentions);
    
    // Get delivery inboxes for remote mentions
    const deliveryInboxes = getDeliveryInboxes(resolvedMentions);
    
    // Format content with proper mention links for ActivityPub
    const processedContent = formatMentionsForActivityPub(textContent, resolvedMentions);

    console.log(`🎯 Processed mentions: ${mentionTags.length} tags, ${deliveryInboxes.length} delivery targets`);

    return {
      processedContent,
      mentionTags,
      deliveryInboxes
    };
  }

  /**
   * Deliver ActivityPub activity to remote inboxes
   */
  private async deliverActivity(activity: any, inboxUrls: string[]): Promise<void> {
    console.log(`📡 Delivering activity to ${inboxUrls.length} inboxes:`, activity.type);
    
    const deliveryPromises = inboxUrls.map(async (inboxUrl) => {
      try {
        const response = await fetch(inboxUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/activity+json',
            'Accept': 'application/activity+json',
            'User-Agent': `Harmony/${this.config.domain}`,
          },
          body: JSON.stringify(activity)
        });

        if (response.ok) {
          console.log(`✅ Successfully delivered to ${inboxUrl}`);
        } else {
          console.error(`❌ Failed to deliver to ${inboxUrl}: ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        console.error(`❌ Network error delivering to ${inboxUrl}:`, error);
      }
    });

    await Promise.allSettled(deliveryPromises);
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  /**
   * Extract user ID from ActivityPub actor URL
   */
  private async extractUserIdFromActor(actorUrl: string): Promise<string> {
    // For local actors: https://har.mony.lol/users/username -> resolve to UUID
    if (actorUrl.startsWith(this.config.instanceUrl)) {
      const username = actorUrl.split('/').pop();
      if (!username) return '';
      
      // Resolve username to UUID from database
      const { data, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', username)
        .eq('is_local', true)
        .single();
      
      if (error || !data) {
        console.error(`❌ Failed to resolve local username '${username}' to UUID:`, error);
        return '';
      }
      
      return data.id;
    }
    
    // For remote actors, we'd store them in a different way
    return actorUrl;
  }

  /**
   * Format content for ActivityPub federation
   */
  private formatContentForActivityPub(content: any): string {
    // If content is already a string (HTML), use it directly
    if (typeof content === 'string') {
      return content;
    }
    
    // If content is our internal array format, convert to HTML
    if (Array.isArray(content)) {
      return content
        .map(item => {
          if (item.type === 'text') {
            // Convert plain text to HTML by escaping and preserving line breaks
            return item.text
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\n/g, '<br>');
          } else if (item.type === 'mention') {
            // Convert mention objects to HTML
            const username = item.username || 'unknown';
            const domain = item.domain;
            const href = item.url || (domain ? `https://${domain}/users/${username}` : `https://har.mony.lol/users/${username}`);
            return `<a href="${href}" class="mention">@${username}</a>`;
          } else if (item.type === 'url') {
            // Convert URL objects to HTML
            const url = item.url || '';
            const text = item.text || url;
            return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
          }
          return '';
        })
        .join('');
    }
    
    return String(content);
  }

  /**
   * Build audience arrays for ActivityPub
   */
  private buildAudience(visibility: string, actor: string): string[] {
    switch (visibility) {
      case 'public':
        return ['https://www.w3.org/ns/activitystreams#Public'];
      case 'unlisted':
        return [`${actor}/followers`];
      case 'private':
        return [`${actor}/followers`];
      case 'direct':
        return []; // Will be populated with specific recipients
      default:
        return ['https://www.w3.org/ns/activitystreams#Public'];
    }
  }

  /**
   * Get follower inbox URLs for delivery
   */
  private async getFollowerInboxes(userId: string): Promise<DeliveryTarget[]> {
    try {
      const { data: followers, error } = await supabase
        .from('follows')
        .select(`
          follower:profiles!follows_follower_id_fkey(
            username,
            domain,
            federated_id,
            is_local
          )
        `)
        .eq('following_id', userId)
        .eq('status', 'accepted');

      if (error) throw error;

      const targets: DeliveryTarget[] = [];
      
      for (const follow of followers || []) {
        const follower = follow.follower;
        if (!follower.is_local && follower.federated_id) {
          // For remote followers, we need to resolve their inbox
          const inboxUrl = await this.resolveActorInboxUrl(follower.federated_id);
          if (inboxUrl) {
            targets.push({
              inboxUrl,
              domain: follower.domain,
              sharedInbox: false
            });
          }
        }
      }

      return targets;
    } catch (error) {
      console.error('❌ Failed to get follower inboxes:', error);
      return [];
    }
  }

  /**
   * Get user profile by ID
   */
  private async getUserProfile(userId: string): Promise<any> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Get post by ID
   */
  private async getPost(postId: string): Promise<any> {
    const { data, error } = await supabase
      .from('posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (error) throw error;
    return data;
  }

  // Placeholder methods for additional functionality
  private inferTargetType(activity: ActivityPayload): string { return 'post'; }
  private formatMediaAttachments(attachments: any[]): any[] { return attachments; }
  private resolveReplyTarget(replyToId: string): Promise<string> { return Promise.resolve(''); }
  private verifyActivitySignature(activity: ActivityPubActivity, signature?: string): Promise<boolean> { return Promise.resolve(true); }
  private resolveActor(actorUrl: string): Promise<any> { return Promise.resolve(null); }
  private parseActivityPubContent(content: any): any[] { 
    // Robust ActivityPub content parsing that always returns proper JSONB array format
    try {
      if (Array.isArray(content)) {
        // Already in array format, validate structure
        return content.map(item => {
          if (typeof item === 'string') {
            return { type: 'text', text: item };
          } else if (item && typeof item === 'object' && item.type) {
            return item;
          } else {
            return { type: 'text', text: String(item || '') };
          }
        });
      } else if (typeof content === 'string') {
        // Try to parse JSON string
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            return this.parseActivityPubContent(parsed); // Recursive call to validate array
          } else {
            return [{ type: 'text', text: String(parsed) }];
          }
        } catch {
          // Plain text content
          return [{ type: 'text', text: content }];
        }
      } else if (content && typeof content === 'object') {
        // Single object, wrap in array
        return [{ type: 'text', text: String(content) }];
      } else {
        // Fallback for null, undefined, etc.
        return [{ type: 'text', text: String(content || '') }];
      }
    } catch (error) {
      console.error('❌ Failed to parse ActivityPub content:', error);
      return [{ type: 'text', text: String(content || '') }];
    }
  }
  private parseVisibility(to: string[], cc: string[]): string { return 'public'; }
  private resolveReplyId(replyTo: string): Promise<string | null> { return Promise.resolve(null); }
  private parseMediaAttachments(attachments: any[]): any[] { return []; }
  private resolveActorInbox(actorUrl: string): Promise<DeliveryTarget | null> { return Promise.resolve(null); }
  private getPostAuthorInbox(objectUrl: string): Promise<DeliveryTarget | null> { return Promise.resolve(null); }
  private resolveActorInboxUrl(actorUrl: string): Promise<string | null> { return Promise.resolve(null); }
  private processUpdateActivity(activity: ActivityPubActivity): Promise<boolean> { return Promise.resolve(false); }
  private processDeleteActivity(activity: ActivityPubActivity): Promise<boolean> { return Promise.resolve(false); }
  private processFollowActivity(activity: ActivityPubActivity): Promise<boolean> { return Promise.resolve(false); }
  private processAcceptActivity(activity: ActivityPubActivity): Promise<boolean> { return Promise.resolve(false); }
  private processRejectActivity(activity: ActivityPubActivity): Promise<boolean> { return Promise.resolve(false); }
  private processLikeActivity(activity: ActivityPubActivity): Promise<boolean> { return Promise.resolve(false); }
  private processUndoActivity(activity: ActivityPubActivity): Promise<boolean> { return Promise.resolve(false); }
}

// Export singleton instance
export const federationService = new FederationService();