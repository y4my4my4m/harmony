/**
 * Web Push subscription routes. Every route except vapid-key, status and resubscribe
 * acts for the local profile behind the bearer token.
 */

import { Router, Request, Response } from 'express';
import { PushNotificationService } from '../services/PushNotificationService.js';
import { getSupabaseClient } from '../config/supabase.js';
import { localProfileIdFromBearer } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const supabaseAdmin = getSupabaseClient();

const router = Router();

async function requireProfile(req: Request, res: Response): Promise<string | null> {
  const profileId = await localProfileIdFromBearer(req.headers.authorization);
  if (!profileId) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return profileId;
}

const optionalString = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

router.get('/vapid-key', (_req: Request, res: Response): void => {
  const publicKey = PushNotificationService.getPublicKey();

  if (!publicKey) {
    res.status(503).json({
      error: 'Push notifications not configured',
      message: 'VAPID keys are not set up on this server'
    });
    return;
  }

  res.json({ publicKey });
});

router.get('/status', (_req: Request, res: Response): void => {
  res.json({
    available: PushNotificationService.isAvailable(),
    configured: !!PushNotificationService.getPublicKey()
  });
});

/**
 * POST /push/subscribe
 * Body: { subscription, deviceName?, previousEndpoint? }
 * previousEndpoint is the endpoint this browser registered before, replaced by this one.
 */
router.post('/subscribe', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = await requireProfile(req, res);
    if (!userId) return;

    const { subscription } = req.body || {};
    const deviceName = optionalString(req.body?.deviceName, 120);
    const previousEndpoint = optionalString(req.body?.previousEndpoint, 2048);

    if (!subscription?.endpoint || !subscription?.keys) {
      res.status(400).json({ error: 'Invalid subscription data' });
      return;
    }

    const result = await PushNotificationService.saveSubscription(
      userId,
      subscription,
      req.headers['user-agent'],
      deviceName,
      previousEndpoint
    );

    if (!result.success) {
      const status = result.error === 'Invalid subscription data' ? 400 : 500;
      res.status(status).json({ error: result.error });
      return;
    }

    res.json({ success: true, message: 'Subscription saved' });
  } catch (error) {
    logger.error('Error in push subscribe:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /push/resubscribe
 * Body: { oldEndpoint, oldAuth, subscription }
 * Called by the service worker on pushsubscriptionchange, without a session.
 */
router.post('/resubscribe', async (req: Request, res: Response): Promise<void> => {
  try {
    const oldEndpoint = optionalString(req.body?.oldEndpoint, 2048);
    const oldAuth = optionalString(req.body?.oldAuth, 256);
    const { subscription } = req.body || {};

    if (!oldEndpoint || !oldAuth || !subscription?.endpoint || !subscription?.keys) {
      res.status(400).json({ error: 'Invalid subscription data' });
      return;
    }

    const result = await PushNotificationService.rotateSubscription(oldEndpoint, oldAuth, subscription);
    if (!result.success) {
      const status = result.error === 'Unknown subscription' ? 404
        : result.error === 'Invalid subscription data' ? 400 : 500;
      res.status(status).json({ error: result.error });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error in push resubscribe:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /push/unsubscribe
 * Body: { endpoint }
 * Removes this account's row for the endpoint; other accounts and devices are untouched.
 */
router.post('/unsubscribe', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = await requireProfile(req, res);
    if (!userId) return;

    const endpoint = optionalString(req.body?.endpoint, 2048);
    if (!endpoint) {
      res.status(400).json({ error: 'Endpoint is required' });
      return;
    }

    const result = await PushNotificationService.removeSubscription(userId, endpoint);

    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }

    res.json({ success: true, message: 'Subscription removed' });
  } catch (error) {
    logger.error('Error in push unsubscribe:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/subscriptions', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = await requireProfile(req, res);
    if (!userId) return;

    const { data: subscriptions, error } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id, endpoint, device_name, user_agent, created_at, last_successful_push, failure_count')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching subscriptions:', error);
      res.status(500).json({ error: 'Failed to fetch subscriptions' });
      return;
    }

    res.json({ subscriptions: subscriptions || [] });
  } catch (error) {
    logger.error('Error in get subscriptions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/subscriptions/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = await requireProfile(req, res);
    if (!userId) return;

    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', userId);

    if (error) {
      logger.error('Error deleting subscription:', error);
      res.status(500).json({ error: 'Failed to delete subscription' });
      return;
    }

    res.json({ success: true, message: 'Subscription deleted' });
  } catch (error) {
    logger.error('Error in delete subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /push/test
 * Body: { endpoint? }
 * Sends to that endpoint when it belongs to the caller, else to every device.
 */
router.post('/test', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = await requireProfile(req, res);
    if (!userId) return;

    const endpoint = optionalString(req.body?.endpoint, 2048);

    const testPayload = {
      title: 'Test notification',
      message: 'Push notifications are working.',
      body: 'Push notifications are working.',
      type: 'test' as const,
      icon: '/img/app_icon_square.webp',
      badge: '/img/app_icon_square.webp',
      tag: `harmony-test-${Date.now()}`,
      data: {
        test: true,
        url: '/',
        timestamp: new Date().toISOString()
      }
    };

    if (endpoint) {
      const { data: allSubs, error: subError } = await supabaseAdmin
        .rpc('get_user_push_subscriptions', { p_user_id: userId });

      const sub = (allSubs || []).find((s: any) => s.endpoint === endpoint);

      if (subError || !sub) {
        res.json({ success: false, sent: 0, failed: 0, message: 'Subscription not found for this device' });
        return;
      }

      const result = await PushNotificationService.sendToSubscription(
        {
          subscription_id: sub.subscription_id,
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
          push_enabled: sub.push_enabled,
          push_offline_only: sub.push_offline_only,
        },
        testPayload
      );
      res.json({
        success: result.success,
        sent: result.success ? 1 : 0,
        failed: result.success ? 0 : 1,
        message: result.success ? 'Test notification sent to this device' : (result.error || 'Failed to send')
      });
    } else {
      const result = await PushNotificationService.sendToUser(userId, testPayload);
      res.json({
        success: result.sent > 0,
        sent: result.sent,
        failed: result.failed,
        message: result.sent > 0
          ? `Test notification sent to ${result.sent} device(s)`
          : 'No active subscriptions found'
      });
    }
  } catch (error) {
    logger.error('Error in test push:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
