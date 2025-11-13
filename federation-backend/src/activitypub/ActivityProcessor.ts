import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import {
  actorToProfile,
  noteToContent,
  extractFollowData,
  extractLikeData,
  extractAnnounceData,
  extractDeleteData,
  normalizeActor,
} from './converters/fromActivityPub.js';

export class ActivityProcessor {
  /**
   * Process incoming ActivityPub activity
   */
  static async processIncomingActivity(activity: any): Promise<void> {
    switch (activity.type) {
      case 'Follow':
        await this.processFollow(activity);
        break;
      case 'Accept':
        await this.processAccept(activity);
        break;
      case 'Reject':
        await this.processReject(activity);
        break;
      case 'Create':
        await this.processCreate(activity);
        break;
      case 'Update':
        await this.processUpdate(activity);
        break;
      case 'Delete':
        await this.processDelete(activity);
        break;
      case 'Like':
      case 'EmojiReaction':
        await this.processLike(activity);
        break;
      case 'Announce':
        await this.processAnnounce(activity);
        break;
      case 'Undo':
        await this.processUndo(activity);
        break;
      default:
        logger.info(`Unhandled activity type: ${activity.type}`);
    }
  }

  /**
   * Process Follow activity
   */
  private static async processFollow(activity: any): Promise<void> {
    const { followerUrl, followingUrl } = extractFollowData(activity);
    const supabase = getSupabaseClient();

    // Ensure remote user exists
    await this.ensureRemoteUser(followerUrl);

    // Get follower and following IDs
    const { data: follower } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', followerUrl)
      .single();

    const { data: following } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', followingUrl)
      .single();

    if (!follower || !following) {
      logger.error('Failed to find users for follow relationship');
      return;
    }

    // Create follow relationship (auto-accept)
    await supabase.from('follows').upsert({
      follower_id: follower.id,
      following_id: following.id,
      status: 'accepted',
      ap_activity_id: activity.id,
    });

    logger.info(`Follow created and auto-accepted: ${followerUrl} → ${followingUrl}`);

    // Send Accept activity back to follower
    const { data: followingUser } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', following.id)
      .single();
    
    if (followingUser && followingUser.is_local) {
      const { createAcceptActivity } = await import('./converters/toActivityPub.js');
      const { DeliveryQueue } = await import('./DeliveryQueue.js');
      
      const acceptActivity = createAcceptActivity(followingUser, activity);
      
      // Get follower's inbox
      const { data: followerUser } = await supabase
        .from('profiles')
        .select('inbox_url')
        .eq('id', follower.id)
        .single();
      
      if (followerUser?.inbox_url) {
        await DeliveryQueue.sendToInbox(followerUser.inbox_url, acceptActivity, followingUser.id);
        logger.info(`✅ Sent Accept activity to ${followerUrl}`);
      }
    }
  }

  /**
   * Process Accept activity
   */
  private static async processAccept(activity: any): Promise<void> {
    const supabase = getSupabaseClient();

    // Update follow status to accepted
    if (activity.object && activity.object.type === 'Follow') {
      await supabase
        .from('follows')
        .update({ status: 'accepted' })
        .eq('ap_activity_id', activity.object.id);

      logger.info(`Follow accepted: ${activity.object.id}`);
    }
  }

  /**
   * Process Reject activity
   */
  private static async processReject(activity: any): Promise<void> {
    const supabase = getSupabaseClient();

    // Update follow status to rejected or delete
    if (activity.object && activity.object.type === 'Follow') {
      await supabase
        .from('follows')
        .delete()
        .eq('ap_activity_id', activity.object.id);

      logger.info(`Follow rejected: ${activity.object.id}`);
    }
  }

  /**
   * Process Create activity (new post/message)
   */
  private static async processCreate(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();

    if (object.type === 'Note' || object.type === 'Article') {
      // Ensure author exists
      await this.ensureRemoteUser(normalizeActor(activity.actor));

      // Get author ID
      const { data: author } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', normalizeActor(activity.actor))
        .single();

      if (!author) {
        logger.error('Failed to find author for post');
        return;
      }

      // Convert content (returns raw HTML for now)
      const rawContent = noteToContent(object);
      
      // Debug: Log what we're getting from Misskey/Mastodon
      logger.info('📝 Raw content from ActivityPub Note: ' + JSON.stringify({
        contentType: typeof object.content,
        contentPreview: object.content?.substring(0, 200),
        hasContent: !!object.content,
        rawContentParts: rawContent.length,
        rawContentSample: rawContent[0]
      }));
      
      // Parse ActivityPub HTML to MessageParts if needed
      // Note: This parsing should ideally happen in the backend, but for now
      // we're storing raw HTML and letting frontend parse it
      const content = rawContent;

      // Determine visibility
      const visibility = this.determineVisibility(object);

      // Debug logging
      logger.info(`📬 Processing incoming Note: ` + JSON.stringify({
        id: object.id,
        to: object.to,
        cc: object.cc,
        determined_visibility: visibility,
        has_mentions: object.tag?.some((t: any) => t.type === 'Mention')
      }));

      // Create post
      const { error } = await supabase.from('posts').upsert({
        ap_id: object.id,
        author_id: author.id,
        content,
        visibility,
        is_local: false,
        in_reply_to: object.inReplyTo,
        created_at: object.published || new Date().toISOString(),
      });

      if (error) {
        logger.error('Failed to create post from activity:', error);
      } else {
        logger.info(`Created post from ${object.id}`);
      }
    }
  }

  /**
   * Process Update activity (profile update, post edit)
   */
  private static async processUpdate(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();

    if (object.type === 'Person') {
      // Update user profile
      const profileData = actorToProfile(object);

      await supabase
        .from('profiles')
        .update({
          display_name: profileData.display_name,
          bio: profileData.bio,
          avatar: profileData.avatar,
          banner: profileData.banner,
          public_key: profileData.public_key,
        })
        .eq('federated_id', object.id);

      logger.info(`Updated profile: ${object.id}`);
    }
    // TODO: Handle post edits
  }

  /**
   * Process Delete activity
   */
  private static async processDelete(activity: any): Promise<void> {
    const { objectUrl } = extractDeleteData(activity);
    const supabase = getSupabaseClient();

    // Try to delete post
    await supabase
      .from('posts')
      .delete()
      .eq('federated_id', objectUrl);

    // Try to delete message
    await supabase
      .from('messages')
      .update({ is_deleted: true })
      .eq('federated_id', objectUrl);

    logger.info(`Deleted object: ${objectUrl}`);
  }

  /**
   * Process Like activity (including emoji reactions)
   */
  private static async processLike(activity: any): Promise<void> {
    const { actorUrl, objectUrl, emoji } = extractLikeData(activity);
    const supabase = getSupabaseClient();

    // Ensure user exists
    await this.ensureRemoteUser(actorUrl);

    // Get user ID
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!user) {
      logger.error('Failed to find user for like');
      return;
    }

    // Find target post
    const { data: post } = await supabase
      .from('posts')
      .select('id')
      .eq('ap_id', objectUrl)
      .single();

    if (post) {
      // Add reaction/like to post using post_interactions table
      await supabase.from('post_interactions').upsert({
        post_id: post.id,
        user_id: user.id,
        interaction_type: 'emoji_reaction',
        emoji_id: null, // Will use custom_emoji_content for remote emojis
        custom_emoji_content: emoji || '❤️',
      }, {
        onConflict: 'post_id,user_id,interaction_type'
      });

      logger.info(`Added reaction to post ${post.id}: ${emoji || '❤️'}`);
    } else {
      logger.warn(`Post not found for like: ${objectUrl}`);
    }
  }

  /**
   * Process Announce activity (reblog/boost)
   */
  private static async processAnnounce(activity: any): Promise<void> {
    const { actorUrl, objectUrl } = extractAnnounceData(activity);
    const supabase = getSupabaseClient();

    // Ensure user exists
    await this.ensureRemoteUser(actorUrl);

    // Get user ID
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!user) {
      logger.error('Failed to find user for announce');
      return;
    }

    // Find original post
    const { data: originalPost } = await supabase
      .from('posts')
      .select('id')
      .eq('federated_id', objectUrl)
      .single();

    if (originalPost) {
      // Create reblog post
      await supabase.from('posts').insert({
        author_id: user.id,
        reblog_of: originalPost.id,
        is_local: false,
        visibility: 'public',
        content: [],
        created_at: activity.published || new Date().toISOString(),
      });

      logger.info(`Created reblog of ${originalPost.id}`);
    }
  }

  /**
   * Process Undo activity
   */
  private static async processUndo(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();

    if (!object) return;

    switch (object.type) {
      case 'Follow':
        // Remove follow
        const { followerUrl, followingUrl } = extractFollowData(object);
        const { data: follower } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', followerUrl)
          .single();

        const { data: following } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', followingUrl)
          .single();

        if (follower && following) {
          await supabase
            .from('follows')
            .delete()
            .eq('follower_id', follower.id)
            .eq('following_id', following.id);

          logger.info(`Undid follow: ${followerUrl} → ${followingUrl}`);
        }
        break;

      case 'Like':
        // Remove reaction
        const { actorUrl, objectUrl } = extractLikeData(object);
        const { data: user } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', actorUrl)
          .single();

        const { data: post } = await supabase
          .from('posts')
          .select('id')
          .eq('federated_id', objectUrl)
          .single();

        if (user && post) {
          await supabase
            .from('post_reactions')
            .delete()
            .eq('user_id', user.id)
            .eq('post_id', post.id);

          logger.info(`Undid reaction on ${objectUrl}`);
        }
        break;

      case 'Announce':
        // Remove reblog
        await supabase
          .from('posts')
          .delete()
          .eq('federated_id', object.id);

        logger.info(`Undid announce: ${object.id}`);
        break;
    }
  }

  /**
   * Ensure remote user exists in database (fetch if needed)
   */
  private static async ensureRemoteUser(actorUrl: string): Promise<void> {
    const supabase = getSupabaseClient();

    // Check if user already exists
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (existing) {
      return; // User already exists
    }

    // Fetch actor from remote server
    try {
      const response = await fetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      if (!response.ok) {
        logger.error(`Failed to fetch actor ${actorUrl}: ${response.status}`);
        return;
      }

      const actor = await response.json();
      const profileData = actorToProfile(actor);

      // Insert remote user
      await supabase.from('profiles').insert(profileData);

      logger.info(`Created remote user: ${actorUrl}`);
    } catch (error) {
      logger.error(`Error fetching remote actor ${actorUrl}:`, error);
    }
  }

  /**
   * Determine post visibility from ActivityPub 'to' and 'cc' fields
   */
  private static determineVisibility(object: any): string {
    const to = Array.isArray(object.to) ? object.to : [object.to].filter(Boolean);
    const cc = Array.isArray(object.cc) ? object.cc : [object.cc].filter(Boolean);

    const publicUrl = 'https://www.w3.org/ns/activitystreams#Public';

    // Public: has Public in 'to'
    if (to.includes(publicUrl)) {
      return 'public';
    }
    
    // Unlisted: has Public in 'cc' but not 'to'
    if (cc.includes(publicUrl)) {
      return 'unlisted';
    }
    
    // Direct message: addressed to specific users only (no Public, no followers collection)
    // Check if all recipients are individual user URLs (not collections)
    const allRecipients = [...to, ...cc];
    const hasFollowersCollection = allRecipients.some(url => 
      typeof url === 'string' && url.includes('/followers')
    );
    
    if (!hasFollowersCollection && allRecipients.length > 0) {
      // Only specific users mentioned, no followers collection = direct message
      return 'direct';
    }
    
    // Followers-only: has followers collection but no Public
    if (hasFollowersCollection) {
      return 'followers';
    }
    
    // Default to unlisted if we can't determine
    return 'unlisted';
  }
}

