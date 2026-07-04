/**
 * Push Notification API Routes
 * 
 * Handles push subscription management for PWA push notifications
 */

import { Router, Request, Response } from 'express';
import { PushNotificationService } from '../services/PushNotificationService.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

const supabaseAdmin = getSupabaseClient();

const router = Router();

/**
 * GET /push/vapid-key
 * Get the VAPID public key for client-side subscription
 */
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

/**
 * GET /push/status
 * Check if push notifications are available
 */
router.get('/status', (_req: Request, res: Response): void => {
  res.json({
    available: PushNotificationService.isAvailable(),
    configured: !!PushNotificationService.getPublicKey()
  });
});

/**
 * POST /push/subscribe
 * Subscribe a device to push notifications
 */
router.post('/subscribe', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const token = authHeader.substring(7);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    const userId = profile?.id || user.id;
    const { subscription, deviceName } = req.body;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
      res.status(400).json({ error: 'Invalid subscription data' });
      return;
    }

    logger.info(`📤 Push subscribe: authUserId=${user.id}, profileId=${profile?.id ?? 'null'}, userId=${userId}, endpoint=${subscription.endpoint.slice(0, 90)}`);

    const result = await PushNotificationService.saveSubscription(
      userId,
      subscription,
      req.headers['user-agent'],
      deviceName
    );

    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }

    res.json({ success: true, message: 'Subscription saved' });
  } catch (error) {
    logger.error('Error in push subscribe:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /push/unsubscribe
 * Remove a push subscription
 */
router.post('/unsubscribe', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const token = authHeader.substring(7);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    const userId = profile?.id || user.id;
    const { endpoint } = req.body;

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

/**
 * GET /push/subscriptions
 * Get all push subscriptions for the authenticated user
 */
router.get('/subscriptions', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const token = authHeader.substring(7);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    const userId = profile?.id || user.id;

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

/**
 * DELETE /push/subscriptions/:id
 * Delete a specific subscription by ID
 */
router.delete('/subscriptions/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const token = authHeader.substring(7);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    const userId = profile?.id || user.id;
    const subscriptionId = req.params.id;

    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .delete()
      .eq('id', subscriptionId)
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
 * Send a test push notification to the authenticated user
 */
router.post('/test', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const token = authHeader.substring(7);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, username')
      .eq('auth_user_id', user.id)
      .single();

    const userId = profile?.id || user.id;
    const { endpoint } = req.body || {};

    // Debug: trace test lookup for "no active subscription" troubleshooting
    logger.info(`📤 Push test: authUserId=${user.id}, profileId=${profile?.id ?? 'null'}, userId=${userId}, hasEndpoint=${!!endpoint}, endpointPrefix=${(endpoint ?? '').slice(0, 60)}...`);

    const testPayload = {
      title: '🔔 Test Notification',
      message: 'Push notifications are working!',
      body: 'Push notifications are working!',
      type: 'test' as const,
      icon: '/img/app_icon_square.webp',
      badge: '/img/app_icon_square.webp',
      tag: `harmony-test-${Date.now()}`,
      data: {
        test: true,
        timestamp: new Date().toISOString()
      }
    };

    if (endpoint) {
      // Send to current device only - use the same RPC as production to get
      // subscription data with real notification preferences from the JOIN
      const { data: allSubs, error: subError } = await supabaseAdmin
        .rpc('get_user_push_subscriptions', { p_user_id: userId });

      const sub = (allSubs || []).find((s: any) => s.endpoint === endpoint);

      if (subError || !sub) {
        // Debug: log why lookup failed
        const rpcEndpoints = (allSubs || []).map((s: any) => (s.endpoint ?? '').slice(0, 60));
        logger.warn(`📤 Push test: subscription not found. subError=${subError?.message ?? 'none'}, allSubsCount=${(allSubs || []).length}, endpointMatch=${!!sub}. Client endpoint len=${(endpoint ?? '').length}. RPC endpoints (first 60 chars each): ${JSON.stringify(rpcEndpoints)}`);
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
