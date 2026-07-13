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

export async function handlePostJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, post_id, author_id } = data;

  logger.info(`📝 Processing post job: ${type} for post ${post_id}`);

  try {
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

    await updateFederationStatus(post_id, 'posts', 'processing');

    let activity;

    switch (type) {
      case 'create':
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

    await updateFederationStatus(post_id, 'posts', 'completed');
    logger.info(`✅ Post ${post_id} federated successfully`);

  } catch (error) {
    logger.error(`Failed to federate post ${post_id}:`, error);
    await updateFederationStatus(post_id, 'posts', 'failed');
    throw error; // Re-throw for BullMQ retry
  }
}

async function deliverToMentionedUsers(
  post: any,
  activity: any,
  author: any,
  supabase: any
): Promise<void> {
  const remoteMentions = post.content.filter(
    (part: any) => part.type === 'mention' && !part.isLocal && part.domain,
  );
  if (remoteMentions.length === 0) return;

  // One batched lookup instead of a query per mention (N+1), then deliver in
  // parallel - a post mentioning N remote users used to serialize N round-trips.
  const orFilter = remoteMentions
    .map((m: any) => `and(username.eq.${m.username},domain.eq.${m.domain})`)
    .join(',');
  const { data: mentionedUsers } = await supabase
    .from('profiles')
    .select('username, domain, inbox_url')
    .or(orFilter);

  const inboxByHandle = new Map<string, string>();
  for (const u of mentionedUsers || []) {
    if (u.inbox_url) inboxByHandle.set(`${u.username}@${u.domain}`, u.inbox_url);
  }

  await Promise.all(remoteMentions.map(async (mention: any) => {
    const inbox = inboxByHandle.get(`${mention.username}@${mention.domain}`);
    if (!inbox) return;
    logger.info(`📧 Delivering to mentioned user: ${mention.username}@${mention.domain}`);
    await DeliveryQueue.sendToInbox(inbox, activity, author.id);
  }));
}

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

