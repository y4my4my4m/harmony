/**
 * Channel Message Federation Job Handler
 * 
 * Processes federate-channel-message jobs (server channel messages)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { handleNewChannelMessage } from '../../listeners/DatabaseListener.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../QueueManager.js';

export async function handleChannelMessageJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, message_id, channel_id, user_id } = data;

  logger.info(`📨 Processing channel message job: ${type} for message ${message_id}`);

  try {
    // Get message
    const { data: message } = await supabase
      .from('messages')
      .select('*')
      .eq('id', message_id)
      .single();

    if (!message) {
      logger.error(`Message not found: ${message_id}`);
      await updateFederationStatus(message_id, 'messages', 'failed');
      return;
    }

    // Check if already federated
    if (message.metadata?.federated) {
      logger.debug(`Message ${message_id} already federated, skipping`);
      await updateFederationStatus(message_id, 'messages', 'skipped');
      return;
    }

    await updateFederationStatus(message_id, 'messages', 'processing');

    // Use the existing handleNewChannelMessage function from DatabaseListener
    // It handles federation to remote server members
    await handleNewChannelMessage(message);

    await updateFederationStatus(message_id, 'messages', 'completed');
    logger.info(`✅ Channel message ${message_id} federated successfully`);

  } catch (error) {
    logger.error(`Failed to federate channel message ${message_id}:`, error);
    await updateFederationStatus(message_id, 'messages', 'failed');
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

