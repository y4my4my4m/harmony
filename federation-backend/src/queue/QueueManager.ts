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
import { handleMessageReactionJob } from './handlers/messageReactionHandler.js';
import { handleBlockJob } from './handlers/blockHandler.js';
import { handleReportJob } from './handlers/reportHandler.js';
import { handleProfileJob } from './handlers/profileHandler.js';

// Job types
export type JobType = 
  | 'federate-post'
  | 'federate-reaction'
  | 'federate-follow'
  | 'federate-dm'
  | 'federate-message-reaction'
  | 'federate-block'
  | 'federate-report'
  | 'federate-profile'
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
   * Build PostgreSQL connection string from config
   */
  private buildConnectionString(): string {
    // Use DATABASE_URL if provided, otherwise build from components
    if (process.env.DATABASE_URL) {
      return process.env.DATABASE_URL;
    }

    // Build from Supabase config
    const host = config.SUPABASE_URL.replace('https://', '').replace('.supabase.co', '.supabase.co');
    const dbHost = host.replace('.supabase.co', '.pooler.supabase.com');
    
    // Default Supabase PostgreSQL port is 6543 for pooler, 5432 for direct
    return `postgresql://postgres.${config.SUPABASE_URL.split('.')[0].split('//')[1]}:${config.SUPABASE_SERVICE_KEY}@${dbHost}:6543/postgres`;
  }

  /**
   * Register handlers for each job type
   */
  private async registerHandlers(): Promise<void> {
    if (!this.boss) throw new Error('pg-boss not initialized');

    const handlerOptions = {
      teamSize: 5,           // Process up to 5 jobs concurrently
      teamConcurrency: 2,    // Max concurrent jobs per type
      teamRefill: true,      // Refill team as jobs complete
    };

    // Register post federation handler
    await this.boss.work('federate-post', handlerOptions, async (job) => {
      logger.info(`📬 Processing federate-post job: ${job.id}`);
      try {
        await handlePostJob(job.data as FederationJobData);
        logger.info(`✅ federate-post job completed: ${job.id}`);
      } catch (error) {
        logger.error(`❌ federate-post job failed: ${job.id}`, error);
        throw error; // pg-boss will handle retry
      }
    });

    // Register reaction federation handler
    await this.boss.work('federate-reaction', handlerOptions, async (job) => {
      logger.info(`❤️ Processing federate-reaction job: ${job.id}`);
      try {
        await handleReactionJob(job.data as FederationJobData);
        logger.info(`✅ federate-reaction job completed: ${job.id}`);
      } catch (error) {
        logger.error(`❌ federate-reaction job failed: ${job.id}`, error);
        throw error;
      }
    });

    // Register follow federation handler
    await this.boss.work('federate-follow', handlerOptions, async (job) => {
      logger.info(`👥 Processing federate-follow job: ${job.id}`);
      try {
        await handleFollowJob(job.data as FederationJobData);
        logger.info(`✅ federate-follow job completed: ${job.id}`);
      } catch (error) {
        logger.error(`❌ federate-follow job failed: ${job.id}`, error);
        throw error;
      }
    });

    // Register DM federation handler
    await this.boss.work('federate-dm', handlerOptions, async (job) => {
      logger.info(`💬 Processing federate-dm job: ${job.id}`);
      try {
        await handleDMJob(job.data as FederationJobData);
        logger.info(`✅ federate-dm job completed: ${job.id}`);
      } catch (error) {
        logger.error(`❌ federate-dm job failed: ${job.id}`, error);
        throw error;
      }
    });

    // Register message reaction federation handler
    await this.boss.work('federate-message-reaction', handlerOptions, async (job) => {
      logger.info(`💬❤️ Processing federate-message-reaction job: ${job.id}`);
      try {
        await handleMessageReactionJob(job.data as FederationJobData);
        logger.info(`✅ federate-message-reaction job completed: ${job.id}`);
      } catch (error) {
        logger.error(`❌ federate-message-reaction job failed: ${job.id}`, error);
        throw error;
      }
    });

    // Register block federation handler
    await this.boss.work('federate-block', handlerOptions, async (job) => {
      logger.info(`🚫 Processing federate-block job: ${job.id}`);
      try {
        await handleBlockJob(job.data as FederationJobData);
        logger.info(`✅ federate-block job completed: ${job.id}`);
      } catch (error) {
        logger.error(`❌ federate-block job failed: ${job.id}`, error);
        throw error;
      }
    });

    // Register report federation handler
    await this.boss.work('federate-report', handlerOptions, async (job) => {
      logger.info(`🚩 Processing federate-report job: ${job.id}`);
      try {
        await handleReportJob(job.data as FederationJobData);
        logger.info(`✅ federate-report job completed: ${job.id}`);
      } catch (error) {
        logger.error(`❌ federate-report job failed: ${job.id}`, error);
        throw error;
      }
    });

    // Register profile federation handler
    await this.boss.work('federate-profile', handlerOptions, async (job) => {
      logger.info(`👤 Processing federate-profile job: ${job.id}`);
      try {
        await handleProfileJob(job.data as FederationJobData);
        logger.info(`✅ federate-profile job completed: ${job.id}`);
      } catch (error) {
        logger.error(`❌ federate-profile job failed: ${job.id}`, error);
        throw error;
      }
    });

    logger.info('✅ All job handlers registered');
  }

  /**
   * Start periodic sweep for missed events
   * This catches any items that were inserted but didn't trigger jobs
   */
  private startPeriodicSweep(): void {
    // Run sweep every 60 seconds
    this.sweepIntervalId = setInterval(async () => {
      try {
        await this.sweepPendingItems();
      } catch (error) {
        logger.error('❌ Periodic sweep failed:', error);
      }
    }, 60000);

    logger.info('🔄 Periodic sweep started (60s interval)');
  }

  /**
   * Sweep for items with pending federation status older than 30 seconds
   */
  async sweepPendingItems(): Promise<void> {
    if (!this.boss) return;

    const { getSupabaseClient } = await import('../config/supabase.js');
    const supabase = getSupabaseClient();
    const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString();

    // Sweep posts
    const { data: pendingPosts } = await supabase
      .from('posts')
      .select('id, author_id, visibility')
      .eq('is_local', true)
      .eq('federation_status', 'pending')
      .in('visibility', ['public', 'unlisted'])
      .lt('created_at', thirtySecondsAgo)
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
      .lt('created_at', thirtySecondsAgo)
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
      .lt('created_at', thirtySecondsAgo)
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

