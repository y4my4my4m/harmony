/**
 * Push Notification Handler
 * 
 * Listens for new notifications in the database and sends push notifications
 * to users' subscribed devices.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { PushNotificationService } from '../services/PushNotificationService.js';
import { logger } from '../utils/logger.js';

/**
 * Start listening for notifications and send push notifications
 */
export async function startPushNotificationListener(): Promise<void> {
  // Initialize push service
  if (!PushNotificationService.initialize()) {
    logger.warn('⚠️ Push notification listener not started (VAPID not configured)');
    return;
  }

  logger.info('📱 Starting push notification listener...');

  const supabase = getSupabaseClient();

  // Subscribe to new notifications
  const _channel = supabase
    .channel('push-notifications')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
      },
      async (payload) => {
        try {
          const notification = payload.new as {
            id: string;
            user_id: string;
            type: string;
            data: Record<string, any>;
            title?: string;
            is_read: boolean;
          };

          // Don't send push for already-read notifications (shouldn't happen but safety check)
          if (notification.is_read) {
            return;
          }

          logger.debug(`📬 New notification for push: ${notification.type} to user ${notification.user_id}`);

          // Send push notification
          await PushNotificationService.sendForNotification(notification);
        } catch (error) {
          logger.error('Error handling notification for push:', error);
        }
      }
    )
    .subscribe((status, err) => {
      if (err) {
        logger.error('❌ Push notification listener error:', err);
      }
      
      if (status === 'SUBSCRIBED') {
        logger.info('✅ Push notification listener active');
      } else if (status === 'CHANNEL_ERROR') {
        logger.error('❌ Push notification listener channel error');
      } else if (status === 'TIMED_OUT') {
        logger.error('❌ Push notification listener timed out');
      }
    });

  // Cleanup stale subscriptions periodically (every hour)
  setInterval(async () => {
    try {
      const cleaned = await PushNotificationService.cleanupStaleSubscriptions();
      if (cleaned > 0) {
        logger.info(`🧹 Cleaned up ${cleaned} stale push subscriptions`);
      }
    } catch (error) {
      logger.error('Error cleaning up stale subscriptions:', error);
    }
  }, 60 * 60 * 1000); // 1 hour

  logger.info('📱 Push notification listener started');
}

