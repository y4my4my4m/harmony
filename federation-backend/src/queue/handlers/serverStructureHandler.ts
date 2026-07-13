/**
 * Server Structure Federation Job Handlers
 * 
 * Handles federation of server structure changes:
 * - Channels (create/update/delete)
 * - Categories (create/update/delete)
 * - Server updates (name, icon, description)
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleChannelCrudJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, channel_id, server_id } = data;

  logger.info(`📢 Processing channel ${type} job for channel ${channel_id}`);

  try {
    const { 
      handleChannelCreated, 
      handleChannelUpdated, 
      handleChannelDeleted 
    } = await import('../../listeners/DatabaseListener.js');

    if (type === 'create') {
      const { data: channel } = await supabase
        .from('channels')
        .select('*')
        .eq('id', channel_id)
        .single();
      
      if (channel && !channel.is_remote) {
        await handleChannelCreated(channel);
        await supabase
          .from('channels')
          .update({ federation_status: 'completed' })
          .eq('id', channel_id);
        logger.info(`✅ Channel create ${channel_id} federated successfully`);
      }
    } else if (type === 'update') {
      const { data: channel } = await supabase
        .from('channels')
        .select('*')
        .eq('id', channel_id)
        .single();
      
      if (channel && !channel.is_remote) {
        // For update, we pass new and old (old is same as new for sweep-based)
        await handleChannelUpdated(channel, channel);
        await supabase
          .from('channels')
          .update({ federation_status: 'completed' })
          .eq('id', channel_id);
        logger.info(`✅ Channel update ${channel_id} federated successfully`);
      }
    } else if (type === 'delete') {
      // For delete, we just need the channel info
      await handleChannelDeleted({ id: channel_id, server_id });
      // No need to update status - channel is deleted
      logger.info(`✅ Channel delete ${channel_id} federated successfully`);
    }

  } catch (error) {
    logger.error(`Failed to federate channel ${type} ${channel_id}:`, error);
    await supabase
      .from('channels')
      .update({ federation_status: 'failed' })
      .eq('id', channel_id);
    throw error;
  }
}

export async function handleCategoryCrudJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { type, category_id, server_id } = data;

  logger.info(`📁 Processing category ${type} job for category ${category_id}`);

  try {
    // Categories are similar to channels - we use the same federation mechanism
    // but with type: 2 (category type)
    const { 
      handleChannelCreated, 
      handleChannelUpdated, 
      handleChannelDeleted 
    } = await import('../../listeners/DatabaseListener.js');

    if (type === 'create') {
      const { data: category } = await supabase
        .from('channel_categories')
        .select('*')
        .eq('id', category_id)
        .single();
      
      if (category) {
        const categoryAsChannel = {
          id: category.id,
          name: category.name,
          server_id: category.server_id,
          type: 2, // Category type
          order: category.order,
          is_remote: false,
        };
        await handleChannelCreated(categoryAsChannel);
        await supabase
          .from('channel_categories')
          .update({ federation_status: 'completed' })
          .eq('id', category_id);
        logger.info(`✅ Category create ${category_id} federated successfully`);
      }
    } else if (type === 'update') {
      const { data: category } = await supabase
        .from('channel_categories')
        .select('*')
        .eq('id', category_id)
        .single();
      
      if (category) {
        const categoryAsChannel = {
          id: category.id,
          name: category.name,
          server_id: category.server_id,
          type: 2,
          order: category.order,
          is_remote: false,
        };
        await handleChannelUpdated(categoryAsChannel, categoryAsChannel);
        await supabase
          .from('channel_categories')
          .update({ federation_status: 'completed' })
          .eq('id', category_id);
        logger.info(`✅ Category update ${category_id} federated successfully`);
      }
    } else if (type === 'delete') {
      // For delete, treat as channel delete with category type
      await handleChannelDeleted({ 
        id: category_id, 
        server_id,
        type: 2,
        is_remote: false,
      });
      // No need to update status - category is deleted
      logger.info(`✅ Category delete ${category_id} federated successfully`);
    }

  } catch (error) {
    logger.error(`Failed to federate category ${type} ${category_id}:`, error);
    await supabase
      .from('channel_categories')
      .update({ federation_status: 'failed' })
      .eq('id', category_id);
    throw error;
  }
}

export async function handleServerUpdateJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { server_id } = data;

  logger.info(`🏠 Processing server update job for server ${server_id}`);

  try {
    const { handleServerUpdated } = await import('../../listeners/DatabaseListener.js');

    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', server_id)
      .single();

    if (server && server.is_local_server && server.federation_enabled) {
      await handleServerUpdated(server, server);
      logger.info(`✅ Server update ${server_id} federated successfully`);
    } else {
      logger.debug(`Server ${server_id} not eligible for federation (local: ${server?.is_local_server}, federation: ${server?.federation_enabled})`);
    }

  } catch (error) {
    logger.error(`Failed to federate server update ${server_id}:`, error);
    throw error;
  }
}

