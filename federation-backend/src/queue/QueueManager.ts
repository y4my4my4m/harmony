/**
 * QueueManager - pg-boss integration for federation job processing
 * 
 * This replaces the fragile Supabase Realtime approach with a professional
 * PostgreSQL-native job queue that guarantees delivery.
 * 
 * Architecture:
 * 1. Database triggers insert jobs when federatable content is created
 * 2. pg-boss manages the job queue in PostgreSQL tables
 * 3. Workers process jobs with automatic retries and exponential backoff
 * 4. Failed jobs go to dead letter queue for manual review
 */

import PgBoss from 'pg-boss';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

// Import job handlers
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
import { handlePushNotificationJob } from './handlers/pushNotificationHandler.js';

// Job types
export type JobType = 
  | 'federate-post'
  | 'federate-reaction'
  | 'federate-follow'
  | 'federate-dm'
  | 'federate-channel-message'       // Channel message create
  | 'federate-channel-message-edit'  // Channel message edit
  | 'federate-channel-message-delete'// Channel message delete
  | 'federate-channel-reaction'      // Channel message reaction
  | 'federate-message-reaction'      // DM reaction
  | 'federate-channel-crud'          // Channel create/update/delete
  | 'federate-category-crud'         // Category create/update/delete
  | 'federate-server-update'         // Server update (name, icon, etc.)
  | 'federate-block'
  | 'federate-report'
  | 'federate-profile'
  | 'send-push-notification'
  | 'sweep-pending';

// Job data interface
export interface FederationJobData {
  type: 'create' | 'update' | 'delete' | 'pin_change';
  [key: string]: any;
}

class QueueManagerService {
  private boss: PgBoss | null = null;
  private isRunning = false;
  private sweepIntervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Initialize pg-boss and start processing jobs
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('QueueManager already running');
      return;
    }

    logger.info('🚀 Starting QueueManager with pg-boss...');

    try {
      // Build connection string from config
      const connectionString = this.buildConnectionString();
      
      // Initialize pg-boss with configuration
      this.boss = new PgBoss({
        connectionString,
        schema: 'pgboss',
        
        // Archive completed jobs for 7 days
        archiveCompletedAfterSeconds: 60 * 60 * 24 * 7,
        
        // Delete archived jobs after 30 days
        deleteAfterSeconds: 60 * 60 * 24 * 30,
        
        // Maintenance every 2 minutes
        maintenanceIntervalSeconds: 120,
        
        // Monitor stuck jobs
        monitorStateIntervalSeconds: 30,
        
        // UUID generation
        uuid: 'v4',
        
        // Application name for connection tracking
        application_name: 'harmony-federation-queue',
      });

      // Error handling
      this.boss.on('error', (error) => {
        logger.error('❌ pg-boss error:', error);
      });

      // Maintenance events
      this.boss.on('maintenance', () => {
        logger.debug('🔧 pg-boss maintenance completed');
      });

      this.boss.on('monitor-states', (states) => {
        logger.debug('📊 Queue states:', states);
      });

      // Start pg-boss
      await this.boss.start();
      logger.info('✅ pg-boss started successfully');

      // Create all queues (this creates the partitions needed for direct SQL inserts)
      await this.createQueues();

      // Register job handlers
      await this.registerHandlers();
      
      // Start periodic sweep for missed events
      this.startPeriodicSweep();
      
      this.isRunning = true;
      logger.info('✅ QueueManager is ready and processing jobs');

    } catch (error) {
      logger.error('❌ Failed to start QueueManager:', error);
      throw error;
    }
  }

  /**
   * Get PostgreSQL connection string from environment
   */
  private buildConnectionString(): string {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL environment variable is required for pg-boss.\n' +
        'Add to your .env file:\n' +
        '  DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE\n\n' +
        'Examples:\n' +
        '  Self-hosted: DATABASE_URL=postgresql://supabase_admin:password@localhost:54322/postgres\n' +
        '  Supabase Cloud: DATABASE_URL=postgresql://postgres.[ref]:[password]@[region].pooler.supabase.com:6543/postgres'
      );
    }
    
    logger.info('📦 Using DATABASE_URL from environment');
    return process.env.DATABASE_URL;
  }

  /**
   * Create all queue partitions so SQL triggers can insert directly
   */
  private async createQueues(): Promise<void> {
    if (!this.boss) throw new Error('pg-boss not initialized');

    const queueNames: JobType[] = [
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
      'send-push-notification',
    ];

    for (const queueName of queueNames) {
      try {
        await this.boss.createQueue(queueName);
        logger.debug(`✅ Created queue: ${queueName}`);
      } catch (error: any) {
        // Ignore "already exists" errors
        if (!error.message?.includes('already exists')) {
          logger.warn(`⚠️ Failed to create queue ${queueName}:`, error.message);
        }
      }
    }

    logger.info('✅ All queue partitions created');
  }

  /**
   * Register handlers for each job type
   */
  private async registerHandlers(): Promise<void> {
    if (!this.boss) throw new Error('pg-boss not initialized');

    // Helper to create job handler with logging
    const createHandler = (
      jobType: string,
      emoji: string,
      handler: (data: FederationJobData) => Promise<void>
    ) => async (jobArg: any) => {
      // Debug: Log exactly what we receive
      logger.debug(`🔍 ${jobType} received type: ${typeof jobArg}, isArray: ${Array.isArray(jobArg)}`);
      logger.debug(`🔍 ${jobType} raw value: ${JSON.stringify(jobArg)?.substring(0, 500)}`);
      
      // Skip if no argument (shouldn't happen but safety check)
      if (jobArg === undefined || jobArg === null) {
        logger.warn(`⚠️ ${jobType} received null/undefined, skipping`);
        return;
      }
      
      // pg-boss 10.x: check if it's an array or single job
      const jobs = Array.isArray(jobArg) ? jobArg : [jobArg];
      
      for (const job of jobs) {
        // Skip empty/invalid jobs
        if (!job || typeof job !== 'object') {
          logger.warn(`⚠️ ${jobType} invalid job object: ${JSON.stringify(job)}`);
          continue;
        }
        
        const jobId = job.id || 'no-id';
        const jobData = job.data;
        
        logger.info(`${emoji} Processing ${jobType} job: ${jobId}`);
        
        try {
          if (!jobData) {
            logger.warn(`⚠️ ${jobType} job ${jobId} has no data property`);
            logger.debug(`Job object: ${JSON.stringify(job)}`);
            continue;
          }
          await handler(jobData);
          logger.info(`✅ ${jobType} job completed: ${jobId}`);
        } catch (error) {
          logger.error(`❌ ${jobType} job failed: ${jobId}`, error);
          throw error;
        }
      }
    };

    // Concurrency settings - process multiple jobs in parallel
    // Each queue gets its own workers for true parallelism
    const WORKERS_PER_QUEUE = 5;  // 5 concurrent workers per job type
    const POLLING_INTERVAL = 1;    // Check for jobs every 1 second

    // Register multiple workers per queue for parallel processing
    const registerWithConcurrency = async (
      queueName: string,
      handler: any
    ) => {
      for (let i = 0; i < WORKERS_PER_QUEUE; i++) {
        await this.boss!.work(queueName, { pollingIntervalSeconds: POLLING_INTERVAL }, handler);
      }
    };

    await registerWithConcurrency('federate-post', createHandler('federate-post', '📬', handlePostJob));
    await registerWithConcurrency('federate-reaction', createHandler('federate-reaction', '❤️', handleReactionJob));
    await registerWithConcurrency('federate-follow', createHandler('federate-follow', '👥', handleFollowJob));
    await registerWithConcurrency('federate-dm', createHandler('federate-dm', '💬', handleDMJob));
    await registerWithConcurrency('federate-channel-message', createHandler('federate-channel-message', '📨', handleChannelMessageJob));
    await registerWithConcurrency('federate-channel-message-edit', createHandler('federate-channel-message-edit', '✏️', handleChannelMessageEditJob));
    await registerWithConcurrency('federate-channel-message-delete', createHandler('federate-channel-message-delete', '🗑️', handleChannelMessageDeleteJob));
    await registerWithConcurrency('federate-channel-reaction', createHandler('federate-channel-reaction', '💬⭐', handleChannelReactionJob));
    await registerWithConcurrency('federate-message-reaction', createHandler('federate-message-reaction', '💬❤️', handleMessageReactionJob));
    await registerWithConcurrency('federate-channel-crud', createHandler('federate-channel-crud', '📢', handleChannelCrudJob));
    await registerWithConcurrency('federate-category-crud', createHandler('federate-category-crud', '📁', handleCategoryCrudJob));
    await registerWithConcurrency('federate-server-update', createHandler('federate-server-update', '🏠', handleServerUpdateJob));
    await registerWithConcurrency('federate-block', createHandler('federate-block', '🚫', handleBlockJob));
    await registerWithConcurrency('federate-report', createHandler('federate-report', '🚩', handleReportJob));
    await registerWithConcurrency('federate-profile', createHandler('federate-profile', '👤', handleProfileJob));
    await registerWithConcurrency('send-push-notification', createHandler('send-push-notification', '📱', handlePushNotificationJob as any));

    logger.info(`✅ All job handlers registered (${WORKERS_PER_QUEUE} workers per queue, ${WORKERS_PER_QUEUE * 9} total workers)`);
  }

  /**
   * Start periodic sweep for pending federation items
   * 
   * For real-time performance, messages with federation_status='pending'
   * will be picked up by this sweep. The sweep runs frequently to catch
   * new items quickly.
   */
  private startPeriodicSweep(): void {
    // Run sweep every 10 seconds for responsive federation
    const SWEEP_INTERVAL_MS = 10 * 1000; // 10 seconds
    
    this.sweepIntervalId = setInterval(async () => {
      try {
        await this.sweepPendingItems();
      } catch (error) {
        logger.error('❌ Periodic sweep failed:', error);
      }
    }, SWEEP_INTERVAL_MS);

    logger.info('🔄 Periodic sweep started (10 second interval)');
  }

  /**
   * Sweep for items with pending federation status older than 2 seconds
   * Short delay ensures the database transaction is committed
   */
  async sweepPendingItems(): Promise<void> {
    if (!this.boss) return;

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

    if (pendingPosts && pendingPosts.length > 0) {
      logger.info(`🔄 Sweep found ${pendingPosts.length} pending posts`);
      for (const post of pendingPosts) {
        await this.boss.send('federate-post', {
          type: 'create',
          post_id: post.id,
          author_id: post.author_id,
          visibility: post.visibility
        });
        
        // Update status to queued
        await supabase
          .from('posts')
          .update({ federation_status: 'queued' })
          .eq('id', post.id);
      }
    }

    // Sweep follows
    const { data: pendingFollows } = await supabase
      .from('follows')
      .select('id, follower_id, following_id, status')
      .eq('federation_status', 'pending')
      .lt('created_at', twoSecondsAgo)
      .limit(100);

    if (pendingFollows && pendingFollows.length > 0) {
      logger.info(`🔄 Sweep found ${pendingFollows.length} pending follows`);
      for (const follow of pendingFollows) {
        await this.boss.send('federate-follow', {
          type: 'create',
          follow_id: follow.id,
          follower_id: follow.follower_id,
          following_id: follow.following_id,
          status: follow.status
        });
        
        await supabase
          .from('follows')
          .update({ federation_status: 'queued' })
          .eq('id', follow.id);
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

    if (pendingDMs && pendingDMs.length > 0) {
      logger.info(`🔄 Sweep found ${pendingDMs.length} pending DMs`);
      for (const dm of pendingDMs) {
        await this.boss.send('federate-dm', {
          type: 'create',
          message_id: dm.id,
          conversation_id: dm.conversation_id,
          user_id: dm.user_id
        });
        
        await supabase
          .from('messages')
          .update({ federation_status: 'queued' })
          .eq('id', dm.id);
      }
    }

    // Sweep channel messages (server messages) - NEW messages only
    const { data: pendingChannelMessages } = await supabase
      .from('messages')
      .select('id, channel_id, user_id')
      .eq('federation_status', 'pending')
      .eq('is_deleted', false)
      .not('channel_id', 'is', null)
      .is('conversation_id', null)  // Not a DM
      .lt('created_at', twoSecondsAgo)
      .limit(100);

    if (pendingChannelMessages && pendingChannelMessages.length > 0) {
      logger.info(`🔄 Sweep found ${pendingChannelMessages.length} pending channel messages`);
      for (const msg of pendingChannelMessages) {
        await this.boss.send('federate-channel-message', {
          type: 'create',
          message_id: msg.id,
          channel_id: msg.channel_id,
          user_id: msg.user_id
        });
        
        await supabase
          .from('messages')
          .update({ federation_status: 'queued' })
          .eq('id', msg.id);
      }
    }

    // Sweep DELETED channel messages
    const { data: deletedChannelMessages } = await supabase
      .from('messages')
      .select('id, channel_id, user_id, metadata')
      .eq('federation_status', 'pending')
      .eq('is_deleted', true)
      .not('channel_id', 'is', null)
      .is('conversation_id', null)
      .limit(100);

    if (deletedChannelMessages && deletedChannelMessages.length > 0) {
      logger.info(`🔄 Sweep found ${deletedChannelMessages.length} deleted channel messages`);
      for (const msg of deletedChannelMessages) {
        await this.boss.send('federate-channel-message-delete', {
          type: 'delete',
          message_id: msg.id,
          channel_id: msg.channel_id,
          user_id: msg.user_id,
          ap_id: msg.metadata?.ap_id,
        });
        
        await supabase
          .from('messages')
          .update({ federation_status: 'queued' })
          .eq('id', msg.id);
      }
    }

    // Sweep channel reactions
    const { data: pendingReactions } = await supabase
      .from('reactions')
      .select(`
        id, message_id, user_id, emoji_id, custom_emoji_content,
        message:messages!reactions_message_id_fkey(channel_id, conversation_id)
      `)
      .eq('federation_status', 'pending')
      .lt('created_at', twoSecondsAgo)
      .limit(100);

    if (pendingReactions && pendingReactions.length > 0) {
      // Filter to only channel reactions (not DM reactions which have different handling)
      const channelReactions = pendingReactions.filter(
        (r: any) => r.message?.channel_id && !r.message?.conversation_id
      );
      
      if (channelReactions.length > 0) {
        logger.info(`🔄 Sweep found ${channelReactions.length} pending channel reactions`);
        for (const reaction of channelReactions) {
          await this.boss.send('federate-channel-reaction', {
            type: 'create',
            reaction_id: reaction.id,
            message_id: reaction.message_id,
            user_id: reaction.user_id,
            emoji_id: reaction.emoji_id,
            custom_emoji_content: reaction.custom_emoji_content,
          });
          
          await supabase
            .from('reactions')
            .update({ federation_status: 'queued' })
            .eq('id', reaction.id);
        }
      }
    }

    // Sweep EDITED channel messages (updated_at > created_at means it was edited)
    // We use a 5-second buffer to avoid race conditions during initial save
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

    // Filter to only actually edited messages (updated_at significantly after created_at)
    const trulyEditedMessages = (editedChannelMessages || []).filter((msg: any) => {
      const created = new Date(msg.created_at).getTime();
      const updated = new Date(msg.updated_at).getTime();
      // More than 2 seconds difference means it was edited, not just initial creation jitter
      return (updated - created) > 2000;
    });

    if (trulyEditedMessages.length > 0) {
      logger.info(`🔄 Sweep found ${trulyEditedMessages.length} edited channel messages`);
      for (const msg of trulyEditedMessages) {
        await this.boss.send('federate-channel-message-edit', {
          type: 'update',
          message_id: msg.id,
          channel_id: msg.channel_id,
          user_id: msg.user_id
        });
        
        await supabase
          .from('messages')
          .update({ federation_status: 'queued' })
          .eq('id', msg.id);
      }
    }

    // Sweep pending channels (created/updated)
    const { data: pendingChannels } = await supabase
      .from('channels')
      .select('id, server_id, name, is_remote')
      .eq('federation_status', 'pending')
      .eq('is_remote', false)  // Only federate local channels
      .lt('created_at', twoSecondsAgo)
      .limit(50);

    if (pendingChannels && pendingChannels.length > 0) {
      logger.info(`🔄 Sweep found ${pendingChannels.length} pending channels`);
      for (const channel of pendingChannels) {
        await this.boss.send('federate-channel-crud', {
          type: 'create',
          channel_id: channel.id,
          server_id: channel.server_id,
        });
        
        await supabase
          .from('channels')
          .update({ federation_status: 'queued' })
          .eq('id', channel.id);
      }
    }

    // Sweep pending categories
    const { data: pendingCategories } = await supabase
      .from('channel_categories')
      .select('id, server_id, name')
      .eq('federation_status', 'pending')
      .lt('created_at', twoSecondsAgo)
      .limit(50);

    if (pendingCategories && pendingCategories.length > 0) {
      logger.info(`🔄 Sweep found ${pendingCategories.length} pending categories`);
      for (const category of pendingCategories) {
        await this.boss.send('federate-category-crud', {
          type: 'create',
          category_id: category.id,
          server_id: category.server_id,
        });
        
        await supabase
          .from('channel_categories')
          .update({ federation_status: 'queued' })
          .eq('id', category.id);
      }
    }
  }

  /**
   * Manually queue a job (for testing or manual federation)
   */
  async sendJob(jobType: JobType, data: FederationJobData): Promise<string | null> {
    if (!this.boss) {
      logger.error('pg-boss not initialized');
      return null;
    }

    const jobId = await this.boss.send(jobType, data);
    logger.info(`📤 Queued ${jobType} job: ${jobId}`);
    return jobId;
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<object> {
    if (!this.boss) return { status: 'not_initialized' };

    const jobTypes: JobType[] = [
      'federate-post',
      'federate-reaction', 
      'federate-follow',
      'federate-dm',
      'federate-message-reaction',
      'federate-block',
      'federate-report',
      'federate-profile'
    ];

    const stats: any = {
      isRunning: this.isRunning,
      queues: {}
    };

    for (const jobType of jobTypes) {
      const queueSize = await this.boss.getQueueSize(jobType);
      stats.queues[jobType] = queueSize;
    }

    return stats;
  }

  /**
   * Stop pg-boss gracefully
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('🛑 Stopping QueueManager...');

    // Clear sweep interval
    if (this.sweepIntervalId) {
      clearInterval(this.sweepIntervalId);
      this.sweepIntervalId = null;
    }

    // Stop pg-boss
    if (this.boss) {
      await this.boss.stop({ graceful: true, timeout: 30000 });
      this.boss = null;
    }

    this.isRunning = false;
    logger.info('✅ QueueManager stopped');
  }
}

// Export singleton instance
export const queueManager = new QueueManagerService();

