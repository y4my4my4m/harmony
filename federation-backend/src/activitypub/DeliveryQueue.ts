import { getSupabaseClient } from '../config/supabase.js';
import { SignatureService } from './SignatureService.js';
import { logger } from '../utils/logger.js';

interface QueueItem {
  id: string;
  activity_data: any;
  target_inbox_url: string;  // Database uses target_inbox_url (not target_inbox)
  sender_id: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;  // Database column name (not next_retry_at)
}

export class DeliveryQueue {
  /**
   * Add an activity to the delivery queue and try to deliver immediately
   * For realtime federation - tries immediate delivery first, queues only if it fails
   */
  static async enqueue(
    activityData: any,
    targetInbox: string,
    senderId: string,
    priority: number = 5
  ): Promise<void> {
    logger.info(`📤 Attempting immediate delivery to ${targetInbox}`);
    
    // Try immediate delivery first (realtime!)
    try {
      const success = await this.deliverActivityDirect(
        activityData,
        targetInbox,
        senderId
      );
      
      if (success) {
        logger.info(`✅ Immediate delivery succeeded to ${targetInbox}`);
        return; // Success! No need to queue
      }
    } catch (error) {
      logger.warn(`⚠️ Immediate delivery failed, queuing for retry:`, error);
    }
    
    // Immediate delivery failed - queue it for retry
    const supabase = getSupabaseClient();
    
    // Extract domain from inbox URL
    const targetDomain = new URL(targetInbox).hostname;

    const { error } = await supabase.from('federation_delivery_queue').insert({
      activity_data: activityData,
      target_inbox_url: targetInbox,  // Database uses target_inbox_url
      target_domain: targetDomain,
      sender_id: senderId,
      priority,
      status: 'pending',
      attempts: 1, // Already tried once
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // Retry in 5 minutes
      last_attempt_at: new Date().toISOString(),
    });

    if (error) {
      logger.error('Failed to queue delivery for retry:', error);
      throw error;
    }

    logger.info(`📋 Queued for retry: ${targetInbox} (will retry in 5 minutes)`);
  }

  /**
   * Process pending deliveries from the queue
   */
  static async processQueue(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    // Fetch pending items ready for delivery
    // NOTE: Database uses next_attempt_at, not next_retry_at
    const { data: items, error } = await supabase
      .from('federation_delivery_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('next_attempt_at', now)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(50);

    if (error || !items || items.length === 0) {
      logger.info('No items in delivery queue');
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    let succeeded = 0;
    let failed = 0;

    for (const item of items) {
      const success = await this.deliverActivity(item);
      if (success) {
        succeeded++;
      } else {
        failed++;
      }
    }

    logger.info(`Processed ${items.length} deliveries: ${succeeded} succeeded, ${failed} failed`);

    return {
      processed: items.length,
      succeeded,
      failed,
    };
  }

  /**
   * Deliver directly without queue management (for immediate delivery)
   */
  private static async deliverActivityDirect(
    activityData: any,
    targetInbox: string,
    senderId: string
  ): Promise<boolean> {
    try {
      // Sign the request
      const { headers, digest } = await SignatureService.signRequest(
        targetInbox,
        'POST',
        activityData,
        senderId
      );

      // Add content-type
      headers['Content-Type'] = 'application/activity+json';

      // Send request
      const response = await fetch(targetInbox, {
        method: 'POST',
        headers,
        body: JSON.stringify(activityData),
      });

      if (response.ok || response.status === 202) {
        logger.info(`✅ Delivered to ${targetInbox} (${response.status})`);
        return true;
      } else {
        logger.warn(`❌ Failed to deliver to ${targetInbox}: ${response.status}`);
        return false;
      }
    } catch (error) {
      logger.error(`❌ Delivery error to ${targetInbox}:`, error);
      return false;
    }
  }

  /**
   * Deliver a single activity to a remote inbox (from queue)
   */
  private static async deliverActivity(item: QueueItem): Promise<boolean> {
    const supabase = getSupabaseClient();

    try {
      // Sign the request
      const { headers, digest } = await SignatureService.signRequest(
        item.target_inbox_url,
        'POST',
        item.activity_data,
        item.sender_id
      );

      // Add content-type
      headers['Content-Type'] = 'application/activity+json';

      // Send request
      const response = await fetch(item.target_inbox_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(item.activity_data),
      });

      if (response.ok || response.status === 202) {
        // Success - mark as delivered
        await supabase
          .from('federation_delivery_queue')
          .update({
            status: 'delivered',
            last_attempt_at: new Date().toISOString(),
          })
          .eq('id', item.id);

        logger.info(`✅ Delivered to ${item.target_inbox_url} (${response.status})`);
        return true;
      } else {
        // Failed but might retry
        await this.handleDeliveryFailure(item, `HTTP ${response.status}`);
        logger.warn(`❌ Failed to deliver to ${item.target_inbox_url}: ${response.status}`);
        return false;
      }
    } catch (error) {
      // Network error or other exception
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.handleDeliveryFailure(item, errorMessage);
      logger.error(`❌ Delivery error to ${item.target_inbox_url}:`, error);
      return false;
    }
  }

  /**
   * Handle delivery failure (retry with exponential backoff)
   */
  private static async handleDeliveryFailure(
    item: QueueItem,
    errorMessage: string
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const newAttempts = item.attempts + 1;

    if (newAttempts >= item.max_attempts) {
      // Max attempts reached - mark as failed
      await supabase
        .from('federation_delivery_queue')
        .update({
          status: 'failed',
          last_attempt_at: new Date().toISOString(),
          attempts: newAttempts,
          last_error: errorMessage,
        })
        .eq('id', item.id);

      logger.warn(`Max attempts reached for delivery to ${item.target_inbox_url}`);
    } else {
      // Schedule retry with exponential backoff
      const backoffMinutes = Math.pow(2, newAttempts) * 5; // 5, 10, 20, 40, 80 minutes
      const nextRetry = new Date();
      nextRetry.setMinutes(nextRetry.getMinutes() + backoffMinutes);

      await supabase
        .from('federation_delivery_queue')
        .update({
          attempts: newAttempts,
          last_attempt_at: new Date().toISOString(),
          next_attempt_at: nextRetry.toISOString(),
          last_error: errorMessage,
        })
        .eq('id', item.id);

      logger.info(`Scheduled retry for ${item.target_inbox_url} in ${backoffMinutes} minutes`);
    }
  }

  /**
   * Broadcast activity to all followers of a user
   * Uses shared inbox when available to optimize delivery (one request per server)
   */
  static async broadcastToFollowers(
    userId: string,
    activityData: any
  ): Promise<void> {
    const supabase = getSupabaseClient();

    // Get all followers' inbox URLs (both individual and shared)
    // Use inner join syntax instead of foreign key hint to avoid ambiguity
    const { data: follows, error: followsError } = await supabase
      .from('follows')
      .select(`
        follower_id,
        follower:profiles!follower_id (
          inbox_url,
          shared_inbox_url,
          is_local,
          domain
        )
      `)
      .eq('following_id', userId)
      .eq('status', 'accepted');

    if (followsError) {
      logger.error('Error fetching followers:', followsError);
      return;
    }

    if (!follows || follows.length === 0) {
      logger.info('No followers to broadcast to');
      return;
    }

    // Group followers by their preferred inbox (shared inbox preferred)
    const inboxMap = new Map<string, { inbox: string; type: 'shared' | 'individual' }>();
    
    for (const follow of follows) {
      const follower = (follow as any).follower;
      
      if (!follower) {
        logger.warn(`Follower profile is null for follower_id: ${(follow as any).follower_id}`);
        continue;
      }
      
      if (follower.is_local) {
        continue; // Skip local followers
      }
      
      // Prefer shared inbox, fall back to individual inbox
      const preferredInbox = follower.shared_inbox_url || follower.inbox_url;
      
      if (preferredInbox) {
        const inboxType = follower.shared_inbox_url ? 'shared' : 'individual';
        
        if (!inboxMap.has(preferredInbox)) {
          inboxMap.set(preferredInbox, {
            inbox: preferredInbox,
            type: inboxType,
          });
        }
      } else {
        logger.warn(`Follower from ${follower.domain} has no inbox URL configured`);
      }
    }

    // Enqueue deliveries (one per unique inbox)
    let enqueued = 0;
    let sharedInboxCount = 0;
    let individualInboxCount = 0;
    
    for (const [inbox, { type }] of inboxMap) {
      await this.enqueue(activityData, inbox, userId);
        enqueued++;
      
      if (type === 'shared') {
        sharedInboxCount++;
      } else {
        individualInboxCount++;
      }
    }

    logger.info(
      `Enqueued broadcast to ${enqueued} inboxes ` +
      `(${sharedInboxCount} shared, ${individualInboxCount} individual) ` +
      `for ${follows.length} remote followers`
    );
  }

  /**
   * Send activity to a specific inbox
   */
  static async sendToInbox(
    inboxUrl: string,
    activityData: any,
    senderId: string
  ): Promise<void> {
    await this.enqueue(activityData, inboxUrl, senderId, 1); // High priority
  }

  /**
   * Get queue statistics
   */
  static async getStats(): Promise<{
    pending: number;
    delivered: number;
    failed: number;
  }> {
    const supabase = getSupabaseClient();

    const { count: pending } = await supabase
      .from('federation_delivery_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    const { count: delivered } = await supabase
      .from('federation_delivery_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'delivered');

    const { count: failed } = await supabase
      .from('federation_delivery_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'failed');

    return {
      pending: pending || 0,
      delivered: delivered || 0,
      failed: failed || 0,
    };
  }
}

