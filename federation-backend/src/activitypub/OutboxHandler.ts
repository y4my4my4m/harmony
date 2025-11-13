import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { postToNote } from './converters/toActivityPub.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * User outbox endpoint
 * GET /users/:username/outbox
 */
router.get(
  '/users/:username/outbox',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const supabase = getSupabaseClient();

    // Get user
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (userError || !user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const outboxUrl = `${baseUrl}/users/${username}/outbox`;

    // Get page parameter
    const page = req.query.page;

    if (!page) {
      // Return collection metadata
      const { count } = await supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('author_id', user.id)
        .eq('is_local', true);

      res.setHeader('Content-Type', 'application/activity+json');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: outboxUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${outboxUrl}?page=1`,
      });
    } else {
      // Return paginated posts
      const pageNum = parseInt(page as string) || 1;
      const limit = 20;
      const offset = (pageNum - 1) * limit;

      const { data: posts } = await supabase
        .from('posts')
        .select('*')
        .eq('author_id', user.id)
        .eq('is_local', true)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      // Convert posts to ActivityPub Create activities
      const items = (posts || []).map((post) => ({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${baseUrl}/activities/${post.id}`,
        type: 'Create',
        actor: `${baseUrl}/users/${username}`,
        published: post.created_at,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${baseUrl}/users/${username}/followers`],
        object: postToNote(post, user),
      }));

      res.setHeader('Content-Type', 'application/activity+json');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${outboxUrl}?page=${pageNum}`,
        type: 'OrderedCollectionPage',
        partOf: outboxUrl,
        orderedItems: items,
        next: items.length === limit ? `${outboxUrl}?page=${pageNum + 1}` : undefined,
        prev: pageNum > 1 ? `${outboxUrl}?page=${pageNum - 1}` : undefined,
      });
    }
  })
);

/**
 * Process delivery queue (called by cron or manually)
 * POST /api/activitypub/process-delivery
 */
router.post(
  '/api/activitypub/process-delivery',
  asyncHandler(async (req: Request, res: Response) => {
    const { DeliveryQueue } = await import('./DeliveryQueue.js');
    
    const result = await DeliveryQueue.processQueue();

    res.json({
      success: true,
      ...result,
    });
  })
);

export default router;

