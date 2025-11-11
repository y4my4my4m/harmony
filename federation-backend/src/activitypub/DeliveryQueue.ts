import { getSupabaseClient } from '../config/supabase.js';
import { SignatureService } from './SignatureService.js';
import { logger } from '../utils/logger.js';

interface QueueItem {
  id: string;
  activity_data: any;
  target_inbox: string;
  sender_id: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
}

export class DeliveryQueue {
  /**
   * Add an activity to the delivery queue
   */
  static async enqueue(
    activityData: any,
    targetInbox: string,
    senderId: string,
    priority: number = 5
  ): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase.from('federation_delivery_queue').insert({
      activity_data: activityData,
      target_inbox: targetInbox,
      sender_id: senderId,
      priority,
      status: 'pending',
      attempts: 0,
      max_attempts: 5,
      next_retry_at: new Date().toISOString(),
    });

    if (error) {
      logger.error('Failed to enqueue delivery:', error);
      throw error;
    }

    logger.info(`Queued delivery to ${targetInbox}`);
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
    const { data: items, error } = await supabase
      .from('federation_delivery_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('next_retry_at', now)
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
   * Deliver a single activity to a remote inbox
   */
  private static async deliverActivity(item: QueueItem): Promise<boolean> {
    const supabase = getSupabaseClient();

    try {
      // Sign the request
      const { headers, digest } = await SignatureService.signRequest(
        item.target_inbox,
        'POST',
        item.activity_data,
        item.sender_id
      );

      // Add content-type
      headers['Content-Type'] = 'application/activity+json';

      // Send request
      const response = await fetch(item.target_inbox, {
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

        logger.info(`✅ Delivered to ${item.target_inbox} (${response.status})`);
        return true;
      } else {
        // Failed but might retry
        await this.handleDeliveryFailure(item, `HTTP ${response.status}`);
        logger.warn(`❌ Failed to deliver to ${item.target_inbox}: ${response.status}`);
        return false;
      }
    } catch (error) {
      // Network error or other exception
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.handleDeliveryFailure(item, errorMessage);
      logger.error(`❌ Delivery error to ${item.target_inbox}:`, error);
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

      logger.warn(`Max attempts reached for delivery to ${item.target_inbox}`);
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
          next_retry_at: nextRetry.toISOString(),
          last_error: errorMessage,
        })
        .eq('id', item.id);

      logger.info(`Scheduled retry for ${item.target_inbox} in ${backoffMinutes} minutes`);
    }
  }

  /**
   * Broadcast activity to all followers of a user
   */
  static async broadcastToFollowers(
    userId: string,
    activityData: any
  ): Promise<void> {
    const supabase = getSupabaseClient();

    // Get all followers' inbox URLs
    const { data: follows } = await supabase
      .from('follows')
      .select(`
        follower_id,
        profiles!follows_follower_id_fkey (
          inbox_url,
          is_local
        )
      `)
      .eq('following_id', userId)
      .eq('status', 'accepted');

    if (!follows || follows.length === 0) {
      logger.info('No followers to broadcast to');
      return;
    }

    // Filter remote followers and enqueue deliveries
    let enqueued = 0;
    for (const follow of follows) {
      const follower = (follow as any).profiles;
      
      if (!follower.is_local && follower.inbox_url) {
        await this.enqueue(activityData, follower.inbox_url, userId);
        enqueued++;
      }
    }

    logger.info(`Enqueued broadcast to ${enqueued} remote followers`);
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

