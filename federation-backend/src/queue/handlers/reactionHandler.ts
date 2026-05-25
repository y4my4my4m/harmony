/**
 * Reaction Federation Job Handler
 * 
 * Processes federate-reaction jobs (post reactions/favorites/reblogs)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { createLikeActivity } from '../../activitypub/converters/toActivityPub.js';
import { createUndoLikeActivity } from '../../listeners/FederationHandlers.js';
import { resolveOutboundEmoji } from '../../utils/emojiResolvers.js';
import config from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleReactionJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, interaction_id, interaction_type, post_id, user_id, emoji_id, custom_emoji_content } = data;

  logger.info(`❤️ Processing reaction job: ${type} for interaction ${interaction_id}`);

  if (interaction_type === 'bookmark') {
    logger.info(`⏭️ Bookmarks are private, skipping federation for ${interaction_id}`);
    await updateFederationStatus(interaction_id, 'post_interactions', 'skipped');
    return;
  }

  try {
    const { data: post } = await supabase
      .from('posts')
      .select('id, author_id, ap_id, is_local')
      .eq('id', post_id)
      .single();

    if (!post) {
      logger.info(`⏭️ Reaction on missing post (post_id=${post_id}), skipping federation`);
      await updateFederationStatus(interaction_id, 'post_interactions', 'skipped');
      return;
    }

    // For local posts that were federated but never had ap_id persisted, construct it
    if (!post.ap_id) {
      if (post.is_local !== false) {
        post.ap_id = `https://${config.INSTANCE_DOMAIN}/posts/${post.id}`;
        logger.info(`🔧 Constructed ap_id for local post: ${post.ap_id}`);
        // Persist it for future lookups
        await supabase.from('posts').update({ ap_id: post.ap_id }).eq('id', post.id);
      } else {
        logger.info(`⏭️ Remote post without ap_id (post_id=${post_id}), skipping federation`);
        await updateFederationStatus(interaction_id, 'post_interactions', 'skipped');
        return;
      }
    }

    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user_id)
      .single();

    if (!user || !user.is_local) {
      logger.info(`⏭️ Reaction from remote/missing user (user_id=${user_id}, found=${!!user}, is_local=${user?.is_local}), skipping`);
      await updateFederationStatus(interaction_id, 'post_interactions', 'skipped');
      return;
    }

    await updateFederationStatus(interaction_id, 'post_interactions', 'processing');

    const { data: postAuthor } = await supabase
      .from('profiles')
      .select('inbox_url, is_local, federated_id, username, domain')
      .eq('id', post.author_id)
      .single();

    if (!postAuthor) {
      logger.info(`⏭️ Post author not found (author_id=${post.author_id}), skipping federation`);
      await updateFederationStatus(interaction_id, 'post_interactions', 'skipped');
      return;
    }

    logger.info(`📋 Reaction context: post.ap_id=${post.ap_id}, postAuthor.is_local=${postAuthor.is_local}, emoji_id=${emoji_id}, custom_emoji_content=${custom_emoji_content}`);

    if (type === 'create') {
      const targetDomain = postAuthor.is_local ? undefined : (postAuthor.domain || undefined);
      const { content, emojiData } = await resolveOutboundEmoji(emoji_id, custom_emoji_content, targetDomain);
      logger.info(`🎯 Resolved emoji: content="${content}", hasEmojiData=${!!emojiData}, emojiUrl=${emojiData?.url ?? 'none'}`);

      if (!postAuthor.is_local && postAuthor.inbox_url) {
        const authorUrl = postAuthor.federated_id
          || `https://${postAuthor.domain}/users/${postAuthor.username}`;
        const activity = createLikeActivity(user, post.ap_id, content, emojiData ?? undefined, [authorUrl]);
        logger.info(`📦 Like activity payload: ${JSON.stringify({ content: activity.content, _misskey_reaction: activity._misskey_reaction, tag: activity.tag })}`);
        await DeliveryQueue.sendToInbox(postAuthor.inbox_url, activity, user.id);
        logger.info(`✅ Reaction federated to post author ${postAuthor.inbox_url}`);
      }

      const activity = createLikeActivity(user, post.ap_id, content, emojiData ?? undefined);
      logger.info(`📦 Broadcast Like payload: ${JSON.stringify({ content: activity.content, _misskey_reaction: activity._misskey_reaction, tag: activity.tag })}`);
      await DeliveryQueue.broadcastToFollowers(post.author_id, activity);
      logger.info(`✅ Reaction broadcast to post author's remote followers`);
      await updateFederationStatus(interaction_id, 'post_interactions', 'completed');
    } else if (type === 'delete') {
      const undoActivity = createUndoLikeActivity(user, post.ap_id);

      if (!postAuthor.is_local && postAuthor.inbox_url) {
        await DeliveryQueue.sendToInbox(postAuthor.inbox_url, undoActivity, user.id);
        logger.info(`✅ Undo reaction queued for delivery to ${postAuthor.inbox_url}`);
      }

      await DeliveryQueue.broadcastToFollowers(post.author_id, undoActivity);
      logger.info(`✅ Undo reaction broadcast to post author's remote followers`);
      await updateFederationStatus(interaction_id, 'post_interactions', 'completed');
    } else {
      logger.warn(`Unknown reaction job type: ${type}`);
      await updateFederationStatus(interaction_id, 'post_interactions', 'failed');
    }

  } catch (error) {
    logger.error(`Failed to federate reaction ${interaction_id}:`, error);
    await updateFederationStatus(interaction_id, 'post_interactions', 'failed');
    throw error;
  }
}

async function updateFederationStatus(
  id: string,
  table: string,
  status: string
): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from(table).update({ federation_status: status }).eq('id', id);
}

