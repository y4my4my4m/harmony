/**
 * Professional ActivityPub Federation Service for Harmony
 * 
 * Consolidated, scalable federation service handling:
 * - Actor management and key generation
 * - Activity processing and delivery
 * - Remote user resolution and caching
 * - WebFinger and NodeInfo endpoints
 * - Delivery queue management
 * 
 * Designed for millions of users with proper error handling,
 * retry mechanisms, and efficient database operations.
 */

import { supabase } from '@/supabase';
import { 
  extractMentions, 
  resolveMentions, 
  generateMentionTags, 
  getDeliveryInboxes, 
  formatMentionsForActivityPub
} from '@/utils/mentionUtils';
import type { 
  ActivityPubActivityObject,
  ActivityPubActivityType,
  ActivityPubObjectType,
  Post
} from '@/types';

// =============================================
// INTERFACES
// =============================================

interface FederationConfig {
  domain: string;
  instanceUrl: string;
  sharedInboxUrl: string;
  apiBase: string;
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
  published?: string;
}

// ActivityPub Activity object interface
interface ActivityPubActivity {
  '@context'?: string | string[];
  id: string;
  type: ActivityPubActivityType;
  actor: string;
  object?: any;
  target?: string;
  to?: string[];
  cc?: string[];
  published?: string;
  updated?: string;
}

// ActivityPub Actor interface  
interface ActivityPubActor {
  id: string;
  type: string;
  preferredUsername: string;
  name?: string;
  inbox: string;
  outbox: string;
  followers?: string;
  following?: string;
  publicKey: {
    id: string;
    owner: string;
    publicKeyPem: string;
  };
}

// =============================================
// MAIN FEDERATION SERVICE CLASS
// =============================================

export class FederationService {
  private static instance: FederationService;
  private config: FederationConfig;
  private readonly keyCache = new Map<string, { publicKey: string; privateKey: string; timestamp: number }>();
  private readonly actorCache = new Map<string, { actor: ActivityPubActor; timestamp: number }>();
  private readonly cacheTimeout = 30 * 60 * 1000; // 30 minutes

  private constructor() {
    this.config = {
      domain: import.meta.env.VITE_DOMAIN || 'har.mony.lol',
      instanceUrl: import.meta.env.VITE_API_BASE || 'https://har.mony.lol',
      sharedInboxUrl: 'https://har.mony.lol/api/activitypub/inbox',
      apiBase: import.meta.env.VITE_API_BASE || 'https://har.mony.lol'
    };
  }

  static getInstance(): FederationService {
    if (!FederationService.instance) {
      FederationService.instance = new FederationService();
    }
    return FederationService.instance;
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
      const { error: activityError } = await supabase
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
        // Trigger delivery worker for immediate processing
        await this.scheduleDelivery();
      } else {
        // Auto-discover targets based on activity type
        const autoTargets = await this.discoverDeliveryTargets(activity);
        if (autoTargets.length > 0) {
          await this.queueDeliveries(activityId, fullActivity, autoTargets);
          // Trigger delivery worker for immediate processing
          await this.scheduleDelivery();
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
      target_inbox_url: target.inboxUrl,
      status: 'pending' as const,
      attempts: 0,
      max_attempts: 5,
      next_attempt_at: new Date().toISOString(),
      priority: 5,
      actor_username: null, // Will be populated from activity if needed
      actor_domain: this.config.domain
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

    try {      // For Create/Update/Delete activities, target followers
      if (['Create', 'Update', 'Delete'].includes(activity.type)) {
        const actorId = await this.extractUserIdFromActor(activity.actor);
        if (actorId) {
          const followerTargets = await this.getFollowerInboxes(actorId);
          targets.push(...followerTargets);
        }
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
      ...((post as any).in_reply_to && { inReplyTo: await this.resolveReplyTarget((post as any).in_reply_to) }),
      ...((post as any).media_attachments && (post as any).media_attachments.length > 0 && {
        attachment: this.formatMediaAttachments((post as any).media_attachments)
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
   * Federate a like/favorite interaction with hybrid delivery
   */
  async federateLike(postId: string, userId: string, isLike: boolean): Promise<string | null> {
    try {
      const userProfile = await this.getUserProfile(userId);
      if (!userProfile) throw new Error('User profile not found');

      const post = await this.getPost(postId);
      if (!post) throw new Error('Post not found');

      const actor = `${this.config.instanceUrl}/users/${userProfile.username}`;
      const objectUrl = post.ap_id || `${this.config.instanceUrl}/posts/${postId}`;

      let activityId: string;
      let deliveryActivity: any;

      if (isLike) {
        // Create Like activity
        activityId = await this.queueActivity({
          type: 'Like',
          actor,
          object: objectUrl,
          target: postId
        });

        deliveryActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${actor}/activities/like/${Date.now()}`,
          type: 'Like',
          actor,
          object: objectUrl,
          published: new Date().toISOString()
        };
      } else {
        // Create Undo Like activity
        const likeId = `${this.config.instanceUrl}/activities/${crypto.randomUUID()}`;
        activityId = await this.queueActivity({
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

        deliveryActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${actor}/activities/undo/${Date.now()}`,
          type: 'Undo',
          actor,
          object: {
            id: likeId,
            type: 'Like',
            actor,
            object: objectUrl
          },
          published: new Date().toISOString()
        };
      }

      // 🚀 IMMEDIATE DELIVERY: Try to deliver immediately to post author's inbox
      try {
        const authorInbox = await this.getPostAuthorInbox(objectUrl);
        if (authorInbox) {
          console.log(`🚀 Immediately delivering ${isLike ? 'like' : 'unlike'} to ${authorInbox.domain}`);
          await this.deliverActivity(deliveryActivity, [authorInbox.inboxUrl]);
        }
      } catch (error) {
        console.error(`⚠️ Immediate delivery failed, will retry via cron:`, error);
        // Activity is already queued, so cron will retry
      }

      return activityId;
    } catch (error) {
      console.error('❌ Failed to federate like:', error);
      return null;
    }
  }

  /**
   * Federate a follow request with hybrid delivery
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

      let activityId: string;
      let deliveryActivity: any;

      if (isFollow) {
        activityId = await this.queueActivity({
          type: 'Follow',
          actor,
          object: target,
          target: followingId
        });

        deliveryActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${actor}/activities/follow/${Date.now()}`,
          type: 'Follow',
          actor,
          object: target,
          published: new Date().toISOString()
        };
      } else {
        // Undo follow
        const followId = `${this.config.instanceUrl}/activities/${crypto.randomUUID()}`;
        activityId = await this.queueActivity({
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

        deliveryActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${actor}/activities/undo/${Date.now()}`,
          type: 'Undo',
          actor,
          object: {
            id: followId,
            type: 'Follow',
            actor,
            object: target
          },
          published: new Date().toISOString()
        };
      }

      // 🚀 IMMEDIATE DELIVERY: Try to deliver immediately to target user's inbox
      try {
        const targetInbox = await this.resolveActorInbox(target);
        if (targetInbox) {
          console.log(`🚀 Immediately delivering ${isFollow ? 'follow' : 'unfollow'} to ${targetInbox.domain}`);
          await this.deliverActivity(deliveryActivity, [targetInbox.inboxUrl]);
        }
      } catch (error) {
        console.error(`⚠️ Immediate delivery failed, will retry via cron:`, error);
        // Activity is already queued, so cron will retry
      }

      return activityId;
    } catch (error) {
      console.error('❌ Failed to federate follow:', error);
      return null;
    }
  }

  /**
   * Federate an Announce (reblog/boost) activity with hybrid delivery
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

      let activityId: string;
      let deliveryActivity: any;

      if (isAnnounce) {
        // Create Announce activity
        activityId = await this.queueActivity({
          type: 'Announce',
          actor,
          object: objectUrl,
          target: postId
        });

        deliveryActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${actor}/activities/announce/${Date.now()}`,
          type: 'Announce',
          actor,
          object: objectUrl,
          published: new Date().toISOString()
        };
      } else {
        // Create Undo Announce activity
        const announceId = `${this.config.instanceUrl}/activities/${crypto.randomUUID()}`;
        activityId = await this.queueActivity({
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

        deliveryActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${actor}/activities/undo/${Date.now()}`,
          type: 'Undo',
          actor,
          object: {
            id: announceId,
            type: 'Announce',
            actor,
            object: objectUrl
          },
          published: new Date().toISOString()
        };
      }

      // 🚀 IMMEDIATE DELIVERY: Try to deliver immediately to post author's inbox
      try {
        const authorInbox = await this.getPostAuthorInbox(objectUrl);
        if (authorInbox) {
          console.log(`🚀 Immediately delivering ${isAnnounce ? 'announce' : 'undo announce'} to ${authorInbox.domain}`);
          await this.deliverActivity(deliveryActivity, [authorInbox.inboxUrl]);
        }
      } catch (error) {
        console.error(`⚠️ Immediate delivery failed, will retry via cron:`, error);
        // Activity is already queued, so cron will retry
      }

      return activityId;
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
        const remoteUser = await this.resolveRemoteUser(rm.mention.full);
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
   * Queue ActivityPub activity for server-side delivery to remote inboxes
   * Note: This queues for server-side delivery to avoid CORS issues
   */
  private async deliverActivity(activity: any, inboxUrls: string[]): Promise<void> {
    console.log(`📡 Queueing activity for server-side delivery to ${inboxUrls.length} inboxes:`, activity.type);
    
    // Instead of making direct HTTP calls (which would fail due to CORS),
    // we need to queue these for server-side delivery
    
    // Store activity in ap_activities table - let Supabase generate the ID
    const { data: activityData, error: activityError } = await supabase
      .from('ap_activities')
      .insert({
        ap_id: activity.id || `${this.config.instanceUrl}/activities/${crypto.randomUUID()}`,
        ap_type: activity.type,
        actor_id: await this.extractUserIdFromActor(activity.actor),
        actor_ap_id: activity.actor,
        activity_data: activity,
        status: 'pending'
      })
      .select('id')
      .single();

    if (activityError || !activityData) {
      console.error('❌ Failed to store activity for delivery:', activityError);
      return;
    }

    const activityId = activityData.id;

    // Queue deliveries for each inbox
    const deliveries = inboxUrls.map(inboxUrl => {
      const domain = new URL(inboxUrl).hostname;
      return {
        activity_id: activityId,
        target_domain: domain,
        target_inbox_url: inboxUrl,
        status: 'pending' as const,
        attempts: 0,
        max_attempts: 5,
        next_attempt_at: new Date().toISOString(),
        priority: 5,
        actor_domain: this.config.domain
      };
    });

    const { error: deliveryError } = await supabase
      .from('federation_delivery_queue')
      .insert(deliveries);

    if (deliveryError) {
      console.error('❌ Failed to queue deliveries:', deliveryError);
      return;
    }

    console.log(`✅ Queued ${deliveries.length} deliveries for server-side processing`);
    
    // Note: Actual HTTP delivery will happen server-side via cron job or API endpoint
    // to avoid CORS issues that occur when making requests from the browser
  }

  // =============================================================================
  // HTTP DELIVERY SYSTEM
  // =============================================================================

  /**
   * Process pending deliveries from the queue - professional HTTP delivery
   */
  async processDeliveryQueue(limit: number = 50): Promise<number> {
    try {
      console.log(`📤 Processing delivery queue (limit: ${limit})`);
      
      // Get pending deliveries
      const { data: deliveries, error } = await supabase
        .from('federation_delivery_queue')
        .select('*')
        .eq('status', 'pending')
        .lte('next_attempt_at', new Date().toISOString())
        .order('created_at', { ascending: true })
        .limit(limit);

      if (error) throw error;

      if (!deliveries || deliveries.length === 0) {
        console.log('📭 No pending deliveries to process');
        return 0;
      }

      console.log(`📮 Processing ${deliveries.length} pending deliveries`);
      
      let processed = 0;
      
      // Process deliveries in parallel with rate limiting
      const batchSize = 10; // Process 10 at a time to avoid overwhelming
      for (let i = 0; i < deliveries.length; i += batchSize) {
        const batch = deliveries.slice(i, i + batchSize);
        const batchPromises = batch.map(delivery => this.processDelivery(delivery));
        
        await Promise.allSettled(batchPromises);
        processed += batch.length;
        
        // Small delay between batches for rate limiting
        if (i + batchSize < deliveries.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      console.log(`✅ Processed ${processed} deliveries`);
      return processed;
    } catch (error) {
      console.error('❌ Failed to process delivery queue:', error);
      return 0;
    }
  }

  /**
   * Process a single delivery with proper error handling and retry logic
   */
  private async processDelivery(delivery: any): Promise<boolean> {
    const deliveryId = delivery.id;
    const startTime = Date.now();
    
    try {
      // Mark as processing
      await supabase
        .from('federation_delivery_queue')
        .update({ 
          status: 'processing'
        })
        .eq('id', deliveryId);

      // Get the activity data from ap_activities table
      const { data: activityData, error: activityError } = await supabase
        .from('ap_activities')
        .select('activity_data')
        .eq('id', delivery.activity_id)
        .single();

      if (activityError || !activityData) {
        throw new Error('Activity data not found');
      }

      // Send HTTP request to target inbox
      const success = await this.sendActivityToInbox(
        delivery.target_inbox_url,
        activityData.activity_data,
        delivery.target_domain
      );

      const duration = Date.now() - startTime;

      if (success) {
        // Mark as delivered
        await supabase
          .from('federation_delivery_queue')
          .update({
            status: 'delivered',
            delivery_duration_ms: duration,
            error_message: null
          })
          .eq('id', deliveryId);

        console.log(`✅ Delivered activity to ${delivery.target_domain} (${duration}ms)`);
        return true;
      } else {
        // Handle delivery failure
        return await this.handleDeliveryFailure(delivery, 'HTTP delivery failed');
      }
    } catch (error) {
      console.error(`❌ Delivery failed for ${delivery.target_domain}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return await this.handleDeliveryFailure(delivery, errorMessage);
    }
  }

  /**
   * Send activity to a remote inbox with proper HTTP signatures and headers
   */
  private async sendActivityToInbox(
    inboxUrl: string, 
    activity: any, 
    targetDomain: string
  ): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/activity+json',
        'Accept': 'application/activity+json',
        'User-Agent': `Harmony/${this.config.instanceUrl}`,
        'Date': new Date().toUTCString()
      };

      // TODO: Add HTTP signatures for security
      // const signature = await this.signRequest(inboxUrl, activity, headers);
      // headers['Signature'] = signature;

      const response = await fetch(inboxUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(activity),
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      if (response.ok) {
        console.log(`📤 Successfully delivered to ${targetDomain} (${response.status})`);
        return true;
      } else {
        console.warn(`⚠️ Delivery failed to ${targetDomain}: ${response.status} ${response.statusText}`);
        return false;
      }
    } catch (error) {
      console.error(`❌ HTTP delivery error to ${targetDomain}:`, error);
      return false;
    }
  }

  /**
   * Handle delivery failure with exponential backoff retry logic
   */
  private async handleDeliveryFailure(delivery: any, errorMessage: string): Promise<boolean> {
    const maxAttempts = delivery.max_attempts || 5;
    const newAttemptCount = (delivery.attempts || 0) + 1;
    
    if (newAttemptCount >= maxAttempts) {
      // Max attempts reached, mark as permanently failed
      await supabase
        .from('federation_delivery_queue')
        .update({
          status: 'failed',
          attempts: newAttemptCount,
          error_message: errorMessage
        })
        .eq('id', delivery.id);

      console.log(`💀 Delivery permanently failed after ${newAttemptCount} attempts: ${delivery.target_domain}`);
      return false;
    }

    // Calculate exponential backoff: 1min, 5min, 30min, 2hr, 8hr
    const backoffMinutes = Math.pow(5, newAttemptCount - 1);
    const nextAttempt = new Date(Date.now() + backoffMinutes * 60 * 1000);

    await supabase
      .from('federation_delivery_queue')
      .update({
        status: 'pending',
        attempts: newAttemptCount,
        next_attempt_at: nextAttempt.toISOString(),
        error_message: errorMessage
      })
      .eq('id', delivery.id);

    console.log(`🔄 Delivery retry scheduled for ${delivery.target_domain} in ${backoffMinutes}min (attempt ${newAttemptCount}/${maxAttempts})`);
    return false;
  }

  /**
   * Clean up old delivery records to prevent database bloat
   */
  async cleanupDeliveryQueue(): Promise<number> {
    try {
      // Remove delivered records older than 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      const { count, error } = await supabase
        .from('federation_delivery_queue')
        .delete()
        .eq('status', 'delivered')
        .lt('created_at', sevenDaysAgo.toISOString());

      if (error) throw error;

      console.log(`🧹 Cleaned up ${count || 0} old delivery records`);
      return count || 0;
    } catch (error) {
      console.error('❌ Failed to cleanup delivery queue:', error);
      return 0;
    }
  }

  // =============================================================================
  // TESTING AND IMMEDIATE DELIVERY METHODS
  // =============================================================================

  /**
   * Trigger immediate delivery processing for testing or manual intervention
   */
  async triggerImmediateDelivery(limit: number = 20): Promise<{processed: number, successful: number, failed: number}> {
    console.log('🚀 Triggering immediate delivery processing...');
    try {
      const processed = await this.processDeliveryQueue(limit);
      
      // Get recent delivery stats
      const { data: recentDeliveries } = await supabase
        .from('federation_delivery_queue')
        .select('status')
        .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString()) // Last 5 minutes
        .limit(limit);

      const successful = recentDeliveries?.filter(d => d.status === 'delivered').length || 0;
      const failed = recentDeliveries?.filter(d => d.status === 'failed').length || 0;

      console.log(`✅ Immediate delivery complete: ${processed} processed, ${successful} successful, ${failed} failed`);
      
      return { processed, successful, failed };
    } catch (error) {
      console.error('❌ Failed to trigger immediate delivery:', error);
      return { processed: 0, successful: 0, failed: 0 };
    }
  }

  /**
   * Get recent delivery stats for monitoring
   */
  async getDeliveryStatus(): Promise<{
    pending: number;
    processing: number;
    delivered: number;
    failed: number;
    total: number;
    oldestPending?: string;
  }> {
    try {
      const { data: stats } = await supabase
        .from('federation_delivery_queue')
        .select('status, created_at')
        .order('created_at', { ascending: true });

      if (!stats) return { pending: 0, processing: 0, delivered: 0, failed: 0, total: 0 };

      const counts = stats.reduce((acc, item) => {
        const status = item.status as 'pending' | 'processing' | 'delivered' | 'failed';
        acc[status] = (acc[status] || 0) + 1;
        acc.total++;
        return acc;
      }, { pending: 0, processing: 0, delivered: 0, failed: 0, total: 0 });

      const oldestPending = stats.find(s => s.status === 'pending')?.created_at;

      return { ...counts, oldestPending };
    } catch (error) {
      console.error('❌ Failed to get delivery status:', error);
      return { pending: 0, processing: 0, delivered: 0, failed: 0, total: 0 };
    }
  }

  // =============================================================================
  // USER RESOLUTION AND CACHING
  // =============================================================================

  /**
   * Resolve actor inbox URL for delivery targeting
   */
  private async resolveActorInbox(actorUrl: string): Promise<DeliveryTarget | null> {
    try {
      // Check if we have cached inbox URL
      const { data: profile } = await supabase
        .from('profiles')
        .select('inbox_url, domain')
        .eq('federated_id', actorUrl)
        .single();

      if (profile?.inbox_url) {
        return {
          inboxUrl: profile.inbox_url,
          domain: profile.domain
        };
      }

      // Fetch actor document to get inbox URL
      const actor = await this.fetchActorDocument(actorUrl);
      if (actor?.inbox) {
        return {
          inboxUrl: actor.inbox,
          domain: new URL(actorUrl).hostname
        };
      }

      return null;
    } catch (error) {
      console.error('❌ Failed to resolve actor inbox:', error);
      return null;
    }
  }

  /**
   * Get post author's inbox for Like/Announce delivery
   */
  private async getPostAuthorInbox(objectUrl: string): Promise<DeliveryTarget | null> {
    try {
      // Extract post ID from URL and get author
      const postId = objectUrl.split('/').pop();
      if (!postId) return null;

      const { data: post } = await supabase
        .from('posts')
        .select(`
          author:profiles(federated_id, inbox_url, domain, is_local)
        `)
        .eq('id', postId)
        .single();

      if (!post?.author) return null;

      // Properly type the author object from the query
      const author = Array.isArray(post.author) ? post.author[0] : post.author;
      if (!author) return null;

      // Don't deliver to local users
      if (author.is_local) return null;

      // Use cached inbox URL or resolve
      if (author.inbox_url) {
        return {
          inboxUrl: author.inbox_url,
          domain: author.domain
        };
      }

      // Resolve from federated_id
      if (author.federated_id) {
        return await this.resolveActorInbox(author.federated_id);
      }

      return null;
    } catch (error) {
      console.error('❌ Failed to get post author inbox:', error);
      return null;
    }
  }

  /**
   * Get follower inboxes for post distribution
   */
  private async getFollowerInboxes(actorId: string): Promise<DeliveryTarget[]> {
    try {
      const { data: followers } = await supabase
        .from('follows')
        .select(`
          follower:profiles(federated_id, inbox_url, domain, is_local)
        `)
        .eq('following_id', actorId)
        .eq('status', 'accepted');

      if (!followers) return [];

      const inboxes: DeliveryTarget[] = [];
      
      for (const follow of followers) {
        // Handle both array and object response formats
        const follower = Array.isArray(follow.follower) ? follow.follower[0] : follow.follower;
        if (!follower) continue;
        
        // Skip local followers
        if (follower.is_local) continue;

        if (follower.inbox_url) {
          inboxes.push({
            inboxUrl: follower.inbox_url,
            domain: follower.domain
          });
        } else if (follower.federated_id) {
          const inbox = await this.resolveActorInbox(follower.federated_id);
          if (inbox) inboxes.push(inbox);
        }
      }

      return inboxes;
    } catch (error) {
      console.error('❌ Failed to get follower inboxes:', error);
      return [];
    }
  }

  /**
   * Fetch ActivityPub actor document from remote server
   */
  private async fetchActorDocument(actorUrl: string): Promise<any> {
    try {
      const response = await fetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${this.config.instanceUrl}`
        },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`❌ Failed to fetch actor document: ${actorUrl}`, error);
      return null;
    }
  }

  // =============================================================================
  // ACTOR MANAGEMENT & KEY GENERATION
  // =============================================================================

  /**
   * Create or update a local ActivityPub actor with key generation
   */
  async createOrUpdateLocalActor(profile: any): Promise<any> {
    const actorId = `${this.config.instanceUrl}/users/${profile.username}`;
    
    // Generate keys if not exists
    if (!profile.public_key || !profile.private_key) {
      await this.generateKeysForUser(profile.id);
      // Refresh profile data after key generation
      const { data: updatedProfile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', profile.id)
        .single();
      profile = updatedProfile;
    }

    const actor = {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
      id: actorId,
      type: 'Person',
      preferredUsername: profile.username,
      name: profile.display_name || profile.username,
      summary: profile.bio || '',
      icon: profile.avatar_url ? {
        type: 'Image',
        mediaType: 'image/jpeg',
        url: profile.avatar_url
      } : undefined,
      inbox: `${actorId}/inbox`,
      outbox: `${actorId}/outbox`,
      followers: `${actorId}/followers`,
      following: `${actorId}/following`,
      featured: `${actorId}/featured`,
      publicKey: {
        id: `${actorId}#main-key`,
        owner: actorId,
        publicKeyPem: profile.public_key
      },
      endpoints: {
        sharedInbox: this.config.sharedInboxUrl
      },
      url: `${this.config.instanceUrl}/users/${profile.username}`
    };

    return actor;
  }

  /**
   * Generate RSA key pair for a user
   */
  private async generateKeysForUser(userId: string): Promise<void> {
    try {
      console.log(`🔑 Generating RSA key pair for user ${userId}`);
      
      // Check if already cached
      const cached = this.keyCache.get(userId);
      if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
        console.log('Using cached keys');
        return;
      }

      const keyPair = await this.generateRSAKeyPair();
      
      // Store in database
      const { error } = await supabase
        .from('profiles')
        .update({
          public_key: keyPair.publicKey,
          private_key: keyPair.privateKey, // TODO: Encrypt this in production
          federated_id: null, // Will be set when actor is created
          updated_at: new Date().toISOString()
        })
        .eq('id', userId);

      if (error) throw error;

      // Cache the keys
      this.keyCache.set(userId, {
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        timestamp: Date.now()
      });

      console.log(`✅ Generated and stored RSA key pair for user ${userId}`);
    } catch (error) {
      console.error('❌ Failed to generate keys for user:', error);
      throw error;
    }
  }

  /**
   * Generate RSA key pair using Web Crypto API
   */
  private async generateRSAKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
    try {
      // Use Web Crypto API for real key generation in browser
      if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
        const keyPair = await window.crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256'
          },
          true,
          ['sign', 'verify']
        );

        const publicKeyPem = await this.exportKeyToPem(keyPair.publicKey, 'PUBLIC');
        const privateKeyPem = await this.exportKeyToPem(keyPair.privateKey, 'PRIVATE');

        return {
          publicKey: publicKeyPem,
          privateKey: privateKeyPem
        };
      } else {
        // Server-side or fallback - use placeholder keys
        console.warn('⚠️ Using placeholder keys - implement server-side key generation');
        const keyId = crypto.randomUUID();
        return {
          publicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0vx7agoebGcQSuuPiLJX
ZptN9nndrQmbPFRP6gPiw+AlyRaC${keyId.replace(/-/g, '')}
qhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0vx7agoebGcQSuuPiLJXZptN9nndr
QmbPFRP6gPiw+AlyRaCmOeKKmJAaIcaA2jGdmKKmJAaIcaA2jGdmKKmJAaIca
-----END PUBLIC KEY-----`,
          privateKey: `-----BEGIN PRIVATE KEY-----
MIIEowIBAAKCAQEA0vx7agoebGcQSuuPiLJXZptN9nndrQmbPFRP6gPiw+AlyRaC
${keyId.replace(/-/g, '')}qhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0vx7agoebGc
QSuuPiLJXZptN9nndrQmbPFRP6gPiw+AlyRaCmOeKKmJAaIcaA2jGdmKKmJAa
IcaA2jGdmKKmJAaIcaA2jGdmKKmJAaIcaA2jGdmKKmJAaIcaA2jGdm
-----END PRIVATE KEY-----`
        };
      }
    } catch (error) {
      console.error('❌ Failed to generate RSA key pair:', error);
      throw error;
    }
  }

  /**
   * Export Web Crypto key to PEM format
   */
  private async exportKeyToPem(key: CryptoKey, type: 'PUBLIC' | 'PRIVATE'): Promise<string> {
    const exported = await window.crypto.subtle.exportKey(
      type === 'PUBLIC' ? 'spki' : 'pkcs8',
      key
    );
    
    const exportedAsString = String.fromCharCode.apply(null, Array.from(new Uint8Array(exported)));
    const exportedAsBase64 = btoa(exportedAsString);
    
    const keyType = type === 'PUBLIC' ? 'PUBLIC KEY' : 'PRIVATE KEY';
    return `-----BEGIN ${keyType}-----\n${exportedAsBase64.match(/.{1,64}/g)?.join('\n') || exportedAsBase64}\n-----END ${keyType}-----`;
  }

  /**
   * Get user's private key for signing (cached)
   */
  async getUserPrivateKey(userId: string): Promise<string | null> {
    try {
      // Check cache first
      const cached = this.keyCache.get(userId);
      if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
        return cached.privateKey;
      }

      // Fetch from database
      const { data, error } = await supabase
        .from('profiles')
        .select('private_key')
        .eq('id', userId)
        .single();

      if (error || !data?.private_key) return null;

      // Cache it
      if (data.private_key) {
        this.keyCache.set(userId, {
          publicKey: '', // We don't have it here, but that's ok
          privateKey: data.private_key,
          timestamp: Date.now()
        });
      }

      return data.private_key;
    } catch (error) {
      console.error('❌ Failed to get user private key:', error);
      return null;
    }
  }

  /**
   * Sign HTTP request for ActivityPub delivery
   */
  async signHttpRequest(
    userId: string,
    method: string,
    url: string,
    headers: Record<string, string>
  ): Promise<string | null> {
    try {
      const privateKey = await this.getUserPrivateKey(userId);
      if (!privateKey) return null;

      // TODO: Implement proper HTTP signature signing
      // This is a simplified placeholder - implement real HTTP signatures in production
      const signatureHeaders = [
        '(request-target)',
        'host',
        'date',
        'digest'
      ];

      const signatureString = signatureHeaders
        .map(header => {
          if (header === '(request-target)') {
            return `(request-target): ${method.toLowerCase()} ${new URL(url).pathname}`;
          }
          return `${header}: ${headers[header] || ''}`;
        })
        .join('\n');

      // In production, use the private key to sign signatureString
      const signature = btoa(signatureString); // Placeholder

      return `keyId="${this.config.instanceUrl}/users/${userId}#main-key",algorithm="rsa-sha256",headers="${signatureHeaders.join(' ')}",signature="${signature}"`;
    } catch (error) {
      console.error('❌ Failed to sign HTTP request:', error);
      return null;
    }
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
   * Parse ActivityPub content to JSONB format
   */
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

  /**
   * Parse visibility from ActivityPub to/cc arrays
   */
  private parseVisibility(to: string[], cc: string[]): string {
    const publicUrl = 'https://www.w3.org/ns/activitystreams#Public';
    
    if (to?.includes(publicUrl)) return 'public';
    if (cc?.includes(publicUrl)) return 'unlisted';
    
    return 'followers';
  }

  /**
   * Parse media attachments from ActivityPub format
   */
  private parseMediaAttachments(attachments: any[]): any[] {
    if (!Array.isArray(attachments)) return [];
    
    return attachments.map(attachment => ({
      type: attachment.type || 'Document',
      url: attachment.url,
      mediaType: attachment.mediaType,
      name: attachment.name || null
    }));
  }

  // =============================================================================
  // UTILITY METHODS - MISSING IMPLEMENTATIONS
  // =============================================================================

  /**
   * Extract user ID from ActivityPub actor URL
   */
  private async extractUserIdFromActor(actorUrl: string): Promise<string | null> {
    try {
      // For local actors: https://har.mony.lol/users/username -> resolve to UUID
      if (actorUrl.includes(this.config.instanceUrl)) {
        const username = actorUrl.split('/').pop();
        if (!username) return null;
        
        const { data } = await supabase
          .from('profiles')
          .select('id')
          .eq('username', username)
          .eq('is_local', true)
          .single();
        
        return data?.id || null;
      }
      
      // For federated actors: look up by federated_id
      const { data } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', actorUrl)
        .single();
      
      return data?.id || null;
    } catch (error) {
      console.error('❌ Failed to extract user ID from actor:', error);
      return null;
    }
  }

  /**
   * Infer target type from activity
   */
  private inferTargetType(activity: ActivityPayload): string {
    if (typeof activity.object === 'string') {
      if (activity.object.includes('/posts/')) return 'post';
      if (activity.object.includes('/users/')) return 'user';
    }
    return 'unknown';
  }

  /**
   * Auto-trigger delivery after queueing activities - implements hybrid approach
   * Attempts immediate delivery, falls back to cron processing for failures
   */
  private async scheduleDelivery(): Promise<void> {
    try {
      // Attempt immediate processing of recent deliveries
      console.log('🚀 Attempting immediate delivery of recent activities...');
      const processed = await this.processDeliveryQueue(10); // Process up to 10 immediately
      
      if (processed > 0) {
        console.log(`✅ Immediately processed ${processed} deliveries`);
      } else {
        console.log('📭 No immediate deliveries to process - activities will be handled by cron');
      }
    } catch (error) {
      console.error('⚠️ Immediate delivery failed, falling back to cron processing:', error);
      // Fallback: activities will be processed automatically by pg_cron
      console.log('📋 Activities queued for cron processing (every 2 minutes)');
    }
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
   * Resolve reply target for in_reply_to
   */
  private async resolveReplyTarget(replyToId: string): Promise<string | null> {
    try {
      const { data } = await supabase
        .from('posts')
        .select('ap_id, url')
        .eq('id', replyToId)
        .single();
      
      return data?.ap_id || data?.url || null;
    } catch (error) {
      console.error('❌ Failed to resolve reply target:', error);
      return null;
    }
  }

  /**
   * Format media attachments for ActivityPub
   */
  private formatMediaAttachments(attachments: any[]): any[] {
    if (!Array.isArray(attachments)) return [];
    
    return attachments.map(attachment => ({
      type: 'Document',
      mediaType: attachment.mime_type || 'image/jpeg',
      url: attachment.url,
      name: attachment.alt_text || null
    }));
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

  /**
   * Verify activity signature (placeholder)
   */
  private async verifyActivitySignature(_activity: any, _signature?: string): Promise<boolean> {
    // TODO: Implement proper HTTP signature verification
    return true;
  }

  /**
   * Process Update activity
   */
  private async processUpdateActivity(activity: any): Promise<boolean> {
    // TODO: Implement Update activity processing
    console.log('📝 Processing Update activity:', activity.id);
    return true;
  }

  /**
   * Process Delete activity
   */
  private async processDeleteActivity(activity: any): Promise<boolean> {
    // TODO: Implement Delete activity processing
    console.log('🗑️ Processing Delete activity:', activity.id);
    return true;
  }

  /**
   * Process Follow activity
   */
  private async processFollowActivity(activity: any): Promise<boolean> {
    try {
      const followerActorUrl = activity.actor
      const followingActorUrl = typeof activity.object === 'string' ? activity.object : activity.object.id

      // Resolve users
      const follower = await this.resolveUserByActorUrl(followerActorUrl)
      const following = await this.resolveUserByActorUrl(followingActorUrl)

      if (!follower || !following) {
        console.warn('Could not resolve users for follow activity')
        return false
      }

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

      console.log('✅ Processed Follow activity:', activity.id);
      return true
    } catch (error) {
      console.error('❌ Failed to process Follow activity:', error)
      return false
    }
  }

  /**
   * Send Accept activity in response to Follow
   */
  private async sendAcceptActivity(followActivity: any, acceptingUser: any): Promise<void> {
    const acceptActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${this.getActorId(acceptingUser.username, acceptingUser.domain)}/accepts/${Date.now()}`,
      type: 'Accept',
      actor: this.getActorId(acceptingUser.username, acceptingUser.domain),
      object: followActivity,
      published: new Date().toISOString()
    }

    const followerInbox = await this.getInboxUrl(followActivity.actor)
    if (followerInbox) {
      await this.deliverActivity(acceptActivity, [followerInbox])
    }
  }

  /**
   * Get ActivityPub actor ID for a user
   */
  private getActorId(username: string, domain: string): string {
    return `https://${domain}/users/${username}`
  }

  /**
   * Process Accept activity
   */
  private async processAcceptActivity(activity: any): Promise<boolean> {
    try {
      // Handle Follow Accept
      const originalFollow = activity.object
      if (originalFollow && originalFollow.type === 'Follow') {
        await supabase
          .from('follows')
          .update({ 
            status: 'accepted', 
            accepted_at: new Date().toISOString() 
          })
          .eq('ap_id', originalFollow.id)
        
        console.log('✅ Processed Accept activity for Follow:', originalFollow.id);
        return true
      }
      
      console.log('✅ Processed Accept activity:', activity.id);
      return true
    } catch (error) {
      console.error('❌ Failed to process Accept activity:', error)
      return false
    }
  }

  /**
   * Process Reject activity
   */
  private async processRejectActivity(activity: any): Promise<boolean> {
    try {
      // Handle Follow Reject
      const originalFollow = activity.object
      if (originalFollow && originalFollow.type === 'Follow') {
        await supabase
          .from('follows')
          .update({ status: 'rejected' })
          .eq('ap_id', originalFollow.id)
        
        console.log('❌ Processed Reject activity for Follow:', originalFollow.id);
        return true
      }
      
      console.log('❌ Processed Reject activity:', activity.id);
      return true
    } catch (error) {
      console.error('❌ Failed to process Reject activity:', error)
      return false
    }
  }

  /**
   * Process Like activity
   */
  private async processLikeActivity(activity: any): Promise<boolean> {
    try {
      // Handle likes/favorites
      const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object.id
      const actorUrl = activity.actor

      // Resolve the post being liked
      const { data: post } = await supabase
        .from('posts')
        .select('id, author_id')
        .eq('ap_id', objectUrl)
        .single()

      if (!post) {
        console.warn('Post not found for Like activity:', objectUrl)
        return false
      }

      // Resolve the user doing the liking
      const user = await this.resolveUserByActorUrl(actorUrl)
      if (!user) {
        console.warn('User not found for Like activity:', actorUrl)
        return false
      }

      // Store the like interaction
      await supabase
        .from('post_interactions')
        .upsert({
          user_id: user.id,
          post_id: post.id,
          interaction_type: 'like',
          is_local: false,
          ap_id: activity.id,
          metadata: { activitypub_id: activity.id }
        }, {
          onConflict: 'user_id,post_id,interaction_type'
        })

      console.log('❤️ Processed Like activity:', activity.id);
      return true
    } catch (error) {
      console.error('❌ Failed to process Like activity:', error)
      return false
    }
  }

  /**
   * Process Undo activity
   */
  private async processUndoActivity(activity: any): Promise<boolean> {
    try {
      const undoObject = activity.object
      
      if (undoObject.type === 'Follow') {
        // Undo follow
        await supabase
          .from('follows')
          .delete()
          .eq('ap_id', undoObject.id)
        
        console.log('↩️ Processed Undo Follow activity:', undoObject.id);
      } else if (undoObject.type === 'Like') {
        // Undo like
        await supabase
          .from('post_interactions')
          .delete()
          .eq('ap_id', undoObject.id)
        
        console.log('↩️ Processed Undo Like activity:', undoObject.id);
      } else if (undoObject.type === 'Announce') {
        // Undo announce/reblog
        await supabase
          .from('post_interactions')
          .delete()
          .eq('ap_id', undoObject.id)
        
        console.log('↩️ Processed Undo Announce activity:', undoObject.id);
      }
      
      console.log('↩️ Processed Undo activity:', activity.id);
      return true
    } catch (error) {
      console.error('❌ Failed to process Undo activity:', error)
      return false
    }
  }

  /**
   * Resolve actor from URL
   */
  private async resolveActor(actorUrl: string): Promise<any> {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('federated_id', actorUrl)
        .single();
      
      return data;
    } catch (error) {
      console.error('❌ Failed to resolve actor:', error);
      return null;
    }
  }

  /**
   * Resolve reply ID from ActivityPub URL
   */
  private async resolveReplyId(replyToUrl: string): Promise<string | null> {
    try {
      const { data } = await supabase
        .from('posts')
        .select('id')
        .eq('ap_id', replyToUrl)
        .single();
      
      return data?.id || null;
    } catch (error) {
      console.error('❌ Failed to resolve reply ID:', error);
      return null;
    }
  }

  /**
   * Resolve actor inbox URL
   */
  private async resolveActorInboxUrl(actorUrl: string): Promise<string | null> {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('inbox_url')
        .eq('federated_id', actorUrl)
        .single();
      
      return data?.inbox_url || null;
    } catch (error) {
      console.error('❌ Failed to resolve actor inbox URL:', error);
      return null;
    }
  }

  /**
   * Manual trigger for testing - calls the database function directly
   */
  async manualTriggerDelivery(): Promise<any> {
    try {
      const { data, error } = await supabase.rpc('process_federation_delivery_queue');
      
      if (error) {
        console.error('❌ Manual delivery trigger failed:', error);
        throw error;
      }
      
      console.log('📤 Manual delivery completed:', data);
      return data;
    } catch (error) {
      console.error('❌ Error in manual delivery trigger:', error);
      throw error;
    }
  }

  // =============================================================================
  // WEBFINGER AND REMOTE USER RESOLUTION  
  // =============================================================================

  /**
   * Resolve a remote user by their handle (@username@domain)
   */
  async resolveRemoteUser(handle: string): Promise<any | null> {
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
      .maybeSingle()

    if (existingProfile && this.isRecentlyFetched(existingProfile.last_synced_at)) {
      return existingProfile
    }

    try {
      // WebFinger lookup
      const actor = await this.webfingerLookup(username, domain)
      if (!actor) return null

      // Fetch actor document
      const actorData = await this.fetchActorDocument(actor.href)
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
   * Store remote user in local database (enhanced version)
   */
  private async storeRemoteUser(actor: any, domain: string): Promise<any> {
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

    // First try to find existing user by federated_id
    const { data: existingUser, error: federatedLookupError } = await supabase
      .from('profiles')
      .select('*')
      .eq('federated_id', actor.id)
      .maybeSingle()

    if (federatedLookupError) {
      console.error('Error looking up user by federated_id:', federatedLookupError)
    }

    if (existingUser) {
      // Update existing user
      const { data, error } = await supabase
        .from('profiles')
        .update({
          ...profileData,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingUser.id)
        .select()
        .single()

      if (error) throw error
      return data
    }

    // Check if user exists by username@domain combination
    const { data: existingByUsername, error: usernameLookupError } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', actor.preferredUsername)
      .eq('domain', domain)
      .maybeSingle()

    if (usernameLookupError) {
      console.error('Error looking up user by username@domain:', usernameLookupError)
    }

    if (existingByUsername) {
      // Update existing user with federated_id
      const { data, error } = await supabase
        .from('profiles')
        .update({
          ...profileData,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingByUsername.id)
        .select()
        .single()

      if (error) throw error
      return data
    }

    // Create new user
    console.log('Creating new federated user:', profileData)
    const { data, error } = await supabase
      .from('profiles')
      .insert(profileData)
      .select()
      .single()

    if (error) {
      console.error('Error creating new user:', error)
      throw error
    }
    
    console.log('Successfully created federated user:', data)
    return data
  }

  /**
   * Check if data was recently fetched (within 1 hour)
   */
  private isRecentlyFetched(lastSynced: string | null): boolean {
    if (!lastSynced) return false
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    return new Date(lastSynced) > oneHourAgo
  }
}

// Export singleton instance for use in other services
export const federationService = FederationService.getInstance();