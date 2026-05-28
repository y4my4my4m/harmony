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

        // Out-of-band enrichment + home-feed realtime push. These used to
        // live in `DatabaseListener.handleNewPost` (postgres_changes path)
        // which fires unreliably and on a single Supabase channel; running
        // them here means every successful BullMQ post job also gets the
        // link card and the home-timeline broadcast. We `Promise.allSettled`
        // so a slow LinkPreview HTTP fetch can't gate the realtime push and
        // a failed broadcast can't poison the (already-completed) federation
        // status.
        {
          // Pure reblogs (Announce, no quote) reference another post's
          // content and don't carry their own URL preview semantics — skip
          // them for link enrichment but still broadcast so the reblog
          // appears on followers' home timelines.
          const isQuotePost = post.metadata?.is_quote && post.metadata?.reblog_of;
          const isPureReblog = !isQuotePost && (post.ap_type === 'Announce' || post.metadata?.reblog_of);

          await Promise.allSettled([
            isPureReblog
              ? Promise.resolve()
              : enrichPostLinkPreviews(post).catch((err) =>
                  logger.warn(`Link preview enrichment failed for local post ${post.id}:`, err)
                ),
            broadcastHomeFeed(supabase, post).catch((err) =>
              logger.warn(`Home feed broadcast failed for post ${post.id}:`, err)
            ),
          ]);
        }
        break;

      case 'update':
        // Create Update activity for edited post
        activity = await createPostUpdateActivity(post, author);
        
        // Broadcast update to followers
        await DeliveryQueue.broadcastToFollowers(author.id, activity);

        // Re-enrich link previews on every edit. `enrichPostLinkPreviews`
        // dedupes via the `existingEmbeds[url]` check so re-running on an
        // unchanged URL set is a cheap no-op; this avoids needing the job
        // payload to carry an explicit "content changed" flag.
        try {
          await enrichPostLinkPreviews(post);
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

/**
 * Push a `home_feed:new_post` event to every recipient who should see this
 * post on their home timeline. Runs out-of-band on a BullMQ worker (NOT in
 * the post INSERT transaction) so a large follower fan-out can't slow post
 * commits and a transient realtime/HTTP hiccup can't block the post.
 *
 * Recipients: the author themselves + every accepted local follower of the
 * author (plus pending followers for `public` posts, matching the rules
 * used by `create_comprehensive_timeline_entries`). `direct` / `private`
 * posts never surface on home timelines and are filtered out at the top.
 *
 * Reuses the existing `user:{profile_id}` broadcast topic + `user_event`
 * event name via the `broadcast_user_event(p_user_id, p_payload)` RPC
 * added in `20260528_broadcast_user_event_rpc.sql`, so no new Supabase
 * channel is opened per-user-per-author.
 */
async function broadcastHomeFeed(supabase: any, post: any): Promise<void> {
  if (post.visibility !== 'public' && post.visibility !== 'unlisted' && post.visibility !== 'followers') {
    return;
  }

  // Status filter mirrors `create_comprehensive_timeline_entries()`:
  //   public         → accepted OR pending
  //   unlisted/follo → accepted only
  const followStatusFilter = post.visibility === 'public'
    ? ['accepted', 'pending']
    : ['accepted'];

  const { data: followerRows, error: followerErr } = await supabase
    .from('follows')
    .select('follower_id, profiles!follows_follower_id_fkey(is_local)')
    .eq('following_id', post.author_id)
    .in('status', followStatusFilter);

  if (followerErr) {
    logger.warn(`broadcastHomeFeed: failed to load followers for post ${post.id}:`, followerErr);
    return;
  }

  // Author always gets the broadcast so their own home timeline prepends
  // without a manual refresh (matches Twitter/Mastodon UX).
  const recipients = new Set<string>([post.author_id]);
  for (const row of followerRows ?? []) {
    if (row?.profiles?.is_local) {
      recipients.add(row.follower_id);
    }
  }

  const payload = {
    type: 'home_feed:new_post',
    post_id: post.id,
    author_id: post.author_id,
    created_at: post.created_at,
    visibility: post.visibility,
    source: 'bullmq:postHandler',
  };

  const results = await Promise.allSettled(
    Array.from(recipients).map((uid) =>
      supabase.rpc('broadcast_user_event', { p_user_id: uid, p_payload: payload })
    )
  );

  const failures = results.filter((r) => r.status === 'rejected').length;
  if (failures > 0) {
    logger.warn(`broadcastHomeFeed: ${failures}/${results.length} recipient broadcasts failed for post ${post.id}`);
  } else {
    logger.info(`📡 Home feed broadcast: post ${post.id} pushed to ${results.length} recipient(s)`);
  }
}

