import { Router, Request, Response } from 'express';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { SignatureService } from './SignatureService.js';
import { ActivityProcessor } from './ActivityProcessor.js';
import { FederatedInstanceService } from '../services/FederatedInstanceService.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { inboxLimiter, instanceInboxLimiter } from '../middleware/rateLimit.js';
import { pgrstEscape } from '../utils/postgrestFilter.js';

const router = Router();

/**
 * Returns profiles.id for the Supabase Bearer token, not the auth uid.
 * Null when the request is unauthenticated or the token is invalid.
 * Gates private inbox reads to the inbox owner.
 */
async function resolveBearerProfileId(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.substring(7);
    const supabase = getSupabaseClientWithAuth(token);
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return null;
    const admin = getSupabaseClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    return profile?.id ?? null;
  } catch {
    return null;
  }
}

// Shared inbox at the ActivityPub-standard location.
router.post(
  '/inbox',
  inboxLimiter,
  instanceInboxLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    logger.info(`POST to /inbox (shared inbox) from ${req.ip}`);
    logger.info(`Headers:`, {
      'content-type': req.headers['content-type'],
      'signature': req.headers.signature ? 'present' : 'missing',
      'digest': req.headers.digest ? 'present' : 'missing',
      'user-agent': req.headers['user-agent']
    });
    await handleInbox(req, res, null);
  })
);

router.post(
  '/users/:username/inbox',
  inboxLimiter,
  instanceInboxLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    logger.info(`POST to /users/${req.params.username}/inbox from ${req.ip}`);
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
 * Query params:
 *   cursor: id of the last activity; cursor pagination.
 *   page: page number; legacy offset pagination.
 *   limit: items per page, default 20, max 100.
 *   type: activity type filter ('Create', 'Follow', 'Like', 'Announce', ...).
 *   min_date / max_date: ISO date range.
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

    if (!user.federated_id) {
      res.setHeader('Content-Type', 'application/activity+json');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `https://${config.INSTANCE_DOMAIN}/users/${username}/inbox`,
        type: 'OrderedCollection',
        totalItems: 0,
        orderedItems: [],
      });
      return;
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const inboxUrl = `${baseUrl}/users/${username}/inbox`;

    // AUTHORIZATION: inbox contents and counts are private. ActivityPub
    // delivery is POST-based, so remote servers never GET another user's
    // inbox. Only the owner or an admin sees real data; others get an empty,
    // correctly-shaped collection rather than an error, which leaks neither
    // the inbox's existence nor its activity level.
    const authedProfileId = await resolveBearerProfileId(req);
    const isOwner = authedProfileId !== null && authedProfileId === user.id;
    let isAdmin = false;
    if (authedProfileId && !isOwner) {
      const { data: adminProfile } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', authedProfileId)
        .maybeSingle();
      isAdmin = !!adminProfile?.is_admin;
    }
    const isAuthorized = isOwner || isAdmin;

    // If no page/cursor, return collection metadata
    if (!page && !cursor) {
      if (!isAuthorized) {
        res.setHeader('Content-Type', 'application/activity+json');
        res.json({
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: inboxUrl,
          type: 'OrderedCollection',
          totalItems: 0,
          first: `${inboxUrl}?cursor=start&limit=${limit}`,
        });
        return;
      }
      // Match activities whose to_addresses or cc_addresses contain the user's
      // federated_id, via the PostgreSQL array-contains operator (cs).
      // Array values are double-quoted, so embedded quotes are escaped.
      const escapedId = pgrstEscape(user.federated_id);
      let countQuery = supabase
        .from('ap_activities')
        .select('*', { count: 'exact', head: true })
        .or(`to_addresses.cs.{"${escapedId}"},cc_addresses.cs.{"${escapedId}"}`)
        .eq('is_local', false);

      if (activityType) {
        countQuery = countQuery.eq('ap_type', activityType);
      }

      const { count } = await countQuery;

      res.setHeader('Content-Type', 'application/activity+json');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: inboxUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${inboxUrl}?cursor=start&limit=${limit}`,
      });
      return;
    }

    if (!isAuthorized) {
      res.setHeader('Content-Type', 'application/activity+json');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${inboxUrl}?cursor=${cursor || 'start'}&limit=${limit}`,
        type: 'OrderedCollectionPage',
        partOf: inboxUrl,
        orderedItems: [],
      });
      return;
    }

    // Match activities whose to_addresses or cc_addresses contain the user's
    // federated_id, via the PostgreSQL array-contains operator (cs).
    // Array values are double-quoted, so embedded quotes are escaped.
    const escapedId = pgrstEscape(user.federated_id);
    let query = supabase
      .from('ap_activities')
      .select('id, ap_id, ap_type, activity_data, created_at')
      .or(`to_addresses.cs.{"${escapedId}"},cc_addresses.cs.{"${escapedId}"}`)
      .eq('is_local', false)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

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

    if (activityType) {
      query = query.eq('ap_type', activityType);
    }

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

    const orderedItems = items.map((activity: any) => {
      const activityData = activity.activity_data || {};
      return {
        '@context': activityData['@context'] || 'https://www.w3.org/ns/activitystreams',
        ...activityData,
        id: activityData.id || activity.ap_id,
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

    if (hasMore && lastItem?.id) {
      response.next = `${inboxUrl}?cursor=${lastItem.id}&limit=${limit}`;
    }

    // Legacy prev link for page-based
    if (page && parseInt(page) > 1) {
      response.prev = `${inboxUrl}?page=${parseInt(page) - 1}`;
    }

    res.setHeader('Content-Type', 'application/activity+json');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(response);
  })
);

async function handleInbox(
  req: Request,
  res: Response,
  username: string | null
): Promise<void> {
  const activity = req.body;

  logger.debug(`handleInbox called for user: ${username || 'shared inbox'}`);
  logger.debug(`Raw body type: ${typeof activity}, is null: ${activity === null}`);

  if (!activity || !activity.type || !activity.actor) {
    logger.warn(`Invalid activity structure - type: ${activity?.type}, actor: ${activity?.actor}`);
    res.status(400).json({ error: 'Invalid activity' });
    return;
  }

  logger.info(`Received ${activity.type} activity from ${activity.actor}`);

  try {
    const actorUrl = new URL(activity.actor);
    const actorDomain = actorUrl.hostname;
    
    const { BlockedInstancesCache } = await import('../services/BlockedInstancesCache.js');
    if (BlockedInstancesCache.isBlocked(actorDomain)) {
      logger.info(`Rejecting activity from blocked instance: ${actorDomain}`);
      res.status(403).json({ error: 'Instance is blocked' });
      return;
    }
  } catch (error) {
    // Unparseable actor URL: processing continues.
    logger.debug(`Could not check instance block status: ${error}`);
  }

  // CRITICAL: ActivityPub authenticates requests with HTTP Signatures.
  // 1. Remote server signs the request with its private key.
  // 2. Public key is fetched from the actor document over HTTPS.
  // 3. Signature is verified against the request.
  // 4. activity.actor must match the signing key's owner.
  
  const signature = req.headers.signature as string;
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  
  if (!signature) {
    if (config.REQUIRE_VALID_SIGNATURES) {
      logger.warn(`Rejecting unsigned activity from ${actorUrl}`);
      res.status(401).json({ error: 'Missing HTTP Signature - all ActivityPub requests must be signed' });
      return;
    } else {
      logger.warn(`Accepting unsigned activity from ${actorUrl} (REQUIRE_VALID_SIGNATURES=false)`);
    }
  } else {
    // req.originalUrl carries the full path as signed; req.path is relative to
    // the mounted router and would not match the signature. Digest is checked
    // against the raw body buffer to avoid JSON re-serialization differences.
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const verification = await SignatureService.verifySignature(
      signature,
      req.headers as Record<string, string>,
      req.method,
      req.originalUrl || req.path, // Use originalUrl to match signed (request-target)
      rawBody || activity // Prefer raw bytes, fall back to parsed object
    );

    if (!verification.verified) {
      if (config.REQUIRE_VALID_SIGNATURES) {
        logger.warn(`Rejecting activity with invalid signature from ${actorUrl}: ${verification.error}`);
        res.status(401).json({ error: `Invalid HTTP Signature: ${verification.error}` });
        return;
      } else {
        logger.warn(`Accepting activity with invalid signature from ${actorUrl} (REQUIRE_VALID_SIGNATURES=false)`);
      }
    } else {
      if (verification.actorUrl && actorUrl) {
        const actorMatch = SignatureService.verifyActorMatch(actorUrl, verification.actorUrl);
        if (!actorMatch) {
          if (config.REQUIRE_VALID_SIGNATURES) {
            logger.warn(`Rejecting activity: actor mismatch. Activity actor: ${actorUrl}, Signing key: ${verification.actorUrl}`);
            res.status(403).json({ error: 'Actor mismatch - activity.actor must match the signing key owner' });
            return;
          } else {
            logger.warn(`Actor mismatch but accepting (REQUIRE_VALID_SIGNATURES=false)`);
          }
        }
      }
      logger.info(`Signature verified for ${actorUrl}`);
    }
  }

  if (actorUrl) {
    FederatedInstanceService.touchFromUrl(actorUrl);
  }

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

    // Like/Undo/Accept/Reject/Follow are implicitly addressed: they reference
    // the user's own content.
    const implicitTypes = ['Like', 'Undo', 'Accept', 'Reject', 'Follow'];
    if (!implicitTypes.includes(activity.type)) {
      const to = Array.isArray(activity.to) ? activity.to : [activity.to].filter(Boolean);
      const cc = Array.isArray(activity.cc) ? activity.cc : [activity.cc].filter(Boolean);
      const recipients = [...to, ...cc];
      const canonicalUrl = `https://${config.INSTANCE_DOMAIN}/users/${username}`;
      const PUBLIC_ADDRESSING = 'https://www.w3.org/ns/activitystreams#Public';

      const directlyAddressed = recipients.some((r: string) =>
        r === user.federated_id || r === canonicalUrl
      );

      // Public addressing or a Mention tag also counts as addressed.
      let mentionedInTags = false;
      if (!directlyAddressed) {
        const isPublic = recipients.some((r: string) =>
          r === PUBLIC_ADDRESSING || r === 'as:Public' || r === 'Public'
        );
        const object = activity.object;
        const tags = object?.tag || [];
        const tagArray = Array.isArray(tags) ? tags : [tags];
        mentionedInTags = tagArray.some((tag: any) =>
          tag?.type === 'Mention' && (
            tag.href === user.federated_id ||
            tag.href === canonicalUrl
          )
        );
        if (!isPublic && !mentionedInTags) {
          logger.warn(`Rejecting activity not addressed to ${username} (type: ${activity.type})`);
          res.status(202).json({ status: 'ignored', reason: 'not addressed to this user' });
          return;
        }
      }
    }
  }

  const supabase = getSupabaseClient();
  // actorUrl extracted above during signature verification.
  let originDomain: string | null = null;
  try {
    originDomain = actorUrl ? new URL(actorUrl).hostname.toLowerCase() : null;
  } catch {
    originDomain = null;
  }

  // Some instances send "EmojiReact"; the DB constraint expects "EmojiReaction".
  let normalizedType = activity.type;
  if (normalizedType === 'EmojiReact') {
    normalizedType = 'EmojiReaction';
  }

  const { error: storeError } = await supabase.rpc('upsert_ap_activity', {
    p_ap_id: activity.id,
    p_ap_type: normalizedType,
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

  const { data: claimed, error: claimError } = await supabase.rpc('claim_ap_activity', {
    p_ap_id: activity.id,
  });
  if (!claimError && claimed === false) {
    logger.info(`Skipping already-processed ${activity.type} activity ${activity.id}`);
    res.status(202).json({ message: 'Activity already processed' });
    return;
  }
  if (claimError) {
    logger.warn(
      `claim_ap_activity unavailable; processing ${activity.type} ${activity.id} without idempotency guard: ${claimError.message}`
    );
  }
  const claimActive = !claimError;

  try {
    await ActivityProcessor.processIncomingActivity(activity);
    logger.info(`Processed ${activity.type} activity`);
    if (claimActive) {
      await supabase.rpc('complete_ap_activity', { p_ap_id: activity.id, p_success: true });
    }
    res.status(202).json({ message: 'Activity accepted' });
  } catch (error) {
    logger.error('Failed to process activity:', error);
    if (claimActive) {
      await supabase
        .rpc('complete_ap_activity', {
          p_ap_id: activity.id,
          p_success: false,
          p_error: error instanceof Error ? error.message : String(error),
        })
        .then(({ error: rpcError }) => {
          if (rpcError) logger.error('Failed to mark activity failed:', rpcError);
        });
    }
    // Activity is stored; the sender gets 202 regardless of processing outcome.
    res.status(202).json({ message: 'Activity accepted' });
  }
}

export default router;

