/**
 * Push Notification Service
 * Handles Web Push notifications for PWA (iOS 16.4+, Android, Desktop)
 * 
 * Uses VAPID (Voluntary Application Server Identification) for authentication
 */

import webPush, { PushSubscription } from 'web-push';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { getFullAvatarUrl } from '../utils/urlUtils.js';
import config from '../config/index.js';

/**
 * Custom emojis (e.g. `:xp:`) cannot be rendered as images inside a Web Push
 * notification title/body - the OS only paints plain text. Strip shortcodes
 * so the username reads "Poring" instead of "Poring :xp:".
 */
function stripEmojiShortcodes(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/:[a-zA-Z0-9_+-]+(?:@[a-zA-Z0-9.-]+)?:/g, '').replace(/\s+/g, ' ').trim();
}

// Get admin client instance
const supabaseAdmin = getSupabaseClient();

// Types for push notification payloads
export interface PushPayload {
  title: string;
  message?: string;
  body?: string;
  type: string;
  data?: Record<string, any>;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
}

export interface PushSubscriptionData {
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  push_enabled: boolean;
  push_offline_only: boolean;
}

// Maps notification types to the notification_preferences column that controls
// whether push is sent. Types not listed here fall through to the global
// push_notifications toggle only.
const NOTIFICATION_TYPE_PREFERENCES: Record<string, { enabled: string; desktop?: string }> = {
  mention: { enabled: 'push_mentions' },
  dm: { enabled: 'push_dms' },
  reply: { enabled: 'desktop_replies' },
  reaction: { enabled: 'desktop_reactions' },
  voice_channel_activity: { enabled: 'sound_voice_activity' },
  server_invite: { enabled: 'push_notifications' },
  friend_request: { enabled: 'push_notifications' },
  server_update: { enabled: 'push_notifications' },
  activitypub_follow: { enabled: 'activitypub_follows' },
  activitypub_favorite: { enabled: 'activitypub_favorites' },
  activitypub_reaction: { enabled: 'activitypub_favorites' },
  activitypub_reblog: { enabled: 'activitypub_reblogs' },
  activitypub_mention: { enabled: 'activitypub_mentions' },
  activitypub_reply: { enabled: 'activitypub_replies' },
  activitypub_follow_request: { enabled: 'activitypub_follow_requests' },
};

class PushNotificationServiceClass {
  private isInitialized = false;

  /**
   * Initialize VAPID keys for web push
   */
  initialize(): boolean {
    if (this.isInitialized) {
      return true;
    }

    const publicKey = config.VAPID_PUBLIC_KEY;
    const privateKey = config.VAPID_PRIVATE_KEY;
    const subject = config.VAPID_SUBJECT;

    if (!publicKey || !privateKey || !subject) {
      logger.warn('⚠️ Push notifications disabled: VAPID keys not configured');
      logger.info('💡 Generate keys with: npx web-push generate-vapid-keys');
      return false;
    }

    try {
      webPush.setVapidDetails(
        `mailto:${subject}`,
        publicKey,
        privateKey
      );
      
      this.isInitialized = true;
      logger.info('✅ Push notification service initialized');
      return true;
    } catch (error) {
      logger.error('❌ Failed to initialize push notification service:', error);
      return false;
    }
  }

  /**
   * Check if push notifications are available
   */
  isAvailable(): boolean {
    return this.isInitialized;
  }

  /**
   * Get the VAPID public key for frontend subscription
   */
  getPublicKey(): string | null {
    return config.VAPID_PUBLIC_KEY || null;
  }

  /**
   * Save a push subscription for a user
   */
  async saveSubscription(
    userId: string,
    subscription: PushSubscription,
    userAgent?: string,
    deviceName?: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { endpoint, keys } = subscription;
      
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return { success: false, error: 'Invalid subscription data' };
      }

      // Clean up old subscriptions from the same browser/device
      // This handles the case where site data was cleared but old subscription exists
      // We identify "same device" by matching user_agent
      if (userAgent) {
        const { data: existingSubs } = await supabaseAdmin
          .from('push_subscriptions')
          .select('id, endpoint')
          .eq('user_id', userId)
          .eq('user_agent', userAgent)
          .neq('endpoint', endpoint);
        
        if (existingSubs && existingSubs.length > 0) {
          logger.info(`🧹 Cleaning up ${existingSubs.length} old subscription(s) from same device for user ${userId}`);
          
          // Delete old subscriptions from same device
          const oldIds = existingSubs.map(s => s.id);
          await supabaseAdmin
            .from('push_subscriptions')
            .delete()
            .in('id', oldIds);
        }
      }

      const { error } = await supabaseAdmin
        .from('push_subscriptions')
        .upsert({
          user_id: userId,
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          user_agent: userAgent,
          device_name: deviceName,
          failure_count: 0,
          last_failure_at: null,
          last_failure_reason: null,
        }, {
          onConflict: 'user_id,endpoint'
        });

      if (error) {
        logger.error('Failed to save push subscription:', error);
        return { success: false, error: error.message };
      }

      logger.info(`✅ Push subscription saved for user ${userId}`);
      return { success: true };
    } catch (error) {
      logger.error('Error saving push subscription:', error);
      return { success: false, error: 'Internal server error' };
    }
  }

  /**
   * Remove a push subscription
   */
  async removeSubscription(
    userId: string,
    endpoint: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { error } = await supabaseAdmin
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('endpoint', endpoint);

      if (error) {
        logger.error('Failed to remove push subscription:', error);
        return { success: false, error: error.message };
      }

      logger.info(`✅ Push subscription removed for user ${userId}`);
      return { success: true };
    } catch (error) {
      logger.error('Error removing push subscription:', error);
      return { success: false, error: 'Internal server error' };
    }
  }

  /**
   * Remove subscription by endpoint (for 410 Gone responses)
   */
  async removeSubscriptionByEndpoint(endpoint: string): Promise<void> {
    try {
      await supabaseAdmin.rpc('delete_push_subscription_by_endpoint', {
        p_endpoint: endpoint
      });
      logger.info('🗑️ Removed stale push subscription');
    } catch (error) {
      logger.error('Error removing subscription by endpoint:', error);
    }
  }

  /**
   * Get all subscriptions for a user
   */
  async getUserSubscriptions(userId: string): Promise<PushSubscriptionData[]> {
    try {
      const { data, error } = await supabaseAdmin
        .rpc('get_user_push_subscriptions', { p_user_id: userId });

      if (error) {
        logger.error('Failed to get user subscriptions:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('Error getting user subscriptions:', error);
      return [];
    }
  }

  /**
   * Send push notification to a specific subscription
   */
  async sendToSubscription(
    subscriptionData: PushSubscriptionData,
    payload: PushPayload
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.isInitialized) {
      logger.warn('⚠️ sendToSubscription called but push service not initialized (VAPID keys missing?)');
      return { success: false, error: 'Push service not initialized' };
    }

    const subscription: PushSubscription = {
      endpoint: subscriptionData.endpoint,
      keys: {
        p256dh: subscriptionData.p256dh,
        auth: subscriptionData.auth
      }
    };

    try {
      await webPush.sendNotification(
        subscription,
        JSON.stringify(payload),
        {
          TTL: 86400, // 24 hours
          urgency: 'high' as const,
        }
      );

      // Record success
      await supabaseAdmin.rpc('record_push_success', {
        p_subscription_id: subscriptionData.subscription_id
      });

      logger.debug(`Push sent successfully to ${subscriptionData.endpoint.substring(0, 50)}...`);
      return { success: true };
    } catch (error: unknown) {
      const statusCode = (error as any)?.statusCode;
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (statusCode === 410 || statusCode === 404) {
        logger.info('📱 Push subscription expired, removing...');
        await this.removeSubscriptionByEndpoint(subscriptionData.endpoint);
        return { success: false, error: 'Subscription expired' };
      }

      await supabaseAdmin.rpc('record_push_failure', {
        p_subscription_id: subscriptionData.subscription_id,
        p_reason: message
      });

      logger.error('Push notification failed:', error);
      return { success: false, error: message };
    }
  }

  /**
   * Send push notification to all of a user's devices
   */
  async sendToUser(
    userId: string,
    payload: PushPayload,
    options?: {
      respectOfflineOnly?: boolean;
      isUserOnline?: boolean;
    }
  ): Promise<{ sent: number; failed: number }> {
    if (!this.isInitialized) {
      logger.warn('⚠️ sendToUser called but push service not initialized (VAPID keys missing?)');
      return { sent: 0, failed: 0 };
    }

    const subscriptions = await this.getUserSubscriptions(userId);
    
    if (subscriptions.length === 0) {
      logger.debug(`No push subscriptions found for user ${userId}`);
      return { sent: 0, failed: 0 };
    }

    const eligible = subscriptions.filter(sub => {
      if (!sub.push_enabled) return false;
      if (options?.respectOfflineOnly && sub.push_offline_only && options?.isUserOnline) return false;
      return true;
    });

    if (eligible.length === 0) {
      return { sent: 0, failed: 0 };
    }

    const results = await Promise.allSettled(
      eligible.map(sub => this.sendToSubscription(sub, payload))
    );

    let sent = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) sent++;
      else failed++;
    }

    logger.info(`📬 Push notifications: ${sent} sent, ${failed} failed for user ${userId}`);
    return { sent, failed };
  }

  /**
   * Check if user has any active sessions (Discord-like smart push)
   * Returns true if user is actively using the app on any device
   */
  async hasActiveSession(userId: string): Promise<boolean> {
    try {
      const { data, error } = await supabaseAdmin
        .rpc('has_active_session', { p_user_id: userId });

      if (error) {
        logger.error('Error checking active sessions:', error);
        return false; // Default to sending push if we can't check
      }

      return data === true;
    } catch (error) {
      logger.error('Error in hasActiveSession:', error);
      return false;
    }
  }

  /**
   * Check if user is viewing the specific context of the notification
   * (e.g., they're looking at the channel where the message was sent)
   */
  async isUserViewingContext(
    userId: string,
    serverId?: string,
    channelId?: string,
    conversationId?: string
  ): Promise<boolean> {
    try {
      const { data, error } = await supabaseAdmin
        .rpc('is_user_viewing_push_context', {
          p_user_id: userId,
          p_server_id: serverId || null,
          p_channel_id: channelId || null,
          p_conversation_id: conversationId || null
        });

      if (error) {
        logger.error('Error checking view context:', error);
        return false;
      }

      return data === true;
    } catch (error) {
      logger.error('Error in isUserViewingContext:', error);
      return false;
    }
  }

  /**
   * Send push notification for a database notification
   * This is called when a new notification is created in the notifications table
   * 
   * Smart behavior (Discord-like):
   * - If user has active session AND push_offline_only is true → don't send
   * - If user is viewing the exact context of notification → don't send
   * - Otherwise → send push
   */
  async sendForNotification(notification: {
    id: string;
    user_id: string;
    type: string;
    data: Record<string, any>;
    title?: string;
  }): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      // Check user's notification preferences
      const { data: prefs } = await supabaseAdmin
        .from('notification_preferences')
        .select('push_notifications, push_offline_only, push_mentions, push_dms')
        .eq('user_id', notification.user_id)
        .maybeSingle();

      // Check if push is enabled for this notification type
      if (prefs && !prefs.push_notifications) {
        logger.debug('Push notifications disabled for user');
        return;
      }

      // Check type-specific preference
      const typePref = NOTIFICATION_TYPE_PREFERENCES[notification.type];
      if (typePref && prefs && !prefs[typePref.enabled as keyof typeof prefs]) {
        logger.debug(`Push disabled for notification type: ${notification.type}`);
        return;
      }

      // Extract context from notification data
      const data = notification.data || {};
      const serverId = data.server_id || data.location?.server_id;
      const channelId = data.channel_id || data.location?.channel_id;
      const conversationId = data.conversation_id || data.conversation?.id;

      // Check if user is viewing this exact context
      // Don't send push if they're already looking at the channel/conversation
      if (serverId || channelId || conversationId) {
        const isViewingContext = await this.isUserViewingContext(
          notification.user_id,
          serverId,
          channelId,
          conversationId
        );

        if (isViewingContext) {
          logger.debug(`📱 Skipping push - user is viewing the notification context`);
          return;
        }
      }

      // Check if user has active session (Discord-like behavior)
      const hasActiveSession = await this.hasActiveSession(notification.user_id);
      
      // If push_offline_only is enabled and user has active session, skip
      if (prefs?.push_offline_only && hasActiveSession) {
        logger.debug(`📱 Skipping push - user has active session and offline-only is enabled`);
        return;
      }

      // Enrich notification data with sender profile if missing
      // Database stores from_user_id but not full sender profile
      logger.debug(`📬 Enriching notification type=${notification.type}, data keys: ${Object.keys(data).join(', ')}`);
      logger.debug(`📬 from_user_id=${data.from_user_id}, user_id=${data.user_id}, sender=${JSON.stringify(data.sender)}`);
      
      if (data.from_user_id && !data.sender) {
        logger.debug(`📬 Looking up sender by from_user_id: ${data.from_user_id}`);
        const { data: senderProfile, error: senderError } = await supabaseAdmin
          .from('profiles')
          .select('id, username, display_name, avatar_url, domain, is_local')
          .eq('id', data.from_user_id)
          .single();

        if (senderError) {
          logger.warn(`📬 Failed to fetch sender profile: ${senderError.message}`);
        }

        if (senderProfile) {
          notification.data = {
            ...notification.data,
            sender: senderProfile
          };
          logger.debug(`📬 Enriched notification with sender: ${senderProfile.username}`);
        }
      }

      // Also check user_id field in data (for reactions)
      // notification.user_id = recipient, data.user_id = reactor
      if (data.user_id && !notification.data.sender && data.user_id !== notification.user_id) {
        logger.debug(`📬 Looking up reactor by user_id: ${data.user_id} (recipient: ${notification.user_id})`);
        const { data: reactorProfile, error: reactorError } = await supabaseAdmin
          .from('profiles')
          .select('id, username, display_name, avatar_url, domain, is_local')
          .eq('id', data.user_id)
          .single();

        if (reactorError) {
          logger.warn(`📬 Failed to fetch reactor profile: ${reactorError.message}`);
        }

        if (reactorProfile) {
          notification.data = {
            ...notification.data,
            sender: reactorProfile
          };
          logger.debug(`📬 Enriched notification with reactor: ${reactorProfile.username}`);
        }
      } else if (data.user_id && data.user_id === notification.user_id) {
        logger.debug(`📬 Skipping reactor lookup - user_id equals notification.user_id (self-reaction?)`);
      }

      // Enrich emoji data for reactions if only emoji_id is provided
      if (data.emoji_id && !notification.data.reaction?.emoji_name) {
        logger.debug(`📬 Looking up emoji by emoji_id: ${data.emoji_id}`);
        const { data: emoji, error: emojiError } = await supabaseAdmin
          .from('emojis')
          .select('id, name, url')
          .eq('id', data.emoji_id)
          .single();

        if (emojiError) {
          logger.warn(`📬 Failed to fetch emoji: ${emojiError.message}`);
        }

        if (emoji) {
          notification.data = {
            ...notification.data,
            reaction: {
              ...notification.data.reaction,
              emoji_name: emoji.name,
              emoji_url: emoji.url
            }
          };
          logger.debug(`📬 Enriched notification with emoji: ${emoji.name}`);
        }
      }
      
      logger.debug(`📬 Final notification.data.sender: ${JSON.stringify(notification.data.sender)}`);
      logger.debug(`📬 Final notification.data.reaction: ${JSON.stringify(notification.data.reaction)}`);

      // Build payload from notification data
      const payload = this.buildPayloadFromNotification(notification);

      await this.sendToUser(notification.user_id, payload, {
        respectOfflineOnly: false, // Already checked above
        isUserOnline: hasActiveSession
      });

      logger.info(`📬 Push sent for ${notification.type} to user ${notification.user_id}`);
    } catch (error) {
      logger.error('Error sending push for notification:', error);
    }
  }

  /**
   * Extract content preview from various message formats
   * Handles JSON strings, MessagePart[] arrays, and plain strings
   */
  private extractContentPreview(data: Record<string, any>, maxLength = 100): string {
    // Try structured content_preview first
    let preview = data.message?.content_preview || data.content_preview || data.preview;
    
    // If no preview, try to extract from content
    if (!preview) {
      let content = data.message?.content || data.content;
      
      // Parse JSON string if needed
      if (typeof content === 'string' && content.startsWith('[')) {
        try {
          content = JSON.parse(content);
        } catch (e) {
          // Use string as-is if parsing fails
          preview = content;
        }
      }
      
      // Convert MessagePart[] to plain text
      if (Array.isArray(content)) {
        preview = content
          .map((part: any) => {
            if (part.type === 'text') return part.text;
            if (part.type === 'mention') return `@${part.username}${part.domain ? '@' + part.domain : ''}`;
            if (part.type === 'emoji') return `:${part.emoji?.name || part.emoji}:`;
            if (part.type === 'url') return part.url;
            if (part.type === 'hashtag') return `#${part.name}`;
            return '';
          })
          .join('')
          .trim();
      }
    }
    
    // Truncate if needed
    if (preview && preview.length > maxLength) {
      preview = preview.substring(0, maxLength) + '...';
    }
    
    return preview || '';
  }

  /**
   * Build push payload from notification data
   */
  private buildPayloadFromNotification(notification: {
    id: string;
    user_id: string;
    type: string;
    data: Record<string, any>;
    title?: string;
  }): PushPayload {
    const data = notification.data || {};
    const sender = data.sender || {};
    const rawSenderName = sender.display_name || sender.username || 'Someone';
    const senderName = stripEmojiShortcodes(rawSenderName) || sender.username || 'Someone';
    const senderDomain = sender.domain && !sender.is_local ? `@${sender.domain}` : '';

    let title = notification.title || 'Harmony';
    let message = '';
    // Resolve the sender's avatar to a full https URL. Stored avatar_url may be
    // a relative storage path (e.g. `<uuid>/avatar.webp`) which Chrome/Android
    // would treat as same-origin and 404 on, falling back to a generated
    // initial-letter circle. Use a full URL so the OS shows the real avatar
    // for every user-originated notification (DM, mention, reply, reaction,
    // follow, ActivityPub, etc.).
    const resolvedAvatar = getFullAvatarUrl(sender.avatar_url) || sender.avatar_url;
    const icon = resolvedAvatar || '/img/app_icon_square.webp';

    switch (notification.type) {
      case 'mention':
        title = `${senderName}${senderDomain} mentioned you`;
        message = this.extractContentPreview(data) || 'You were mentioned in a message';
        break;
      
      case 'dm':
        title = `${senderName}${senderDomain} sent you a message`;
        message = this.extractContentPreview(data) || 'New direct message';
        break;
      
      case 'reply':
        title = `${senderName}${senderDomain} replied to you`;
        message = this.extractContentPreview(data) || 'New reply';
        break;
      
      case 'reaction':
        title = `${senderName}${senderDomain} reacted to your message`;
        message = data.reaction?.emoji_name || '❤️';
        break;
      
      case 'friend_request':
        title = 'New friend request';
        message = `${senderName}${senderDomain} wants to be your friend`;
        break;
      
      case 'server_invite':
        title = 'Server invitation';
        message = `You've been invited to ${data.server?.name || 'a server'}`;
        break;
      
      case 'activitypub_follow':
        title = 'New follower';
        message = `${senderName}${senderDomain} started following you`;
        break;
      
      case 'activitypub_favorite':
        title = `${senderName}${senderDomain} liked your post`;
        message = this.extractContentPreview({ content_preview: data.post_content || data.post?.content_preview }) || 'Your post was liked';
        break;
      
      case 'activitypub_reblog':
        title = `${senderName}${senderDomain} boosted your post`;
        message = this.extractContentPreview({ content_preview: data.post_content || data.post?.content_preview }) || 'Your post was boosted';
        break;
      
      case 'activitypub_mention':
        title = `${senderName}${senderDomain} mentioned you`;
        message = this.extractContentPreview({ content_preview: data.post?.content_preview || data.post_content }) || 'You were mentioned in a post';
        break;
      
      case 'activitypub_reply':
        title = `${senderName}${senderDomain} replied to you`;
        message = this.extractContentPreview({ content_preview: data.post?.content_preview || data.post_content }) || 'New reply to your post';
        break;
      
      case 'activitypub_follow_request':
        title = 'New follow request';
        message = `${senderName}${senderDomain} wants to follow you`;
        break;
      
      case 'activitypub_reaction':
        title = `${senderName}${senderDomain} reacted to your post`;
        message = data.reaction?.emoji_name || data.reaction?.custom_emoji_content || '👍';
        break;
      
      default:
        // For unknown types, try to extract meaningful content
        title = notification.title || 'New notification';
        message = this.extractContentPreview(data) || 'You have a new notification';
    }

    const conversationId = data.conversation_id || data.conversation?.id;
    const channelId = data.channel_id || data.location?.channel_id;
    const tag = conversationId
      ? `harmony-${notification.type}-conv-${conversationId}`
      : channelId
        ? `harmony-${notification.type}-ch-${channelId}`
        : `harmony-${notification.type}-${notification.id}`;

    return {
      title,
      message,
      body: message,
      type: notification.type,
      icon,
      badge: '/img/app_icon_square.webp',
      tag,
      requireInteraction: ['mention', 'dm', 'activitypub_mention'].includes(notification.type),
      data: {
        notification_id: notification.id,
        user_id: notification.user_id,
        ...data,
        avatar_url: resolvedAvatar || undefined,
      }
    };
  }

  /**
   * Cleanup stale subscriptions
   */
  async cleanupStaleSubscriptions(): Promise<number> {
    try {
      const { data, error } = await supabaseAdmin
        .rpc('cleanup_stale_push_subscriptions');

      if (error) {
        logger.error('Failed to cleanup stale subscriptions:', error);
        return 0;
      }

      if (data > 0) {
        logger.info(`🧹 Cleaned up ${data} stale push subscriptions`);
      }
      
      return data || 0;
    } catch (error) {
      logger.error('Error cleaning up subscriptions:', error);
      return 0;
    }
  }
}

export const PushNotificationService = new PushNotificationServiceClass();

