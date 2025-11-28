/**
 * Push Notification API Routes
 * 
 * Handles push subscription management for PWA push notifications
 */

import { Router, Request, Response } from 'express';
import { PushNotificationService } from '../services/PushNotificationService.js';
import { supabaseAdmin } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /push/vapid-key
 * Get the VAPID public key for client-side subscription
 */
router.get('/vapid-key', (_req: Request, res: Response) => {
  const publicKey = PushNotificationService.getPublicKey();
  
  if (!publicKey) {
    return res.status(503).json({
      error: 'Push notifications not configured',
      message: 'VAPID keys are not set up on this server'
    });
  }

  res.json({ publicKey });
});

/**
 * GET /push/status
 * Check if push notifications are available
 */
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    available: PushNotificationService.isAvailable(),
    configured: !!PushNotificationService.getPublicKey()
  });
});

/**
 * POST /push/subscribe
 * Subscribe a device to push notifications
 * 
 * Body: {
 *   subscription: PushSubscription (from browser)
 *   deviceName?: string
 * }
 * 
 * Headers: Authorization: Bearer <token>
 */
router.post('/subscribe', async (req: Request, res: Response) => {
  try {
    // Extract user from authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    
    // Verify the token and get user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user's profile ID
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    if (profileError || !profile) {
      // Fallback to using auth user id if no profile found
      logger.warn('Profile not found for auth user, using auth.uid()');
    }

    const userId = profile?.id || user.id;

    const { subscription, deviceName } = req.body;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'Invalid subscription data' });
    }

    const result = await PushNotificationService.saveSubscription(
      userId,
      subscription,
      req.headers['user-agent'],
      deviceName
    );

    if (!result.success) {
      return res.status(500).json({ error: result.error });
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
 * 
 * Body: {
 *   endpoint: string
 * }
 * 
 * Headers: Authorization: Bearer <token>
 */
router.post('/unsubscribe', async (req: Request, res: Response) => {
  try {
    // Extract user from authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    
    // Verify the token and get user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user's profile ID
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    const userId = profile?.id || user.id;

    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    const result = await PushNotificationService.removeSubscription(userId, endpoint);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
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
 * 
 * Headers: Authorization: Bearer <token>
 */
router.get('/subscriptions', async (req: Request, res: Response) => {
  try {
    // Extract user from authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    
    // Verify the token and get user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user's profile ID
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    const userId = profile?.id || user.id;

    // Get subscriptions (without sensitive key data)
    const { data: subscriptions, error } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id, endpoint, device_name, user_agent, created_at, last_successful_push, failure_count')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching subscriptions:', error);
      return res.status(500).json({ error: 'Failed to fetch subscriptions' });
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
 * 
 * Headers: Authorization: Bearer <token>
 */
router.delete('/subscriptions/:id', async (req: Request, res: Response) => {
  try {
    // Extract user from authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    
    // Verify the token and get user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user's profile ID
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    const userId = profile?.id || user.id;
    const subscriptionId = req.params.id;

    // Delete the subscription (RLS ensures user can only delete their own)
    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .delete()
      .eq('id', subscriptionId)
      .eq('user_id', userId);

    if (error) {
      logger.error('Error deleting subscription:', error);
      return res.status(500).json({ error: 'Failed to delete subscription' });
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
 * 
 * Headers: Authorization: Bearer <token>
 */
router.post('/test', async (req: Request, res: Response) => {
  try {
    // Extract user from authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    
    // Verify the token and get user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user's profile ID
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, username')
      .eq('auth_user_id', user.id)
      .single();

    const userId = profile?.id || user.id;

    const result = await PushNotificationService.sendToUser(userId, {
      title: '🔔 Test Notification',
      message: 'Push notifications are working!',
      body: 'Push notifications are working!',
      type: 'test',
      icon: '/img/app_icon_square.png',
      badge: '/img/app_icon_square.png',
      tag: `harmony-test-${Date.now()}`,
      data: {
        test: true,
        timestamp: new Date().toISOString()
      }
    });

    res.json({
      success: result.sent > 0,
      sent: result.sent,
      failed: result.failed,
      message: result.sent > 0 
        ? `Test notification sent to ${result.sent} device(s)`
        : 'No active subscriptions found'
    });
  } catch (error) {
    logger.error('Error in test push:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

