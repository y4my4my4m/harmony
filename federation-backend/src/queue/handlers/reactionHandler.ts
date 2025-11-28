/**
 * Reaction Federation Job Handler
 * 
 * Processes federate-reaction jobs (post reactions/favorites/reblogs)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { createLikeActivity, createUndoLikeActivity } from '../../listeners/FederationHandlers.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../QueueManager.js';

export async function handleReactionJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, interaction_id, interaction_type, post_id, user_id, emoji_id, custom_emoji_content } = data;

  logger.info(`❤️ Processing reaction job: ${type} for interaction ${interaction_id}`);

  try {
    // Get the post
    const { data: post } = await supabase
      .from('posts')
      .select('id, author_id, ap_id')
      .eq('id', post_id)
      .single();

    if (!post || !post.ap_id) {
      logger.debug('Reaction on post without ap_id, skipping federation');
      await updateFederationStatus(interaction_id, 'post_interactions', 'skipped');
      return;
    }

    // Get user who reacted
    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user_id)
      .single();

    if (!user || !user.is_local) {
      logger.debug('Reaction from remote user, skipping');
      await updateFederationStatus(interaction_id, 'post_interactions', 'skipped');
      return;
    }

    await updateFederationStatus(interaction_id, 'post_interactions', 'processing');

    // Get emoji data if custom emoji
    let emojiContent = custom_emoji_content;
    let emojiData = null;

    if (emoji_id) {
      const { data: emoji } = await supabase
        .from('emojis')
        .select('name, url')
        .eq('id', emoji_id)
        .single();

      if (emoji) {
        emojiData = emoji;
        emojiContent = `:${emoji.name}:`;
      }
    }

    // Get post author's inbox for delivery
    const { data: postAuthor } = await supabase
      .from('profiles')
      .select('inbox_url, is_local')
      .eq('id', post.author_id)
      .single();

    if (!postAuthor || postAuthor.is_local || !postAuthor.inbox_url) {
      logger.debug('Post author is local or has no inbox, skipping federation');
      await updateFederationStatus(interaction_id, 'post_interactions', 'skipped');
      return;
    }

    if (type === 'create') {
      // Create Like activity
      const activity = await createLikeActivity(user, post.ap_id, emojiContent, emojiData);
      await DeliveryQueue.sendToInbox(postAuthor.inbox_url, activity, user.id);
      logger.info(`✅ Reaction queued for delivery to ${postAuthor.inbox_url}`);
      await updateFederationStatus(interaction_id, 'post_interactions', 'completed');
      
    } else if (type === 'delete') {
      // Create Undo Like activity
      const undoActivity = createUndoLikeActivity(user, post.ap_id);
      await DeliveryQueue.sendToInbox(postAuthor.inbox_url, undoActivity, user.id);
      logger.info(`✅ Undo reaction queued for delivery to ${postAuthor.inbox_url}`);
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

