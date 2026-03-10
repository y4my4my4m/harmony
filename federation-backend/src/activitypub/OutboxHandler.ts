import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { postToNote } from './converters/toActivityPub.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

const router = Router();

/**
 * User outbox endpoint with cursor-based pagination
 * GET /users/:username/outbox
 * Query params:
 *   - cursor: ID of last post (for cursor-based pagination)
 *   - page: Page number (legacy, for backwards compatibility)
 *   - limit: Items per page (default 20, max 100)
 *   - type: Filter by activity type (optional: 'Create', 'Announce')
 *   - min_date / max_date: Date range filter (ISO strings)
 */
router.get(
  '/users/:username/outbox',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const page = req.query.page as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const activityType = req.query.type as string | undefined;
    const minDate = req.query.min_date as string | undefined;
    const maxDate = req.query.max_date as string | undefined;
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

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const outboxUrl = `${baseUrl}/users/${username}/outbox`;

    // If no page/cursor, return collection metadata
    if (!page && !cursor) {
      let countQuery = supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('author_id', user.id)
        .eq('is_local', true)
        .eq('is_deleted', false);

      // Apply type filter to count if specified
      if (activityType === 'Announce') {
        countQuery = countQuery.not('metadata->reblog_of', 'is', null);
      } else if (activityType === 'Create') {
        countQuery = countQuery.is('metadata->reblog_of', null);
      }

      const { count } = await countQuery;

      res.setHeader('Content-Type', 'application/activity+json');
      // Allow remote servers to cache outbox collection for 5 minutes
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: outboxUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${outboxUrl}?cursor=start&limit=${limit}`,
      });
      return;
    }

    // Build paginated query
    let query = supabase
      .from('posts')
      .select('*')
      .eq('author_id', user.id)
      .eq('is_local', true)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    // Apply cursor (timestamp-based for efficient pagination)
    if (cursor && cursor !== 'start') {
      const { data: cursorPost } = await supabase
        .from('posts')
        .select('created_at')
        .eq('id', cursor)
        .single();
      
      if (cursorPost) {
        query = query.lt('created_at', cursorPost.created_at);
      }
    } else if (page) {
      // Legacy page-based pagination
      const pageNum = parseInt(page) || 1;
      const offset = (pageNum - 1) * limit;
      query = query.range(offset, offset + limit - 1);
    }

    // Apply type filter
    if (activityType === 'Announce') {
      query = query.not('metadata->reblog_of', 'is', null);
    } else if (activityType === 'Create') {
      query = query.is('metadata->reblog_of', null);
    }

    // Apply date range filters
    if (minDate) {
      query = query.gte('created_at', minDate);
    }
    if (maxDate) {
      query = query.lte('created_at', maxDate);
    }

    const { data: posts } = await query;
    const hasMore = (posts?.length || 0) > limit;
    const items = (posts || []).slice(0, limit);
    const lastItem = items[items.length - 1];

    // Convert posts to ActivityPub activities
    const orderedItems = items.map((post: any) => {
      const isReblog = post.metadata?.reblog_of || post.metadata?.is_reblog;
      
      if (isReblog) {
        // Announce (reblog)
        return {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: post.ap_id || `${baseUrl}/activities/${post.id}`,
          type: 'Announce',
          actor: `${baseUrl}/users/${username}`,
          published: post.created_at,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [`${baseUrl}/users/${username}/followers`],
          object: post.metadata?.reblog_of_ap_url || `${baseUrl}/posts/${post.metadata?.reblog_of}`,
        };
      } else {
        // Create (original post)
        return {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${baseUrl}/activities/${post.id}`,
          type: 'Create',
          actor: `${baseUrl}/users/${username}`,
          published: post.created_at,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [`${baseUrl}/users/${username}/followers`],
          object: postToNote(post, user),
        };
      }
    });

    const response: any = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: cursor 
        ? `${outboxUrl}?cursor=${cursor}&limit=${limit}` 
        : `${outboxUrl}?page=${page || 1}`,
      type: 'OrderedCollectionPage',
      partOf: outboxUrl,
      orderedItems,
    };

    // Add pagination links
    if (hasMore && lastItem?.id) {
      response.next = `${outboxUrl}?cursor=${lastItem.id}&limit=${limit}`;
    }

    // Legacy prev link for page-based
    if (page && parseInt(page) > 1) {
      response.prev = `${outboxUrl}?page=${parseInt(page) - 1}`;
    }

    res.setHeader('Content-Type', 'application/activity+json');
    // Allow remote servers to cache outbox page for 5 minutes
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(response);
  })
);

/**
 * Serve a single post as an ActivityPub Note object.
 * Required so remote instances can dereference our post AP IDs
 * (e.g. https://domain/posts/:uuid) and get JSON instead of the SPA HTML.
 */
router.get(
  '/posts/:postId',
  asyncHandler(async (req: Request, res: Response) => {
    const { postId } = req.params;
    const accept = req.headers.accept || '';

    const wantsActivityPub =
      accept.includes('application/activity+json') ||
      accept.includes('application/ld+json');

    if (!wantsActivityPub) {
      // Browser request — let nginx / SPA handle it
      return res.status(404).json({ error: 'Not found' });
    }

    const supabase = getSupabaseClient();

    const { data: post, error } = await supabase
      .from('posts')
      .select(`
        *,
        author:profiles!posts_author_id_fkey (
          id, username, display_name, avatar_url, domain, is_local, public_key
        )
      `)
      .eq('id', postId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error || !post || !post.author) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const note = postToNote(post, post.author);

    if (post.in_reply_to) {
      const { data: parent } = await supabase
        .from('posts')
        .select('ap_id, id')
        .eq('id', post.in_reply_to)
        .maybeSingle();
      if (parent) {
        note.inReplyTo = parent.ap_id || `https://${config.INSTANCE_DOMAIN}/posts/${parent.id}`;
      }
    }

    res.setHeader('Content-Type', 'application/activity+json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(note);
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

