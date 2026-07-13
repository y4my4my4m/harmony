/**
 * Channel Message Federation Job Handlers
 * 
 * Processes channel message jobs:
 * - federate-channel-message (create)
 * - federate-channel-message-edit (update)
 * - federate-channel-message-delete (delete)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { handleNewChannelMessage, enrichMessageLinkPreviews } from '../../listeners/DatabaseListener.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleChannelMessageJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, message_id } = data;

  logger.info(`📨 Processing channel message job: ${type} for message ${message_id}`);

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

    await handleNewChannelMessage(message);

    // Check what the inner handler set - it may have skipped federation
    const { data: updated } = await supabase
      .from('messages')
      .select('federation_status')
      .eq('id', message_id)
      .single();

    const status = updated?.federation_status || 'completed';
    if (status !== 'completed') {
      await updateFederationStatus(message_id, 'messages', status);
      logger.info(`⏭️ Channel message ${message_id} federation skipped (${status})`);
    } else {
      await updateFederationStatus(message_id, 'messages', 'completed');
      logger.info(`✅ Channel message ${message_id} federated successfully`);
    }

  } catch (error) {
    logger.error(`Failed to federate channel message ${message_id}:`, error);
    await updateFederationStatus(message_id, 'messages', 'failed');
    throw error;
  }
}

export async function handleChannelMessageEditJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { message_id } = data;

  logger.info(`✏️ Processing channel message edit job for message ${message_id}`);

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

    await updateFederationStatus(message_id, 'messages', 'processing');

    const { handleChannelMessageUpdate } = await import('../../listeners/ChannelMessageHandler.js');
    
    const { data: channel } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('id', message.channel_id)
      .single();

    if (channel) {
      await handleChannelMessageUpdate({
        message_id: message.id,
        channel_id: channel.id,
        server_id: channel.server_id,
      });
    }

    await updateFederationStatus(message_id, 'messages', 'completed');
    logger.info(`✅ Channel message edit ${message_id} federated successfully`);

  } catch (error) {
    logger.error(`Failed to federate channel message edit ${message_id}:`, error);
    await updateFederationStatus(message_id, 'messages', 'failed');
    throw error;
  }
}

export async function handleChannelMessageDeleteJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { message_id, channel_id, ap_id } = data;

  logger.info(`🗑️ Processing channel message delete job for message ${message_id}`);

  try {
    await updateFederationStatus(message_id, 'messages', 'processing');

    const { handleChannelMessageDelete } = await import('../../listeners/ChannelMessageHandler.js');
    
    // Get channel info (message might be soft-deleted so use the passed channel_id)
    const { data: channel } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('id', channel_id)
      .single();

    if (channel) {
      await handleChannelMessageDelete({
        message_id,
        channel_id: channel.id,
        server_id: channel.server_id,
        ap_id,
      });
    }

    await updateFederationStatus(message_id, 'messages', 'completed');
    logger.info(`✅ Channel message delete ${message_id} federated successfully`);

  } catch (error) {
    logger.error(`Failed to federate channel message delete ${message_id}:`, error);
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

