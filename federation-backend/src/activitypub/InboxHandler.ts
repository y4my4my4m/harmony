import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { SignatureService } from './SignatureService.js';
import { ActivityProcessor } from './ActivityProcessor.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

const router = Router();

/**
 * Shared inbox endpoint (standard location)
 * POST /inbox
 */
router.post(
  '/inbox',
  asyncHandler(async (req: Request, res: Response) => {
    logger.info(`📮 POST to /inbox (shared inbox) from ${req.ip}`);
    logger.info(`Headers:`, {
      'content-type': req.headers['content-type'],
      'signature': req.headers.signature ? 'present' : 'missing',
      'digest': req.headers.digest ? 'present' : 'missing',
      'user-agent': req.headers['user-agent']
    });
    await handleInbox(req, res, null);
  })
);

/**
 * User inbox endpoint
 * POST /users/:username/inbox
 */
router.post(
  '/users/:username/inbox',
  asyncHandler(async (req: Request, res: Response) => {
    logger.info(`📮 POST to /users/${req.params.username}/inbox from ${req.ip}`);
    logger.info(`Headers:`, {
      'content-type': req.headers['content-type'],
      'signature': req.headers.signature ? 'present' : 'missing',
      'digest': req.headers.digest ? 'present' : 'missing',
      'user-agent': req.headers['user-agent']
    });
    await handleInbox(req, res, req.params.username);
  })
);

/**
 * User inbox collection endpoint with cursor-based pagination
 * GET /users/:username/inbox
 * Query params:
 *   - cursor: ID of last activity (for cursor-based pagination)
 *   - page: Page number (legacy, for backwards compatibility)
 *   - limit: Items per page (default 20, max 100)
 *   - type: Filter by activity type (optional: 'Create', 'Follow', 'Like', 'Announce', etc.)
 *   - min_date / max_date: Date range filter (ISO strings)
 */
router.get(
  '/users/:username/inbox',
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
      .select('id, federated_id')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (userError || !user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const inboxUrl = `${baseUrl}/users/${username}/inbox`;

    // If no page/cursor, return collection metadata
    if (!page && !cursor) {
      // Query activities where user's federated_id is in to_addresses or cc_addresses
      // Use PostgreSQL array contains operator (cs) via or() filter
      // Escape double quotes for PostgreSQL array syntax (array values are double-quoted)
      const escapedId = user.federated_id.replace(/"/g, '\\"');
      let countQuery = supabase
        .from('ap_activities')
        .select('*', { count: 'exact', head: true })
        .or(`to_addresses.cs.{"${escapedId}"},cc_addresses.cs.{"${escapedId}"}`)
        .eq('is_local', false);

      // Apply type filter to count if specified
      if (activityType) {
        countQuery = countQuery.eq('ap_type', activityType);
      }

      const { count } = await countQuery;

      res.setHeader('Content-Type', 'application/activity+json');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: inboxUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${inboxUrl}?cursor=start&limit=${limit}`,
      });
      return;
    }

    // Build paginated query
    // Query activities where user's federated_id is in to_addresses or cc_addresses
    // Use PostgreSQL array contains operator (cs) via or() filter
    // Escape double quotes for PostgreSQL array syntax (array values are double-quoted)
    const escapedId = user.federated_id.replace(/"/g, '\\"');
    let query = supabase
      .from('ap_activities')
      .select('id, ap_id, ap_type, activity_data, created_at')
      .or(`to_addresses.cs.{"${escapedId}"},cc_addresses.cs.{"${escapedId}"}`)
      .eq('is_local', false)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    // Apply cursor (timestamp-based for efficient pagination)
    if (cursor && cursor !== 'start') {
      const { data: cursorActivity } = await supabase
        .from('ap_activities')
        .select('created_at')
        .eq('id', cursor)
        .single();
      
      if (cursorActivity) {
        query = query.lt('created_at', cursorActivity.created_at);
      }
    } else if (page) {
      // Legacy page-based pagination
      const pageNum = parseInt(page) || 1;
      const offset = (pageNum - 1) * limit;
      query = query.range(offset, offset + limit - 1);
    }

    // Apply type filter
    if (activityType) {
      query = query.eq('ap_type', activityType);
    }

    // Apply date range filters
    if (minDate) {
      query = query.gte('created_at', minDate);
    }
    if (maxDate) {
      query = query.lte('created_at', maxDate);
    }

    const { data: activities, error: queryError } = await query;

    if (queryError) {
      logger.error('Failed to query inbox activities:', queryError);
      res.status(500).json({ error: 'Failed to fetch inbox activities' });
      return;
    }

    const hasMore = (activities?.length || 0) > limit;
    const items = (activities || []).slice(0, limit);
    const lastItem = items[items.length - 1];

    // Return activities from activity_data (full ActivityPub format)
    const orderedItems = items.map((activity: any) => {
      // Return the full activity from activity_data, ensuring it has required fields
      const activityData = activity.activity_data || {};
      return {
        '@context': activityData['@context'] || 'https://www.w3.org/ns/activitystreams',
        ...activityData,
        // Ensure id is present (use ap_id if not in activity_data)
        id: activityData.id || activity.ap_id,
        // Ensure type is present
        type: activityData.type || activity.ap_type,
      };
    });

    const response: any = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: cursor 
        ? `${inboxUrl}?cursor=${cursor}&limit=${limit}` 
        : `${inboxUrl}?page=${page || 1}`,
      type: 'OrderedCollectionPage',
      partOf: inboxUrl,
      orderedItems,
    };

    // Add pagination links
    if (hasMore && lastItem?.id) {
      response.next = `${inboxUrl}?cursor=${lastItem.id}&limit=${limit}`;
    }

    // Legacy prev link for page-based
    if (page && parseInt(page) > 1) {
      response.prev = `${inboxUrl}?page=${parseInt(page) - 1}`;
    }

    res.setHeader('Content-Type', 'application/activity+json');
    res.json(response);
  })
);

/**
 * Common inbox handler
 */
async function handleInbox(
  req: Request,
  res: Response,
  username: string | null
): Promise<void> {
  const activity = req.body;

  logger.info(`🔍 handleInbox called for user: ${username || 'shared inbox'}`);
  logger.info(`📦 Raw body type: ${typeof activity}, is null: ${activity === null}, is undefined: ${activity === undefined}`);
  logger.info(`📦 Activity body:`, activity ? JSON.stringify(activity).substring(0, 500) : 'EMPTY OR NULL');

  // Validate activity structure
  if (!activity || !activity.type || !activity.actor) {
    logger.error(`❌ Invalid activity structure - type: ${activity?.type}, actor: ${activity?.actor}`);
    logger.error(`Full body received:`, JSON.stringify(activity));
    res.status(400).json({ error: 'Invalid activity' });
    return;
  }

  logger.info(`📥 Received ${activity.type} activity from ${activity.actor}`);

  // Check if the sending instance is blocked (O(1) in-memory lookup)
  try {
    const actorUrl = new URL(activity.actor);
    const actorDomain = actorUrl.hostname;
    
    const { BlockedInstancesCache } = await import('../services/BlockedInstancesCache.js');
    if (BlockedInstancesCache.isBlocked(actorDomain)) {
      logger.info(`🚫 Rejecting activity from blocked instance: ${actorDomain}`);
      res.status(403).json({ error: 'Instance is blocked' });
      return;
    }
  } catch (error) {
    // If we can't parse the actor URL, continue processing
    logger.debug(`Could not check instance block status: ${error}`);
  }

  // Verify HTTP signature (optional but recommended)
  const signature = req.headers.signature as string;
  if (signature) {
    const verification = await SignatureService.verifySignature(
      signature,
      req.headers as Record<string, string>,
      req.method,
      req.path
    );

    if (!verification.verified) {
      logger.warn(`⚠️  Signature verification failed for ${activity.actor}`);
      // Note: Some implementations don't sign properly, so we log but don't reject
    } else {
      logger.info(`✅ Signature verified for ${activity.actor}`);
    }
  }

  // If username specified, verify activity is addressed to them
  if (username) {
    const supabase = getSupabaseClient();
    const { data: user } = await supabase
      .from('profiles')
      .select('federated_id')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Check if activity is addressed to this user
    const to = Array.isArray(activity.to) ? activity.to : [activity.to].filter(Boolean);
    const cc = Array.isArray(activity.cc) ? activity.cc : [activity.cc].filter(Boolean);
    const recipients = [...to, ...cc];

    if (!recipients.includes(user.federated_id) && activity.type !== 'Follow') {
      logger.warn(`Activity not addressed to ${username}`);
    }
  }

  // Store activity in database (idempotent)
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;
  const originDomain = actorUrl ? new URL(actorUrl).hostname : null;

  const { error: storeError } = await supabase.rpc('upsert_ap_activity', {
    p_ap_id: activity.id,
    p_ap_type: activity.type,
    p_actor_ap_id: actorUrl,
    p_activity_data: activity,
    p_origin_domain: originDomain,
    p_to_addresses: Array.isArray(activity.to) ? activity.to : [activity.to].filter(Boolean),
    p_cc_addresses: Array.isArray(activity.cc) ? activity.cc : [activity.cc].filter(Boolean),
    p_is_local: false,
  });

  if (storeError) {
    logger.error('Failed to store activity:', storeError);
    res.status(500).json({ error: 'Failed to store activity' });
    return;
  }

  // Process activity
  try {
    await ActivityProcessor.processIncomingActivity(activity);
    logger.info(`✅ Processed ${activity.type} activity`);
    res.status(202).json({ message: 'Activity accepted' });
  } catch (error) {
    logger.error('Failed to process activity:', error);
    // Still return success to sender (we've stored it)
    res.status(202).json({ message: 'Activity accepted' });
  }
}

export default router;

