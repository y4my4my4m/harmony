/**
 * Push Notification Job Handler
 * 
 * Processes push notification jobs queued by database triggers.
 * More reliable than Realtime WebSocket in Docker environments.
 */

import { PushNotificationService } from '../../services/PushNotificationService.js';
import { logger } from '../../utils/logger.js';

export interface PushNotificationJobData {
  notification_id: string;
  user_id: string;
  type: string;
  data: Record<string, any>;
}

export async function handlePushNotificationJob(data: PushNotificationJobData): Promise<void> {
  const { notification_id, user_id, type, data: notificationData } = data;
  
  logger.debug(`📱 Processing push notification: ${type} for user ${user_id}`);
  
  try {
    await PushNotificationService.sendForNotification({
      id: notification_id,
      user_id,
      type,
      data: notificationData,
      is_read: false,
    });
    
    logger.info(`✅ Push notification sent: ${type} to user ${user_id}`);
  } catch (error) {
    logger.error(`❌ Failed to send push notification: ${notification_id}`, error);
    throw error; // BullMQ will retry
  }
}

