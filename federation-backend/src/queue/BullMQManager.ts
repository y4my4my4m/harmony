/**
 * BullMQManager - Redis-backed job queue for federation processing
 *
 * DB triggers call queue_federation_job() which uses pg_notify to bridge
 * jobs into BullMQ via NotificationListener.  BullMQ handles retries,
 * backoff, persistence (in Redis), repeatable maintenance jobs, and
 * provides a Bull Board dashboard for monitoring.
 */

import { Queue, Worker, QueueEvents, type ConnectionOptions } from 'bullmq';
import { logger } from '../utils/logger.js';
import { redis } from '../services/RedisService.js';

import { handlePostJob } from './handlers/postHandler.js';
import { handleReactionJob } from './handlers/reactionHandler.js';
import { handleFollowJob } from './handlers/followHandler.js';
import { handleDMJob } from './handlers/dmHandler.js';
import { handleChannelMessageJob, handleChannelMessageEditJob, handleChannelMessageDeleteJob } from './handlers/channelMessageHandler.js';
import { handleChannelReactionJob } from './handlers/channelReactionHandler.js';
import { handleChannelCrudJob, handleCategoryCrudJob, handleServerUpdateJob } from './handlers/serverStructureHandler.js';
import { handleMessageReactionJob } from './handlers/messageReactionHandler.js';
import { handleBlockJob } from './handlers/blockHandler.js';
import { handleReportJob } from './handlers/reportHandler.js';
import { handleProfileJob } from './handlers/profileHandler.js';
import { handleThreadJob } from './handlers/threadHandler.js';
import { handlePushNotificationJob } from './handlers/pushNotificationHandler.js';
import { handleVoiceJoinJob, handleVoiceLeaveJob } from './handlers/voiceHandler.js';
import { handleMaintenanceJob } from './handlers/maintenanceHandler.js';
import { handleGroupInviteJob } from './handlers/groupInviteHandler.js';
import { handleGroupUpdateJob } from './handlers/groupUpdateHandler.js';
import { handleGroupParticipantChangeJob } from './handlers/groupParticipantHandler.js';

export type JobType =
  | 'federate-post'
  | 'federate-reaction'
  | 'federate-follow'
  | 'federate-dm'
  | 'federate-channel-message'
  | 'federate-channel-message-edit'
  | 'federate-channel-message-delete'
  | 'federate-channel-reaction'
  | 'federate-message-reaction'
  | 'federate-channel-crud'
  | 'federate-category-crud'
  | 'federate-server-update'
  | 'federate-block'
  | 'federate-report'
  | 'federate-profile'
  | 'federate-thread'
  | 'federate-voice-join'
  | 'federate-voice-leave'
  | 'federate-group-invite'
  | 'federate-group-update'
  | 'federate-group-participant-change'
  | 'send-push-notification'
  | 'sweep-pending'
  | 'maintenance';

export interface FederationJobData {
  type: 'create' | 'update' | 'delete' | 'pin_change' | 'respond';
  [key: string]: any;
}

const QUEUE_PREFIX = 'harmony';
const CONCURRENCY_PER_QUEUE = 5;

const JOB_TYPES: JobType[] = [
  'federate-post',
  'federate-reaction',
  'federate-follow',
  'federate-dm',
  'federate-channel-message',
  'federate-channel-message-edit',
  'federate-channel-message-delete',
  'federate-channel-reaction',
  'federate-message-reaction',
  'federate-channel-crud',
  'federate-category-crud',
  'federate-server-update',
  'federate-block',
  'federate-report',
  'federate-profile',
  'federate-thread',
  'federate-voice-join',
  'federate-voice-leave',
  'federate-group-invite',
  'federate-group-update',
  'federate-group-participant-change',
  'send-push-notification',
  'maintenance',
];

type HandlerFn = (data: FederationJobData) => Promise<void>;

class BullMQManagerService {
  private queues = new Map<string, Queue>();
  private workers: Worker[] = [];
  private queueEvents: QueueEvents[] = [];
  private isRunning = false;
  private handlerMap = new Map<string, HandlerFn>();
  private sweepIntervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * BullMQ connection options derived from RedisService.
   * BullMQ manages its own ioredis connections internally, so we pass
   * the raw connection config rather than the RedisService client itself.
   */
  private getConnectionOpts(): ConnectionOptions {
    const client = redis.getClient();
    if (!client) {
      throw new Error('Redis must be connected before starting BullMQ');
    }
    const opts = { ...client.options } as ConnectionOptions & { keyPrefix?: string; maxRetriesPerRequest?: number | null };
    delete opts.keyPrefix;
    opts.maxRetriesPerRequest = null;
    return opts;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('BullMQManager already running');
      return;
    }

    logger.info('Starting BullMQManager...');

    const connection = this.getConnectionOpts();

    this.buildHandlerMap();

    for (const jobType of JOB_TYPES) {
      const queue = new Queue(jobType, { connection, prefix: QUEUE_PREFIX });
      this.queues.set(jobType, queue);

      const handler = this.handlerMap.get(jobType);
      if (!handler) continue;

      const worker = new Worker(
        jobType,
        async (job) => {
          logger.info(`Processing ${jobType} job: ${job.id}`);
          try {
            await handler(job.data);
            logger.info(`Completed ${jobType} job: ${job.id}`);
          } catch (err) {
            logger.error(`Failed ${jobType} job: ${job.id}`, err);
            throw err;
          }
        },
        {
          connection,
          prefix: QUEUE_PREFIX,
          concurrency: CONCURRENCY_PER_QUEUE,
          removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
          removeOnFail: { age: 30 * 24 * 3600, count: 5000 },
        },
      );

      worker.on('error', (err) => {
        logger.error(`Worker error [${jobType}]:`, err.message);
      });

      this.workers.push(worker);

      try {
        const qe = new QueueEvents(jobType, { connection, prefix: QUEUE_PREFIX });
        this.queueEvents.push(qe);
      } catch {
        // QueueEvents is optional -- used by Bull Board
      }
    }

    await this.scheduleMaintenanceJobs(connection);

    this.isRunning = true;
    logger.info(`BullMQManager ready (${JOB_TYPES.length} queues, concurrency=${CONCURRENCY_PER_QUEUE})`);
  }

  private buildHandlerMap(): void {
    this.handlerMap.set('federate-post', handlePostJob);
    this.handlerMap.set('federate-reaction', handleReactionJob);
    this.handlerMap.set('federate-follow', handleFollowJob);
    this.handlerMap.set('federate-dm', handleDMJob);
    this.handlerMap.set('federate-channel-message', handleChannelMessageJob);
    this.handlerMap.set('federate-channel-message-edit', handleChannelMessageEditJob);
    this.handlerMap.set('federate-channel-message-delete', handleChannelMessageDeleteJob);
    this.handlerMap.set('federate-channel-reaction', handleChannelReactionJob);
    this.handlerMap.set('federate-message-reaction', handleMessageReactionJob);
    this.handlerMap.set('federate-channel-crud', handleChannelCrudJob);
    this.handlerMap.set('federate-category-crud', handleCategoryCrudJob);
    this.handlerMap.set('federate-server-update', handleServerUpdateJob);
    this.handlerMap.set('federate-block', handleBlockJob);
    this.handlerMap.set('federate-report', handleReportJob);
    this.handlerMap.set('federate-profile', handleProfileJob);
    this.handlerMap.set('federate-thread', handleThreadJob);
    this.handlerMap.set('federate-voice-join', handleVoiceJoinJob);
    this.handlerMap.set('federate-voice-leave', handleVoiceLeaveJob);
    this.handlerMap.set('federate-group-invite', handleGroupInviteJob as unknown as HandlerFn);
    this.handlerMap.set('federate-group-update', handleGroupUpdateJob as unknown as HandlerFn);
    this.handlerMap.set('federate-group-participant-change', handleGroupParticipantChangeJob as unknown as HandlerFn);
    this.handlerMap.set('send-push-notification', handlePushNotificationJob as unknown as HandlerFn);
    this.handlerMap.set('maintenance', handleMaintenanceJob as unknown as HandlerFn);
  }

  private async scheduleMaintenanceJobs(_connection: ConnectionOptions): Promise<void> {
    const maintenanceQueue = this.queues.get('maintenance');
    if (!maintenanceQueue) return;

    try {
      await maintenanceQueue.upsertJobScheduler(
        'keygen-sweep-daily',
        { pattern: '0 3 * * *' },
        {
          name: 'maintenance',
          data: { type: 'create' as const, task: 'keygen-sweep', triggered_by: 'scheduled' },
        },
      );
      logger.info('Scheduled daily keygen-sweep at 03:00 UTC');

      await maintenanceQueue.upsertJobScheduler(
        'cleanup-orphans-daily',
        { pattern: '0 4 * * *' },
        {
          name: 'maintenance',
          data: { type: 'create' as const, task: 'cleanup-orphans', triggered_by: 'scheduled' },
        },
      );
      logger.info('Scheduled daily cleanup-orphans at 04:00 UTC');
    } catch (err) {
      logger.warn('Failed to schedule maintenance jobs:', (err as Error).message);
    }
  }

  // -- Public API ---------------------------------------------------------

  getQueue(name: string): Queue | undefined {
    return this.queues.get(name);
  }

  getAllQueues(): Queue[] {
    return Array.from(this.queues.values());
  }

  async addJob(jobType: JobType | string, data: FederationJobData): Promise<string | undefined> {
    const queue = this.queues.get(jobType);
    if (!queue) {
      logger.warn(`No queue for job type "${jobType}"`);
      return undefined;
    }

    const job = await queue.add(jobType, data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
    });

    logger.debug(`Queued ${jobType} job: ${job.id}`);
    return job.id;
  }

  async getStats(): Promise<Record<string, any>> {
    if (!this.isRunning) return { status: 'not_running' };

    const stats: Record<string, any> = { isRunning: true, queues: {} };

    for (const [name, queue] of this.queues) {
      try {
        const counts = await queue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
        stats.queues[name] = counts;
      } catch {
        stats.queues[name] = { error: 'unavailable' };
      }
    }

    return stats;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('Stopping BullMQManager...');

    if (this.sweepIntervalId) {
      clearInterval(this.sweepIntervalId);
      this.sweepIntervalId = null;
    }

    const closePromises: Promise<void>[] = [];

    for (const w of this.workers) {
      closePromises.push(w.close());
    }
    for (const qe of this.queueEvents) {
      closePromises.push(qe.close());
    }
    for (const q of this.queues.values()) {
      closePromises.push(q.close());
    }

    await Promise.allSettled(closePromises);

    this.workers = [];
    this.queueEvents = [];
    this.queues.clear();
    this.isRunning = false;

    logger.info('BullMQManager stopped');
  }

  // -- Sweep (safety net) -------------------------------------------------

  startPeriodicSweep(): void {
    if (this.sweepIntervalId) return;

    this.sweepIntervalId = setInterval(async () => {
      try {
        await this.sweepPendingItems();
      } catch (err) {
        logger.error('Periodic sweep failed:', err);
      }
    }, 60_000);

    logger.info('Periodic sweep started (60s safety net)');
  }

  async sweepPendingItems(): Promise<void> {
    const { getSupabaseClient } = await import('../config/supabase.js');
    const supabase = getSupabaseClient();
    const twoSecondsAgo = new Date(Date.now() - 2000).toISOString();

    // Sweep posts
    const { data: pendingPosts } = await supabase
      .from('posts')
      .select('id, author_id, visibility')
      .eq('is_local', true)
      .eq('federation_status', 'pending')
      .in('visibility', ['public', 'unlisted'])
      .lt('created_at', twoSecondsAgo)
      .limit(100);

    if (pendingPosts?.length) {
      logger.info(`Sweep found ${pendingPosts.length} pending posts`);
      for (const post of pendingPosts) {
        await this.addJob('federate-post', {
          type: 'create',
          post_id: post.id,
          author_id: post.author_id,
          visibility: post.visibility,
        });
        await supabase.from('posts').update({ federation_status: 'queued' }).eq('id', post.id);
      }
    }

    // Sweep follows. Direction depends on follower locality:
    //   local follower  -> outbound Follow ('create')
    //   remote follower -> Accept/Reject response ('respond', stamped by
    //                      trigger_queue_follow_response_federation)
    // updated_at (not created_at) so respond rows - which are old rows whose
    // status just changed - get the same 2s notify-race guard as fresh inserts.
    const { data: pendingFollows } = await supabase
      .from('follows')
      .select('id, follower_id, following_id, status, ap_id, follower:profiles!follows_follower_id_fkey(is_local)')
      .eq('federation_status', 'pending')
      .lt('updated_at', twoSecondsAgo)
      .limit(100);

    if (pendingFollows?.length) {
      logger.info(`Sweep found ${pendingFollows.length} pending follows`);
      for (const follow of pendingFollows) {
        const followerIsLocal = (follow as any).follower?.is_local === true;

        if (!followerIsLocal && !['accepted', 'rejected'].includes(follow.status)) {
          // Remote follower still awaiting approval - nothing to federate yet.
          await supabase.from('follows').update({ federation_status: 'skipped' }).eq('id', follow.id);
          continue;
        }

        await this.addJob('federate-follow', {
          type: followerIsLocal ? 'create' : 'respond',
          follow_id: follow.id,
          follower_id: follow.follower_id,
          following_id: follow.following_id,
          status: follow.status,
          ap_id: follow.ap_id,
        });
        await supabase.from('follows').update({ federation_status: 'queued' }).eq('id', follow.id);
      }
    }

    // Sweep DM messages
    const { data: pendingDMs } = await supabase
      .from('messages')
      .select('id, conversation_id, user_id')
      .eq('federation_status', 'pending')
      .not('conversation_id', 'is', null)
      .lt('created_at', twoSecondsAgo)
      .limit(100);

    if (pendingDMs?.length) {
      logger.info(`Sweep found ${pendingDMs.length} pending DMs`);
      for (const dm of pendingDMs) {
        await this.addJob('federate-dm', {
          type: 'create',
          message_id: dm.id,
          conversation_id: dm.conversation_id,
          user_id: dm.user_id,
        });
        await supabase.from('messages').update({ federation_status: 'queued' }).eq('id', dm.id);
      }
    }

    // Sweep channel messages (new)
    const { data: pendingChannelMessages } = await supabase
      .from('messages')
      .select('id, channel_id, user_id')
      .eq('federation_status', 'pending')
      .eq('is_deleted', false)
      .not('channel_id', 'is', null)
      .is('conversation_id', null)
      .lt('created_at', twoSecondsAgo)
      .limit(100);

    if (pendingChannelMessages?.length) {
      logger.info(`Sweep found ${pendingChannelMessages.length} pending channel messages`);
      for (const msg of pendingChannelMessages) {
        await this.addJob('federate-channel-message', {
          type: 'create',
          message_id: msg.id,
          channel_id: msg.channel_id,
          user_id: msg.user_id,
        });
        await supabase.from('messages').update({ federation_status: 'queued' }).eq('id', msg.id);
      }
    }

    // Sweep deleted channel messages
    const { data: deletedChannelMessages } = await supabase
      .from('messages')
      .select('id, channel_id, user_id, metadata')
      .eq('federation_status', 'pending')
      .eq('is_deleted', true)
      .not('channel_id', 'is', null)
      .is('conversation_id', null)
      .limit(100);

    if (deletedChannelMessages?.length) {
      logger.info(`Sweep found ${deletedChannelMessages.length} deleted channel messages`);
      for (const msg of deletedChannelMessages) {
        await this.addJob('federate-channel-message-delete', {
          type: 'delete',
          message_id: msg.id,
          channel_id: msg.channel_id,
          user_id: msg.user_id,
          ap_id: (msg as any).metadata?.ap_id,
        });
        await supabase.from('messages').update({ federation_status: 'queued' }).eq('id', msg.id);
      }
    }

    // Sweep channel reactions
    const { data: pendingReactions } = await supabase
      .from('reactions')
      .select(`id, message_id, user_id, emoji_id, custom_emoji_content,
        message:messages!reactions_message_id_fkey(channel_id, conversation_id)`)
      .eq('federation_status', 'pending')
      .lt('created_at', twoSecondsAgo)
      .limit(100);

    if (pendingReactions?.length) {
      const channelReactions = pendingReactions.filter(
        (r: any) => r.message?.channel_id && !r.message?.conversation_id,
      );
      if (channelReactions.length) {
        logger.info(`Sweep found ${channelReactions.length} pending channel reactions`);
        for (const reaction of channelReactions) {
          await this.addJob('federate-channel-reaction', {
            type: 'create',
            reaction_id: reaction.id,
            message_id: reaction.message_id,
            user_id: reaction.user_id,
            emoji_id: reaction.emoji_id,
            custom_emoji_content: reaction.custom_emoji_content,
          });
          await supabase.from('reactions').update({ federation_status: 'queued' }).eq('id', reaction.id);
        }
      }
    }

    // Sweep edited channel messages
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    const { data: editedChannelMessages } = await supabase
      .from('messages')
      .select('id, channel_id, user_id, created_at, updated_at')
      .eq('federation_status', 'pending')
      .eq('is_deleted', false)
      .not('channel_id', 'is', null)
      .is('conversation_id', null)
      .lt('updated_at', fiveSecondsAgo)
      .limit(100);

    const trulyEdited = (editedChannelMessages || []).filter((msg: any) => {
      const created = new Date(msg.created_at).getTime();
      const updated = new Date(msg.updated_at).getTime();
      return (updated - created) > 2000;
    });

    if (trulyEdited.length) {
      logger.info(`Sweep found ${trulyEdited.length} edited channel messages`);
      for (const msg of trulyEdited) {
        await this.addJob('federate-channel-message-edit', {
          type: 'update',
          message_id: msg.id,
          channel_id: msg.channel_id,
          user_id: msg.user_id,
        });
        await supabase.from('messages').update({ federation_status: 'queued' }).eq('id', msg.id);
      }
    }

    // Sweep pending channels
    const { data: pendingChannels } = await supabase
      .from('channels')
      .select('id, server_id, name, is_remote')
      .eq('federation_status', 'pending')
      .eq('is_remote', false)
      .lt('created_at', twoSecondsAgo)
      .limit(50);

    if (pendingChannels?.length) {
      logger.info(`Sweep found ${pendingChannels.length} pending channels`);
      for (const channel of pendingChannels) {
        await this.addJob('federate-channel-crud', {
          type: 'create',
          channel_id: channel.id,
          server_id: channel.server_id,
        });
        await supabase.from('channels').update({ federation_status: 'queued' }).eq('id', channel.id);
      }
    }

    // Sweep pending categories
    const { data: pendingCategories } = await supabase
      .from('channel_categories')
      .select('id, server_id, name')
      .eq('federation_status', 'pending')
      .lt('created_at', twoSecondsAgo)
      .limit(50);

    if (pendingCategories?.length) {
      logger.info(`Sweep found ${pendingCategories.length} pending categories`);
      for (const category of pendingCategories) {
        await this.addJob('federate-category-crud', {
          type: 'create',
          category_id: category.id,
          server_id: category.server_id,
        });
        await supabase.from('channel_categories').update({ federation_status: 'queued' }).eq('id', category.id);
      }
    }

    // Sweep updated channels
    const { data: updatedChannels } = await supabase
      .from('channels')
      .select('id, server_id, name, updated_at, servers!inner(is_local_server, federation_enabled)')
      .eq('is_remote', false)
      .eq('servers.is_local_server', true)
      .eq('servers.federation_enabled', true)
      .not('federation_status', 'eq', 'pending')
      .gt('updated_at', twoSecondsAgo)
      .lt('updated_at', new Date(Date.now() - 1000).toISOString())
      .limit(50);

    if (updatedChannels?.length) {
      const toFederate = updatedChannels.filter((ch: any) =>
        ch.federation_status !== 'queued' || new Date(ch.updated_at) > new Date(Date.now() - 60000),
      );
      if (toFederate.length) {
        logger.info(`Sweep found ${toFederate.length} updated channels`);
        for (const channel of toFederate) {
          await this.addJob('federate-channel-crud', { type: 'update', channel_id: channel.id, server_id: channel.server_id });
          await supabase.from('channels').update({ federation_status: 'queued' }).eq('id', channel.id);
        }
      }
    }

    // Sweep updated categories
    const { data: updatedCategories } = await supabase
      .from('channel_categories')
      .select('id, server_id, name, updated_at, servers!inner(is_local_server, federation_enabled)')
      .eq('servers.is_local_server', true)
      .eq('servers.federation_enabled', true)
      .not('federation_status', 'eq', 'pending')
      .gt('updated_at', twoSecondsAgo)
      .lt('updated_at', new Date(Date.now() - 1000).toISOString())
      .limit(50);

    if (updatedCategories?.length) {
      const toFederate = updatedCategories.filter((cat: any) =>
        cat.federation_status !== 'queued' || new Date(cat.updated_at) > new Date(Date.now() - 60000),
      );
      if (toFederate.length) {
        logger.info(`Sweep found ${toFederate.length} updated categories`);
        for (const category of toFederate) {
          await this.addJob('federate-category-crud', { type: 'update', category_id: category.id, server_id: category.server_id });
          await supabase.from('channel_categories').update({ federation_status: 'queued' }).eq('id', category.id);
        }
      }
    }

    // Sweep updated servers
    const { data: updatedServers } = await supabase
      .from('servers')
      .select('id, name, updated_at')
      .eq('is_local_server', true)
      .eq('federation_enabled', true)
      .gt('updated_at', twoSecondsAgo)
      .lt('updated_at', new Date(Date.now() - 1000).toISOString())
      .limit(20);

    if (updatedServers?.length) {
      logger.info(`Sweep found ${updatedServers.length} updated servers`);
      for (const server of updatedServers) {
        await this.addJob('federate-server-update', { type: 'update', server_id: server.id });
      }
    }
  }
}

export const bullmqManager = new BullMQManagerService();
