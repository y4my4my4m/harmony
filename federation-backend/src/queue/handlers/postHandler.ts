/**
 * Post Federation Job Handler
 * 
 * Processes federate-post jobs from the queue.
 * Handles post creation, updates, deletions, and pin changes.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { createPostActivity, createDeleteActivity, createPostUpdateActivity, createAddToFeaturedActivity, createRemoveFromFeaturedActivity } from '../../listeners/FederationHandlers.js';
import config from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

/**
 * Handle a post federation job
 */
export async function handlePostJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, post_id, author_id, visibility } = data;

  logger.info(`📝 Processing post job: ${type} for post ${post_id}`);

  try {
    // Fetch full post data
    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('*')
      .eq('id', post_id)
      .single();

    if (postError || !post) {
      logger.error(`Post not found: ${post_id}`);
      await updateFederationStatus(post_id, 'posts', 'failed');
      return;
    }

    // Fetch author profile
    const { data: author, error: authorError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', author_id)
      .single();

    if (authorError || !author) {
      logger.error(`Author not found: ${author_id}`);
      await updateFederationStatus(post_id, 'posts', 'failed');
      return;
    }

    // Update status to processing
    await updateFederationStatus(post_id, 'posts', 'processing');

    let activity;

    switch (type) {
      case 'create':
        // Create activity for new post
        activity = await createPostActivity(post, author);
        
        // Persist ap_id so reaction/reply handlers can find it
        if (!post.ap_id) {
          const apId = `https://${config.INSTANCE_DOMAIN}/posts/${post.id}`;
          await supabase
            .from('posts')
            .update({ ap_id: apId })
            .eq('id', post.id);
          logger.info(`📌 Set ap_id for post ${post.id}: ${apId}`);
        }

        if (post.visibility === 'direct') {
          const mentions = Array.isArray(post.content)
            ? post.content.filter((part: any) => part.type === 'mention' && !part.isLocal && part.domain)
            : [];

          if (mentions.length === 0) {
            logger.warn(`📧 Direct post ${post.id} has no remote recipients - cannot federate`);
            await updateFederationStatus(post_id, 'posts', 'failed');
            throw new Error(`Direct post ${post_id} has no remote mention recipients - nothing to deliver`);
          }

          await deliverToMentionedUsers(post, activity, author, supabase);
          logger.info(`📧 Direct post ${post.id} delivered to ${mentions.length} mentioned user(s)`);
        } else {
          // Public/unlisted/followers: broadcast to followers
          await DeliveryQueue.broadcastToFollowers(author.id, activity);
          
          // Also deliver to mentioned users who might not be followers
          if (Array.isArray(post.content)) {
            await deliverToMentionedUsers(post, activity, author, supabase);
          }
        }
        break;

      case 'update':
        // Create Update activity for edited post
        activity = await createPostUpdateActivity(post, author);
        
        // Broadcast update to followers
        await DeliveryQueue.broadcastToFollowers(author.id, activity);
        break;

      case 'delete':
        // Create Delete activity
        activity = await createDeleteActivity(post, author);
        
        // Broadcast deletion to followers
        await DeliveryQueue.broadcastToFollowers(author.id, activity);
        break;

      case 'pin_change':
        if (post.is_pinned) {
          activity = createAddToFeaturedActivity(author, post);
        } else {
          activity = createRemoveFromFeaturedActivity(author, post);
        }
        await DeliveryQueue.broadcastToFollowers(author.id, activity);
        logger.info(`📌 Post ${post_id} ${post.is_pinned ? 'pinned' : 'unpinned'} - Add/Remove activity sent`);
        break;

      default:
        logger.warn(`Unknown post job type: ${type}`);
        await updateFederationStatus(post_id, 'posts', 'failed');
        return;
    }

    // Mark as completed
    await updateFederationStatus(post_id, 'posts', 'completed');
    logger.info(`✅ Post ${post_id} federated successfully`);

  } catch (error) {
    logger.error(`Failed to federate post ${post_id}:`, error);
    await updateFederationStatus(post_id, 'posts', 'failed');
    throw error; // Re-throw for BullMQ retry
  }
}

/**
 * Deliver post to mentioned users who might not be followers
 */
async function deliverToMentionedUsers(
  post: any,
  activity: any,
  author: any,
  supabase: any
): Promise<void> {
  const mentions = post.content.filter((part: any) => part.type === 'mention');

  for (const mention of mentions) {
    if (!mention.isLocal && mention.domain) {
      // Get mentioned user's inbox
      const { data: mentionedUser } = await supabase
        .from('profiles')
        .select('inbox_url')
        .eq('username', mention.username)
        .eq('domain', mention.domain)
        .single();

      if (mentionedUser?.inbox_url) {
        logger.info(`📧 Delivering to mentioned user: ${mention.username}@${mention.domain}`);
        await DeliveryQueue.sendToInbox(mentionedUser.inbox_url, activity, author.id);
      }
    }
  }
}

/**
 * Update federation status in database
 */
async function updateFederationStatus(
  id: string,
  table: string,
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'skipped'
): Promise<void> {
  const supabase = getSupabaseClient();
  
  await supabase
    .from(table)
    .update({ federation_status: status })
    .eq('id', id);
}

