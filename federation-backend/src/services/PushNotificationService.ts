/**
 * Push delivery to every transport in push_subscriptions.
 *
 *   webpush      browsers and PWAs; VAPID Web Push, service worker payload.
 *   unifiedpush  the Android app through a UnifiedPush distributor; VAPID Web Push, app payload.
 *   fcm          the Android app through Firebase Cloud Messaging; FCM HTTP v1, app payload.
 *
 * Web Push transports need the VAPID keys, fcm needs the service account. A transport
 * without its credentials is skipped.
 */

import webPush, { PushSubscription } from 'web-push';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { getFullAvatarUrl, getFullServerIconUrl } from '../utils/urlUtils.js';
import config from '../config/index.js';
import { FcmSender, loadServiceAccount } from './FcmSender.js';
import { validateExternalUrl, validateResolvedAddress } from '../utils/ssrfProtection.js';
import {
  APP_TRANSPORTS,
  PROFILE_STATUS_BUSY,
  type PushTransport,
  appPushData,
  clip,
  compactPushData,
  dismissalMessages,
  isValidFcmToken,
  isWithinQuietHours,
  pushAllowedForType,
  securityNoticeText,
  moveNoticeText,
} from './pushPolicy.js';

/**
 * Custom emojis (e.g. `:xp:`) cannot be rendered as images inside a Web Push
 * notification title/body - the OS only paints plain text. Strip shortcodes
 * so the username reads "Poring" instead of "Poring :xp:".
 */
function stripEmojiShortcodes(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/:[a-zA-Z0-9_+-]+(?:@[a-zA-Z0-9.-]+)?:/g, '').replace(/\s+/g, ' ').trim();
}

const supabaseAdmin = getSupabaseClient();

// Matches the preview redact_encrypted_notification_preview() writes.
const ENCRYPTED_MESSAGE_PREVIEW = 'Encrypted message';

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
  p256dh: string | null;
  auth: string | null;
  push_enabled: boolean;
  push_offline_only: boolean;
  /** Absent before migration 20261004100001, which means webpush. */
  transport?: PushTransport | null;
}

type AppDataBuilder = () => Promise<Record<string, string>> | Record<string, string>;

const MAX_ENDPOINT_LENGTH = 2048;
const PUSH_TTL_S = 86400;

function isValidSubscription(subscription: any): subscription is PushSubscription {
  return (
    typeof subscription?.endpoint === 'string' &&
    /^https:\/\//.test(subscription.endpoint) &&
    subscription.endpoint.length <= MAX_ENDPOINT_LENGTH &&
    typeof subscription.keys?.p256dh === 'string' &&
    typeof subscription.keys?.auth === 'string'
  );
}

// Endpoint hosts that passed the address check, with expiry (ms since epoch).
const allowedEndpointHosts = new Map<string, number>();
const ENDPOINT_HOST_TTL_MS = 5 * 60_000;

/**
 * Web Push and UnifiedPush endpoints are client-supplied URLs the server POSTs to.
 * Refuses loopback, private and link-local targets by literal and by DNS, at
 * registration and again before each send (the name can be re-pointed later).
 */
export async function assertPushEndpointAllowed(endpoint: string): Promise<void> {
  if (config.PUSH_ALLOW_PRIVATE_ENDPOINTS) return;
  const url = validateExternalUrl(endpoint);
  if (url.protocol !== 'https:') throw new Error(`Blocked protocol: ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  const until = allowedEndpointHosts.get(host);
  if (until && until > Date.now()) return;
  await validateResolvedAddress(host.replace(/^\[|\]$/g, ''));
  allowedEndpointHosts.set(host, Date.now() + ENDPOINT_HOST_TTL_MS);
}

const transportOf = (sub: Pick<PushSubscriptionData, 'transport'>): PushTransport => sub.transport ?? 'webpush';
const isAppTransport = (sub: Pick<PushSubscriptionData, 'transport'>): boolean =>
  APP_TRANSPORTS.includes(transportOf(sub));

class PushNotificationServiceClass {
  private isInitialized = false;
  private fcm: FcmSender | null = null;

  /** FCM client from FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE; unconfigured without either. */
  getFcmSender(): FcmSender {
    if (!this.fcm) {
      this.fcm = new FcmSender({
        account: loadServiceAccount({ json: config.FCM_SERVICE_ACCOUNT_JSON, file: config.FCM_SERVICE_ACCOUNT_FILE }),
      });
      if (this.fcm.isConfigured()) logger.info(`FCM enabled for project ${this.fcm.projectId()}`);
      else logger.info('FCM disabled: no service account configured');
    }
    return this.fcm;
  }

  setFcmSender(sender: FcmSender | null): void {
    this.fcm = sender;
  }

  isFcmConfigured(): boolean {
    return this.getFcmSender().isConfigured();
  }

  private canDeliver(sub: Pick<PushSubscriptionData, 'transport'>): boolean {
    return transportOf(sub) === 'fcm' ? this.isFcmConfigured() : this.isInitialized;
  }

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
      logger.warn('Push notifications disabled: VAPID keys not configured');
      logger.info('Generate keys with: npx web-push generate-vapid-keys');
      return false;
    }

    try {
      webPush.setVapidDetails(
        `mailto:${subject}`,
        publicKey,
        privateKey
      );
      
      this.isInitialized = true;
      logger.info('Push notification service initialized');
      return true;
    } catch (error) {
      logger.error('Failed to initialize push notification service:', error);
      return false;
    }
  }

  /**
   * Check if push notifications are available
   */
  isAvailable(): boolean {
    return this.isInitialized || this.isFcmConfigured();
  }

  /**
   * Get the VAPID public key for frontend subscription
   */
  getPublicKey(): string | null {
    return config.VAPID_PUBLIC_KEY || null;
  }

  /**
   * Registers this browser's subscription for userId.
   *
   * An endpoint belongs to one browser profile, so rows holding it with the same auth
   * secret for another account are removed: a shared browser must not keep receiving the
   * previous account's pushes. The secret match keeps a caller who knows only the endpoint
   * URL from detaching another account's device.
   * previousEndpoint is the endpoint the same browser registered before a rotation or a
   * VAPID key change; only that row is replaced. Other devices of the user are untouched,
   * whatever their user agent.
   */
  async saveSubscription(
    userId: string,
    subscription: PushSubscription,
    userAgent?: string,
    deviceName?: string,
    previousEndpoint?: string | null,
    transport: 'webpush' | 'unifiedpush' = 'webpush',
    sessionId: string | null = null
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!isValidSubscription(subscription)) {
        return { success: false, error: 'Invalid subscription data' };
      }
      const { endpoint, keys } = subscription;
      try {
        await assertPushEndpointAllowed(endpoint);
      } catch (error) {
        logger.warn(`Push endpoint refused: ${error instanceof Error ? error.message : error}`);
        return { success: false, error: 'Endpoint not allowed' };
      }

      const { error: claimError } = await supabaseAdmin
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint)
        .eq('auth', keys.auth)
        .neq('user_id', userId);
      if (claimError) {
        logger.warn('Failed to release endpoint from other accounts:', claimError);
      }

      if (previousEndpoint && previousEndpoint !== endpoint) {
        const { error: replaceError } = await supabaseAdmin
          .from('push_subscriptions')
          .delete()
          .eq('user_id', userId)
          .eq('endpoint', previousEndpoint);
        if (replaceError) {
          logger.warn('Failed to remove replaced push subscription:', replaceError);
        }
      }

      const { error } = await supabaseAdmin
        .from('push_subscriptions')
        .upsert({
          user_id: userId,
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          transport,
          user_agent: userAgent,
          device_name: deviceName,
          session_id: sessionId,
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

      logger.info(`Push subscription (${transport}) saved for user ${userId}`);
      return { success: true };
    } catch (error) {
      logger.error('Error saving push subscription:', error);
      return { success: false, error: 'Internal server error' };
    }
  }

  /**
   * Registers this installation's FCM token for userId. A token names one installation, so
   * rows holding it for other accounts are removed first: the device now belongs to whoever
   * signed in last. previousToken is the token the same installation registered before a
   * refresh; only that row is replaced.
   */
  async saveFcmToken(
    userId: string,
    token: string,
    opts: { previousToken?: string | null; userAgent?: string; deviceName?: string; sessionId?: string | null } = {}
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!isValidFcmToken(token)) return { success: false, error: 'Invalid token' };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { error: claimError } = await supabaseAdmin
          .from('push_subscriptions')
          .delete()
          .eq('transport', 'fcm')
          .eq('endpoint', token)
          .neq('user_id', userId);
        if (claimError) logger.warn('Failed to release FCM token from other accounts:', claimError);

        if (opts.previousToken && opts.previousToken !== token) {
          const { error: replaceError } = await supabaseAdmin
            .from('push_subscriptions')
            .delete()
            .eq('user_id', userId)
            .eq('transport', 'fcm')
            .eq('endpoint', opts.previousToken);
          if (replaceError) logger.warn('Failed to remove replaced FCM token:', replaceError);
        }

        const { data, error } = await supabaseAdmin
          .from('push_subscriptions')
          .upsert({
            user_id: userId,
            endpoint: token,
            p256dh: null,
            auth: null,
            transport: 'fcm',
            user_agent: opts.userAgent,
            device_name: opts.deviceName,
            session_id: opts.sessionId ?? null,
            failure_count: 0,
            last_failure_at: null,
            last_failure_reason: null,
          }, { onConflict: 'user_id,endpoint' })
          .select('id')
          .maybeSingle();

        // 23505: another account registered the same token between the claim and the upsert.
        if (error?.code === '23505' && attempt === 0) continue;
        if (error) {
          logger.error('Failed to save FCM token:', error);
          return { success: false, error: error.message };
        }
        logger.info(`FCM token saved for user ${userId}`);
        return { success: true, id: data?.id };
      }
      return { success: false, error: 'Token is being registered concurrently' };
    } catch (error) {
      logger.error('Error saving FCM token:', error);
      return { success: false, error: 'Internal server error' };
    }
  }

  /** Removes this account's row for the token; other accounts are untouched. */
  async removeFcmToken(userId: string, token: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { error } = await supabaseAdmin
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('transport', 'fcm')
        .eq('endpoint', token);
      if (error) {
        logger.error('Failed to remove FCM token:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (error) {
      logger.error('Error removing FCM token:', error);
      return { success: false, error: 'Internal server error' };
    }
  }

  /**
   * Replaces a subscription the browser rotated (pushsubscriptionchange). The service
   * worker holds no session, so the old endpoint together with its auth secret, known
   * only to that browser and this server, identifies the row.
   */
  async rotateSubscription(
    oldEndpoint: string,
    oldAuth: string,
    subscription: PushSubscription
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!oldEndpoint || !oldAuth || !isValidSubscription(subscription)) {
        return { success: false, error: 'Invalid subscription data' };
      }

      const { data: rows, error: lookupError } = await supabaseAdmin
        .from('push_subscriptions')
        .select('id, user_id, user_agent, device_name, session_id')
        .eq('endpoint', oldEndpoint)
        .eq('auth', oldAuth)
        .order('updated_at', { ascending: false })
        .limit(1);
      if (lookupError) {
        logger.error('Push rotation lookup failed:', lookupError);
        return { success: false, error: 'Lookup failed' };
      }
      const row = rows?.[0];
      if (!row) {
        return { success: false, error: 'Unknown subscription' };
      }

      const result = await this.saveSubscription(
        row.user_id,
        subscription,
        row.user_agent ?? undefined,
        row.device_name ?? undefined,
        oldEndpoint,
        'webpush',
        row.session_id ?? null
      );
      if (result.success) logger.info('Push subscription rotated by the service worker');
      return result;
    } catch (error) {
      logger.error('Error rotating push subscription:', error);
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

      logger.info(`Push subscription removed for user ${userId}`);
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
      logger.info('Removed stale push subscription');
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
   * Sends to one target. payload is what a service worker renders; app is the Android
   * payload, derived from payload when omitted.
   */
  async sendToSubscription(
    subscriptionData: PushSubscriptionData,
    payload: PushPayload,
    app?: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    const transport = transportOf(subscriptionData);
    if (!this.canDeliver(subscriptionData)) {
      logger.warn(`sendToSubscription: ${transport} is not configured`);
      return { success: false, error: 'Push service not initialized' };
    }
    const body = transport === 'webpush'
      ? JSON.stringify(payload)
      : JSON.stringify(app ?? this.appDataFromPayload(payload));
    return this.deliver(subscriptionData, body, { urgent: true, recordSuccess: true });
  }

  /**
   * One message to one target. body is the Web Push plaintext; FCM receives the same
   * object as its data map.
   */
  private async deliver(
    sub: PushSubscriptionData,
    body: string,
    opts: { urgent: boolean; recordSuccess: boolean; collapseKey?: string }
  ): Promise<{ success: boolean; error?: string }> {
    const transport = transportOf(sub);
    if (transport === 'fcm') {
      const result = await this.getFcmSender().send(sub.endpoint, JSON.parse(body), {
        priority: opts.urgent ? 'high' : 'normal',
        ttlSeconds: PUSH_TTL_S,
        collapseKey: opts.collapseKey,
      });
      if (result.ok) {
        if (opts.recordSuccess) {
          await supabaseAdmin.rpc('record_push_success', { p_subscription_id: sub.subscription_id });
        }
        return { success: true };
      }
      if (result.prune) {
        logger.info(`FCM token rejected (${result.reason}), removing`);
        await supabaseAdmin.from('push_subscriptions').delete().eq('id', sub.subscription_id);
        return { success: false, error: 'Subscription expired' };
      }
      await supabaseAdmin.rpc('record_push_failure', {
        p_subscription_id: sub.subscription_id,
        p_reason: result.reason,
      });
      logger.error(`FCM send failed: ${result.reason}`);
      return { success: false, error: result.reason };
    }

    const subscription: PushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh ?? '', auth: sub.auth ?? '' },
    };
    try {
      await assertPushEndpointAllowed(sub.endpoint);
    } catch (error) {
      const reason = `Endpoint not allowed: ${error instanceof Error ? error.message : error}`;
      logger.warn(reason);
      await supabaseAdmin.rpc('record_push_failure', { p_subscription_id: sub.subscription_id, p_reason: reason });
      return { success: false, error: 'Endpoint not allowed' };
    }
    try {
      await webPush.sendNotification(subscription, body, {
        TTL: PUSH_TTL_S,
        urgency: opts.urgent ? 'high' : 'normal',
      });
      if (opts.recordSuccess) {
        await supabaseAdmin.rpc('record_push_success', { p_subscription_id: sub.subscription_id });
      }
      logger.debug(`Push sent (${transport}) to ${sub.endpoint.substring(0, 50)}...`);
      return { success: true };
    } catch (error: unknown) {
      const statusCode = (error as any)?.statusCode;
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (statusCode === 410 || statusCode === 404) {
        logger.info('Push subscription expired, removing...');
        await this.removeSubscriptionByEndpoint(sub.endpoint);
        return { success: false, error: 'Subscription expired' };
      }

      await supabaseAdmin.rpc('record_push_failure', {
        p_subscription_id: sub.subscription_id,
        p_reason: message
      });

      logger.error('Push notification failed:', error);
      return { success: false, error: message };
    }
  }

  /** Android payload derived from a service worker payload, for sends that have nothing richer. */
  private appDataFromPayload(payload: PushPayload): Record<string, string> {
    const data = payload.data || {};
    return appPushData({
      notificationId: String(data.notification_id || payload.tag || `local-${Date.now()}`),
      type: payload.type,
      data,
      title: payload.title,
      body: payload.body || payload.message || '',
      avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : null,
    });
  }

  /**
   * Sends to every eligible target of the user. app builds the Android payload; it runs
   * once, and only when an app target is eligible.
   */
  async sendToUser(
    userId: string,
    payload: PushPayload,
    options?: {
      respectOfflineOnly?: boolean;
      isUserOnline?: boolean;
    },
    app?: AppDataBuilder
  ): Promise<{ sent: number; failed: number }> {
    if (!this.isInitialized && !this.isFcmConfigured()) {
      logger.warn('sendToUser called but no push transport is configured');
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
      return this.canDeliver(sub);
    });

    if (eligible.length === 0) {
      return { sent: 0, failed: 0 };
    }

    let appData: Record<string, string> | undefined;
    if (eligible.some(isAppTransport)) {
      appData = app ? await app() : this.appDataFromPayload(payload);
    }

    const results = await Promise.allSettled(
      eligible.map(sub => this.sendToSubscription(sub, payload, appData))
    );

    let sent = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) sent++;
      else failed++;
    }

    logger.info(`Push notifications: ${sent} sent, ${failed} failed for user ${userId}`);
    return { sent, failed };
  }

  /**
   * Tells the user's Android installations to cancel notifications read or deleted
   * elsewhere. ids null cancels all of them. Browsers are skipped: Web Push requires every
   * push to show a notification.
   */
  async sendDismissal(userId: string, ids: string[] | null): Promise<{ sent: number; failed: number }> {
    const targets = (await this.getUserSubscriptions(userId))
      .filter(sub => isAppTransport(sub) && this.canDeliver(sub));
    if (targets.length === 0) return { sent: 0, failed: 0 };

    const messages = dismissalMessages(ids);
    const collapseKey = ids === null ? 'harmony-read-all' : undefined;
    const results = await Promise.allSettled(targets.flatMap(sub =>
      messages.map(message => this.deliver(sub, JSON.stringify(message), {
        urgent: false,
        recordSuccess: false,
        collapseKey,
      }))
    ));

    let sent = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) sent++;
      else failed++;
    }
    logger.debug(`Push dismissals: ${sent} sent, ${failed} failed for user ${userId}`);
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
    if (!this.isInitialized && !this.isFcmConfigured()) {
      return;
    }

    try {
      const { data: prefs } = await supabaseAdmin
        .from('notification_preferences')
        .select('*')
        .eq('user_id', notification.user_id)
        .maybeSingle();

      if (!pushAllowedForType(notification.type, prefs)) {
        logger.debug(`Push disabled by preferences for ${notification.type}`);
        return;
      }

      if (isWithinQuietHours(prefs)) {
        logger.debug('Skipping push - quiet hours');
        return;
      }

      const { data: recipient } = await supabaseAdmin
        .from('profiles')
        .select('status')
        .eq('id', notification.user_id)
        .maybeSingle();
      if (recipient?.status === PROFILE_STATUS_BUSY) {
        logger.debug('Skipping push - recipient is in Do Not Disturb');
        return;
      }

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
          logger.debug(`Skipping push - user is viewing the notification context`);
          return;
        }
      }

      const hasActiveSession = await this.hasActiveSession(notification.user_id);
      
      // push_offline_only defaults to true, as in notification_preferences. Security
      // notices push regardless: the active session may be the one they report.
      if (notification.type !== 'security' && (prefs?.push_offline_only ?? true) && hasActiveSession) {
        logger.debug(`Skipping push - user has active session and offline-only is enabled`);
        return;
      }

      // Enrich notification data with sender profile if missing
      // Database stores from_user_id but not full sender profile
      logger.debug(`Enriching notification type=${notification.type}, data keys: ${Object.keys(data).join(', ')}`);
      logger.debug(`from_user_id=${data.from_user_id}, user_id=${data.user_id}, sender=${JSON.stringify(data.sender)}`);
      
      if (data.from_user_id && !data.sender) {
        logger.debug(`Looking up sender by from_user_id: ${data.from_user_id}`);
        const { data: senderProfile, error: senderError } = await supabaseAdmin
          .from('profiles')
          .select('id, username, display_name, avatar_url, domain, is_local')
          .eq('id', data.from_user_id)
          .single();

        if (senderError) {
          logger.warn(`Failed to fetch sender profile: ${senderError.message}`);
        }

        if (senderProfile) {
          notification.data = {
            ...notification.data,
            sender: senderProfile
          };
          logger.debug(`Enriched notification with sender: ${senderProfile.username}`);
        }
      }

      // Also check user_id field in data (for reactions)
      // notification.user_id = recipient, data.user_id = reactor
      if (data.user_id && !notification.data.sender && data.user_id !== notification.user_id) {
        logger.debug(`Looking up reactor by user_id: ${data.user_id} (recipient: ${notification.user_id})`);
        const { data: reactorProfile, error: reactorError } = await supabaseAdmin
          .from('profiles')
          .select('id, username, display_name, avatar_url, domain, is_local')
          .eq('id', data.user_id)
          .single();

        if (reactorError) {
          logger.warn(`Failed to fetch reactor profile: ${reactorError.message}`);
        }

        if (reactorProfile) {
          notification.data = {
            ...notification.data,
            sender: reactorProfile
          };
          logger.debug(`Enriched notification with reactor: ${reactorProfile.username}`);
        }
      } else if (data.user_id && data.user_id === notification.user_id) {
        logger.debug(`Skipping reactor lookup - user_id equals notification.user_id (self-reaction?)`);
      }

      // Enrich emoji data for reactions if only emoji_id is provided
      if (data.emoji_id && !notification.data.reaction?.emoji_name) {
        logger.debug(`Looking up emoji by emoji_id: ${data.emoji_id}`);
        const { data: emoji, error: emojiError } = await supabaseAdmin
          .from('emojis')
          .select('id, name, url')
          .eq('id', data.emoji_id)
          .single();

        if (emojiError) {
          logger.warn(`Failed to fetch emoji: ${emojiError.message}`);
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
          logger.debug(`Enriched notification with emoji: ${emoji.name}`);
        }
      }
      
      logger.debug(`Final notification.data.sender: ${JSON.stringify(notification.data.sender)}`);
      logger.debug(`Final notification.data.reaction: ${JSON.stringify(notification.data.reaction)}`);

      const payload = this.buildPayloadFromNotification(notification);

      await this.sendToUser(notification.user_id, payload, {
        respectOfflineOnly: false, // Already checked above
        isUserOnline: hasActiveSession
      }, () => this.buildAppData(notification, payload));

      logger.info(`Push sent for ${notification.type} to user ${notification.user_id}`);
    } catch (error) {
      logger.error('Error sending push for notification:', error);
    }
  }

  /**
   * Android payload for a notification. The large icon is the server icon for server
   * notifications, as the running app shows it.
   */
  private async buildAppData(
    notification: { id: string; type: string; data: Record<string, any> },
    payload: PushPayload
  ): Promise<Record<string, string>> {
    const data = notification.data || {};
    const sender = data.sender || {};
    const senderName = stripEmojiShortcodes(sender.display_name || sender.username || data.sender_display_name || '');
    const avatarUrl = typeof payload.data?.avatar_url === 'string' ? payload.data.avatar_url : null;

    let iconUrl: string | null = null;
    const serverId = data.location?.server_id || data.server_id;
    if (serverId) {
      const { data: server } = await supabaseAdmin
        .from('servers')
        .select('icon')
        .eq('id', serverId)
        .maybeSingle();
      iconUrl = getFullServerIconUrl(server?.icon);
    }

    return appPushData({
      notificationId: notification.id,
      type: notification.type,
      data: {
        ...data,
        location: data.location && {
          ...data.location,
          server_name: stripEmojiShortcodes(data.location.server_name),
          channel_name: stripEmojiShortcodes(data.location.channel_name),
        },
        server_name: stripEmojiShortcodes(data.server_name),
        channel_name: stripEmojiShortcodes(data.channel_name),
        conversation: data.conversation && { ...data.conversation, name: stripEmojiShortcodes(data.conversation.name) },
      },
      title: payload.title,
      body: payload.body || payload.message || '',
      sender: senderName,
      avatarUrl,
      iconUrl,
    });
  }

  /**
   * Extract content preview from various message formats
   * Handles JSON strings, MessagePart[] arrays, and plain strings
   */
  private extractContentPreview(data: Record<string, any>, maxLength = 100): string {
    // redact_encrypted_notification_preview() flags notifications about an
    // encrypted message; their content fields hold ciphertext or nothing.
    if (data.encrypted === true || data.message?.encrypted === true) {
      return ENCRYPTED_MESSAGE_PREVIEW;
    }

    // Try structured content_preview first
    let preview = data.message?.content_preview || data.content_preview || data.preview;
    
    // If no preview, try to extract from content
    if (!preview) {
      let content = data.message?.content || data.content;
      
      if (typeof content === 'string' && content.startsWith('[')) {
        try {
          content = JSON.parse(content);
        } catch (e) {
          // Use string as-is if parsing fails
          preview = content;
        }
      }
      
      // A poll previews as its question; its text part spells out every answer.
      const poll = Array.isArray(content)
        ? content.find((part: any) => part?.type === 'poll' && typeof part.question === 'string')
        : undefined;
      if (poll) {
        preview = `📊 ${poll.question}`;
      } else if (Array.isArray(content)) {
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
    
    // `||spoiler||` text stays hidden on the lock screen.
    if (preview) {
      preview = String(preview).replace(/\|\|(?=\S)([\s\S]*?\S)\|\|/g, (_m: string, inner: string) =>
        '▒'.repeat(Math.min(Math.max(inner.length, 3), 12)));
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

      case 'chat_message':
        title = data.conversation?.name
          ? `${senderName}${senderDomain} in ${stripEmojiShortcodes(data.conversation.name)}`
          : `${senderName}${senderDomain} sent a message`;
        message = this.extractContentPreview(data) || 'New message';
        break;

      case 'channel_message': {
        const channelName = data.location?.channel_name || data.channel_name;
        title = channelName
          ? `${senderName}${senderDomain} in #${channelName}`
          : `${senderName}${senderDomain} sent a message`;
        message = this.extractContentPreview(data) || 'New message';
        break;
      }

      case 'reply':
        title = `${senderName}${senderDomain} replied to you`;
        message = this.extractContentPreview(data) || 'New reply';
        break;

      case 'thread_reply': {
        const channelName = data.location?.channel_name || data.channel_name;
        title = channelName
          ? `${senderName}${senderDomain} replied in a thread in #${channelName}`
          : `${senderName}${senderDomain} replied in a thread`;
        message = this.extractContentPreview(data) || 'New thread reply';
        break;
      }
      
      case 'newcomer_message': {
        const channelName = data.location?.channel_name || data.channel_name;
        title = channelName
          ? `${senderName}${senderDomain} is new here and posted in #${channelName}`
          : `${senderName}${senderDomain} is new here and posted for the first time`;
        message = this.extractContentPreview(data) || 'Say hello';
        break;
      }

      case 'reaction':
        title = `${senderName}${senderDomain} reacted to your message`;
        // A bridged Discord reaction names its emoji discord:[a:]name:id.
        message = (data.reaction?.emoji_name || '❤️').replace(/^discord:(?:a:)?([^:]+):\d+$/, ':$1:');
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

      case 'activitypub_follow_accepted':
        title = 'Follow request accepted';
        message = `${senderName}${senderDomain} accepted your follow request`;
        break;
      
      case 'activitypub_reaction':
        title = `${senderName}${senderDomain} reacted to your post`;
        message = data.reaction?.emoji_name || data.reaction?.custom_emoji_content || '👍';
        break;
      
      case 'security': {
        const notice = securityNoticeText(data);
        title = notice.title;
        message = notice.body;
        break;
      }

      case 'move': {
        const notice = moveNoticeText(data);
        title = notice.title;
        message = notice.body;
        break;
      }

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

    const body = clip(message, 240);
    return {
      title: clip(title, 120),
      message: body,
      body,
      type: notification.type,
      icon,
      badge: '/img/app_icon_square.webp',
      tag,
      requireInteraction: ['mention', 'dm', 'activitypub_mention'].includes(notification.type),
      data: compactPushData(notification.id, notification.type, data, resolvedAvatar),
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
        logger.info(`Cleaned up ${data} stale push subscriptions`);
      }
      
      return data || 0;
    } catch (error) {
      logger.error('Error cleaning up subscriptions:', error);
      return 0;
    }
  }
}

export const PushNotificationService = new PushNotificationServiceClass();

