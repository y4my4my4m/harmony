/**
 * Message Reaction Federation Job Handler
 * 
 * Processes federate-message-reaction jobs (reactions to DM messages)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { handleNewMessageReaction, handleMessageReactionRemoval } from '../../listeners/DatabaseListener.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleMessageReactionJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, reaction_id, message_id, user_id, emoji } = data;

  logger.info(`💬❤️ Processing message reaction job: ${type} for reaction ${reaction_id}`);

  try {
    // Get reaction
    const { data: reaction } = await supabase
      .from('reactions')
      .select('*')
      .eq('id', reaction_id)
      .single();

    if (!reaction && type === 'create') {
      logger.error(`Reaction not found: ${reaction_id}`);
      await updateFederationStatus(reaction_id, 'reactions', 'failed');
      return;
    }

    // Get message
    const { data: message } = await supabase
      .from('messages')
      .select('*, conversation_id')
      .eq('id', message_id)
      .single();

    if (!message || !message.conversation_id) {
      logger.debug('Reaction on non-DM message, skipping');
      await updateFederationStatus(reaction_id, 'reactions', 'skipped');
      return;
    }

    await updateFederationStatus(reaction_id, 'reactions', 'processing');

    if (type === 'create') {
      // Use existing handler
      await handleNewMessageReaction(reaction);
    } else if (type === 'delete') {
      // Create old data structure for the handler
      await handleMessageReactionRemoval({
        id: reaction_id,
        message_id,
        user_id,
        emoji
      });
    }

    await updateFederationStatus(reaction_id, 'reactions', 'completed');
    logger.info(`✅ Message reaction ${reaction_id} federated successfully`);

  } catch (error) {
    logger.error(`Failed to federate message reaction ${reaction_id}:`, error);
    await updateFederationStatus(reaction_id, 'reactions', 'failed');
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

