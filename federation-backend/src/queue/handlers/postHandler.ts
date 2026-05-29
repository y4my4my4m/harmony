/**
 * Post Federation Job Handler
 * 
 * Processes federate-post jobs from the queue.
 * Handles post creation, updates, deletions, and pin changes.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { createPostActivity, createDeleteActivity, createPostUpdateActivity, createAddToFeaturedActivity, createRemoveFromFeaturedActivity } from '../../listeners/FederationHandlers.js';
import { enrichPostLinkPreviews } from '../../listeners/DatabaseListener.js';
import config from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

/**
 * Handle a post federation job
 */
export async function handlePostJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, post_id, author_id } = data;

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
            // A direct post with only local (or no) recipients has nothing to
            // deliver over federation. This is a terminal, expected state - it
            // must NOT throw, or BullMQ retries it ~5x and each failed attempt
            // re-broadcasts post:updated, hammering the author's client.
            logger.info(`📧 Direct post ${post.id} has no remote recipients - skipping federation`);
            await updateFederationStatus(post_id, 'posts', 'skipped');
            return;
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

        // Pure reblogs (Announce, no quote) reuse the original Note's
        // content; nothing to enrich. Home-feed realtime fan-out is handled
        // by the `trg_broadcast_home_feed_entry` DB trigger for all posts.
        {
          const isQuotePost = post.metadata?.is_quote && post.metadata?.reblog_of;
          const isPureReblog = !isQuotePost && (post.ap_type === 'Announce' || post.metadata?.reblog_of);

          if (!isPureReblog) {
            try {
              const wrote = await enrichPostLinkPreviews(post);
              if (wrote) {
                await supabase.rpc('broadcast_user_event', {
                  p_user_id: post.author_id,
                  p_payload: { type: 'post:embeds_ready', post_id: post.id },
                });
              }
            } catch (err) {
              logger.warn(`Link preview enrichment failed for local post ${post.id}:`, err);
            }
          }
        }
        break;

      case 'update':
        activity = await createPostUpdateActivity(post, author);
        await DeliveryQueue.broadcastToFollowers(author.id, activity);

        try {
          const wrote = await enrichPostLinkPreviews(post);
          if (wrote) {
            await supabase.rpc('broadcast_user_event', {
              p_user_id: post.author_id,
              p_payload: { type: 'post:embeds_ready', post_id: post.id },
            });
          }
        } catch (err) {
          logger.warn(`Link preview re-enrichment failed for edited post ${post.id}:`, err);
        }
        break;

      case 'delete':
        // Create Delete activity
        activity = createDeleteActivity(author, post);
        
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

