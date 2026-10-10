/**
 * Post Federation Job Handler
 * 
 * Processes federate-post jobs from the queue.
 * Handles post creation, updates, deletions, and pin changes.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import {
  createPostActivity,
  createDeleteActivity,
  createPostUpdateActivity,
  createAddToFeaturedActivity,
  createRemoveFromFeaturedActivity,
  createReblogActivity,
  createUndoAnnounceActivity,
  loadReblogTarget,
  announceActivityId,
} from '../../listeners/FederationHandlers.js';
import { enrichPostLinkPreviews } from '../../listeners/DatabaseListener.js';
import {
  payloadMentionHandles,
  remoteMentionHandles,
  resolveMentionRecipients,
  withResolvedMentionIds,
  type MentionHandle,
  type MentionRecipient,
} from '../../activitypub/mentionRecipients.js';
import { isBoostPost } from '../../utils/boostPost.js';
import config from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

/**
 * Handle a post federation job
 */
export async function handlePostJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, post_id, author_id } = data;

  logger.info(`Processing post job: ${type} for post ${post_id}`);

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

    // A boost federates as Announce of the original and is retracted by
    // Undo(Announce); it is never a Note of its own.
    if (isBoostPost(post) && (type === 'create' || type === 'delete')) {
      const status = await federateBoost(type, post, author, supabase);
      await updateFederationStatus(post_id, 'posts', status);
      return;
    }

    let activity;

    switch (type) {
      case 'create': {
        const handles = remoteMentionHandles(post.content);
        if (post.visibility === 'direct' && handles.length === 0) {
          // A direct post with only local (or no) recipients has nothing to
          // deliver over federation. This is a terminal, expected state - it
          // must NOT throw, or BullMQ retries it ~5x and each failed attempt
          // re-broadcasts post:updated, hammering the author's client.
          logger.info(`Direct post ${post.id} has no remote recipients - skipping federation`);
          await updateFederationStatus(post_id, 'posts', 'skipped');
          return;
        }

        const recipients = await resolveMentions(post, handles);
        activity = await createPostActivity(post, author);
        
        // Persist ap_id so reaction/reply handlers can find it
        if (!post.ap_id) {
          const apId = `https://${config.INSTANCE_DOMAIN}/posts/${post.id}`;
          await supabase
            .from('posts')
            .update({ ap_id: apId })
            .eq('id', post.id);
          logger.info(`Set ap_id for post ${post.id}: ${apId}`);
        }

        await deliverToAudience(post, activity, author, recipients);
        if (post.visibility === 'direct') {
          logger.info(`Direct post ${post.id} delivered to ${recipients.length} mentioned user(s)`);
        }

        // Home-feed realtime fan-out is handled by the
        // `trg_broadcast_home_feed_entry` DB trigger for all posts.
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
        break;
      }

      case 'update': {
        const recipients = await resolveMentions(post, remoteMentionHandles(post.content));
        activity = await createPostUpdateActivity(post, author);
        await deliverToAudience(post, activity, author, recipients);

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
      }

      case 'delete': {
        activity = createDeleteActivity(author, post);
        // A Delete carries only the object id, so followers receive it for
        // every visibility. Deletion may blank the content before this job
        // runs; the job payload carries the mentions the post held.
        const handles = payloadMentionHandles(data.mentions) ?? remoteMentionHandles(post.content);
        const recipients = await resolveMentionRecipients(handles);
        await DeliveryQueue.broadcastToFollowers(author.id, activity);
        await deliverToMentionedUsers([...recipients.values()], activity, author);
        break;
      }

      case 'pin_change':
        if (post.is_pinned) {
          activity = createAddToFeaturedActivity(author, post);
        } else {
          activity = createRemoveFromFeaturedActivity(author, post);
        }
        await DeliveryQueue.broadcastToFollowers(author.id, activity);
        logger.info(`Post ${post_id} ${post.is_pinned ? 'pinned' : 'unpinned'} - Add/Remove activity sent`);
        break;

      default:
        logger.warn(`Unknown post job type: ${type}`);
        await updateFederationStatus(post_id, 'posts', 'failed');
        return;
    }

    await updateFederationStatus(post_id, 'posts', 'completed');
    logger.info(`Post ${post_id} federated successfully`);

  } catch (error) {
    logger.error(`Failed to federate post ${post_id}:`, error);
    await updateFederationStatus(post_id, 'posts', 'failed');
    throw error; // Re-throw for BullMQ retry
  }
}

/**
 * Announce (create) or Undo(Announce) (delete) of a boost row, to the booster's
 * followers and the original's remote author, one delivery per inbox.
 */
async function federateBoost(
  type: 'create' | 'delete',
  post: any,
  author: any,
  supabase: any,
): Promise<'completed' | 'skipped'> {
  const target = await loadReblogTarget(post);
  if (!target) {
    logger.info(`Boost ${post.id}: original ${post.metadata?.reblog_of} is gone, nothing to federate`);
    return 'skipped';
  }

  if (type === 'create' && !post.ap_id) {
    post.ap_id = announceActivityId(post);
    await supabase.from('posts').update({ ap_id: post.ap_id }).eq('id', post.id);
  }

  const activity = type === 'create'
    ? createReblogActivity(author, post, target)
    : createUndoAnnounceActivity(author, post, target);

  const inboxes = await DeliveryQueue.followerInboxes(author.id);
  if (target.authorInbox && !inboxes.includes(target.authorInbox)) {
    inboxes.push(target.authorInbox);
  }
  await DeliveryQueue.deliverEach(inboxes.map((inbox) => ({ inbox, activity })), author.id);
  logger.info(`Boost ${post.id}: ${activity.type} of ${target.objectUrl} sent to ${inboxes.length} inbox(es)`);
  return 'completed';
}

/**
 * Recipients of the post's remote mentions. The post's mention parts take the
 * resolved profile ids, so the Note's Mention tags carry the stored actor ids.
 */
async function resolveMentions(post: any, handles: MentionHandle[]): Promise<MentionRecipient[]> {
  const recipients = await resolveMentionRecipients(handles);
  post.content = withResolvedMentionIds(post.content, recipients);
  return [...recipients.values()];
}

/**
 * Deliver to the post's audience: followers unless the post is direct, plus
 * every mentioned remote user. A direct post's content never goes to
 * followers' inboxes.
 */
async function deliverToAudience(
  post: any,
  activity: any,
  author: any,
  recipients: MentionRecipient[],
): Promise<void> {
  if (post.visibility !== 'direct') {
    await DeliveryQueue.broadcastToFollowers(author.id, activity);
  }
  await deliverToMentionedUsers(recipients, activity, author);
}

/**
 * Deliver post to mentioned users who might not be followers
 */
async function deliverToMentionedUsers(
  recipients: MentionRecipient[],
  activity: any,
  author: any,
): Promise<void> {
  const inboxes = Array.from(new Set(recipients.map((r) => r.inbox)));
  await Promise.all(inboxes.map(async (inbox) => {
    logger.info(`Delivering to mentioned user inbox: ${inbox}`);
    await DeliveryQueue.sendToInbox(inbox, activity, author.id);
  }));
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
