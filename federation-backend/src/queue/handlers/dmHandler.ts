/**
 * DM Federation Job Handler
 * 
 * Processes federate-dm jobs (direct messages to remote users)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { handleNewDM, enrichMessageLinkPreviews } from '../../listeners/DatabaseListener.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleDMJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, message_id } = data;

  logger.info(`💬 Processing DM job: ${type} for message ${message_id}`);

  try {
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

    if (message.is_system) {
      logger.debug(`Skipping federation for system message: ${message_id}`);
      await updateFederationStatus(message_id, 'messages', 'skipped');
      return;
    }

    // Enrich before the federated-check below, since bridged (Discord) messages also match it.
    try {
      await enrichMessageLinkPreviews(message);
    } catch (err) {
      logger.warn(`Link preview enrichment failed for ${message_id}:`, err);
    }

    if (message.metadata?.federated) {
      logger.debug(`Message ${message_id} already federated, skipping`);
      await updateFederationStatus(message_id, 'messages', 'skipped');
      return;
    }

    await updateFederationStatus(message_id, 'messages', 'processing');

    await handleNewDM(message);

    await updateFederationStatus(message_id, 'messages', 'completed');
    logger.info(`✅ DM ${message_id} federated successfully`);

  } catch (error) {
    logger.error(`Failed to federate DM ${message_id}:`, error);
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

