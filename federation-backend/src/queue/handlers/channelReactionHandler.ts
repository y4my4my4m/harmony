/**
 * Channel Reaction Federation Job Handler
 * 
 * Processes federate-channel-reaction jobs (reactions on server channel messages)
 * Handles both 'create' (Like/EmojiReaction) and 'delete' (Undo) operations
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { handleChannelReactionFederation, handleChannelReactionRemoval } from '../../listeners/ChannelReactionHandler.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleChannelReactionJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, reaction_id, message_id, user_id, emoji_id, custom_emoji_content } = data;

  logger.info(`💬⭐ Processing channel reaction job: ${type} for reaction ${reaction_id || 'deleted'}`);

  try {
    // Handle delete (Undo) operations
    if (type === 'delete') {
      logger.info(`↩️ Processing reaction removal for message ${message_id}`);
      
      await handleChannelReactionRemoval({
        message_id,
        user_id,
        emoji_id,
      });
      
      logger.info(`✅ Channel reaction removal federated successfully`);
      return;
    }

    // Handle create operations
    // Get reaction
    const { data: reaction } = await supabase
      .from('reactions')
      .select('*')
      .eq('id', reaction_id)
      .single();

    if (!reaction) {
      logger.error(`Reaction not found: ${reaction_id}`);
      await updateFederationStatus(reaction_id, 'reactions', 'failed');
      return;
    }

    // Check if already federated
    if (reaction.metadata?.federated) {
      logger.debug(`Reaction ${reaction_id} already federated, skipping`);
      await updateFederationStatus(reaction_id, 'reactions', 'skipped');
      return;
    }

    await updateFederationStatus(reaction_id, 'reactions', 'processing');

    // Use the existing handleChannelReactionFederation function
    await handleChannelReactionFederation({
      reaction_id: reaction.id,
      message_id: reaction.message_id,
      user_id: reaction.user_id,
      emoji_id: reaction.emoji_id,
    });

    await updateFederationStatus(reaction_id, 'reactions', 'completed');
    logger.info(`✅ Channel reaction ${reaction_id} federated successfully`);

  } catch (error) {
    logger.error(`Failed to federate channel reaction ${reaction_id}:`, error);
    if (reaction_id) {
      await updateFederationStatus(reaction_id, 'reactions', 'failed');
    }
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

