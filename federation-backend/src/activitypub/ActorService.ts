import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { profileToActor } from './converters/toActivityPub.js';
import { actorToProfile } from './converters/fromActivityPub.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

const router = Router();

/**
 * Lookup remote user via WebFinger
 * POST /api/lookup-user
 * Body: { handle: "username@domain" }
 * 
 * This endpoint proxies WebFinger requests to bypass CORS restrictions
 */
router.post(
  '/api/lookup-user',
  asyncHandler(async (req: Request, res: Response) => {
    const { handle, forceRefresh } = req.body;

    if (!handle || typeof handle !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid handle parameter' });
    }

    // Parse handle (username@domain or @username@domain)
    const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
    const parts = cleanHandle.split('@');
    
    if (parts.length !== 2) {
      return res.status(400).json({ error: 'Invalid handle format. Use username@domain' });
    }

    const [username, domain] = parts;
    const supabase = getSupabaseClient();

    logger.info(`🔍 Looking up remote user: ${username}@${domain}${forceRefresh ? ' (force refresh)' : ''}`);

    // Check if user already exists locally (unless force refresh)
    if (!forceRefresh) {
      const { data: existingUser } = await supabase
        .from('profiles')
        .select('*')
        .eq('username', username)
        .eq('domain', domain)
        .single();

      if (existingUser) {
        logger.info(`✅ Found existing user in database: ${username}@${domain}`);
        return res.json({
          success: true,
          user: existingUser,
          cached: true
        });
      }
    }

    try {
      // Step 1: WebFinger lookup
      const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${encodeURIComponent(username)}@${encodeURIComponent(domain)}`;
      logger.info(`🌐 WebFinger lookup: ${webfingerUrl}`);
      
      const webfingerResponse = await fetch(webfingerUrl, {
        headers: { 
          'Accept': 'application/jrd+json, application/json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });

      if (!webfingerResponse.ok) {
        logger.warn(`❌ WebFinger failed for ${username}@${domain}: ${webfingerResponse.status}`);
        return res.status(404).json({ 
          error: 'User not found on remote instance',
          details: `WebFinger returned ${webfingerResponse.status}`
        });
      }

      const webfinger = await webfingerResponse.json();
      logger.info(`📋 WebFinger response: ${JSON.stringify(webfinger.links?.length || 0)} links`);
      
      // Find the ActivityPub self link
      const selfLink = webfinger.links?.find((link: any) => 
        link.rel === 'self' && 
        (link.type === 'application/activity+json' || link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"')
      );

      if (!selfLink?.href) {
        logger.warn(`❌ No ActivityPub link found in WebFinger response for ${username}@${domain}`);
        return res.status(404).json({ 
          error: 'User is not on an ActivityPub-compatible instance'
        });
      }

      // Step 2: Fetch the Actor
      logger.info(`🌐 Fetching actor: ${selfLink.href}`);
      const actorResponse = await fetch(selfLink.href, {
        headers: { 
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!actorResponse.ok) {
        logger.warn(`❌ Actor fetch failed: ${actorResponse.status}`);
        return res.status(404).json({ 
          error: 'Failed to fetch user profile from remote instance'
        });
      }

      const actor = await actorResponse.json();
      logger.info(`📋 Actor fetched: ${actor.preferredUsername || actor.name}`);
      
      // Step 3: Convert and store the profile
      const profileData = actorToProfile(actor);
      
      const profileRecord = {
        username: profileData.username,
        domain: profileData.domain,
        display_name: profileData.display_name,
        bio: profileData.bio,
        avatar_url: profileData.avatar,
        banner_url: profileData.banner,
        public_key: profileData.public_key,
        federated_id: profileData.federated_id,
        inbox_url: profileData.inbox_url,
        outbox_url: profileData.outbox_url,
        followers_url: profileData.followers_url,
        following_url: profileData.following_url,
        is_local: false,
        last_synced_at: new Date().toISOString()
      };

      const { data: savedUser, error: saveError } = await supabase
        .from('profiles')
        .upsert(profileRecord, {
          onConflict: 'username,domain',
        })
        .select()
        .single();

      if (saveError) {
        logger.error(`❌ Failed to save remote user: ${saveError.message}`);
        return res.status(500).json({ 
          error: 'Failed to store user profile',
          details: saveError.message
        });
      }

      logger.info(`✅ ${forceRefresh ? 'Refreshed' : 'Created'} remote user: ${username}@${domain}`);
      
      return res.json({
        success: true,
        user: savedUser,
        cached: false,
        refreshed: forceRefresh || false
      });

    } catch (error: any) {
      logger.error(`❌ Error looking up remote user ${username}@${domain}:`, error);
      
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        return res.status(504).json({ 
          error: 'Remote server took too long to respond'
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to lookup remote user',
        details: error.message
      });
    }
  })
);

/**
 * Actor endpoint
 * GET /users/:username - Returns ActivityPub Actor object
 */
router.get(
  '/users/:username',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const supabase = getSupabaseClient();

    // Fetch user profile
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (error || !profile) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    // Convert to ActivityPub Actor
    const actor = profileToActor(profile);

    res.setHeader('Content-Type', 'application/activity+json');
    res.json(actor);
  })
);

/**
 * Followers collection endpoint
 * GET /users/:username/followers
 */
router.get(
  '/users/:username/followers',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const supabase = getSupabaseClient();

    // Get user
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get follower count
    const { count } = await supabase
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('following_id', user.id)
      .eq('status', 'accepted');

    // Always use HTTPS with instance domain (req.protocol returns http behind nginx proxy)
    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const collectionUrl = `${baseUrl}/users/${username}/followers`;

    res.setHeader('Content-Type', 'application/activity+json');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: collectionUrl,
      type: 'OrderedCollection',
      totalItems: count || 0,
      first: `${collectionUrl}?page=1`,
    });
  })
);

/**
 * Following collection endpoint
 * GET /users/:username/following
 */
router.get(
  '/users/:username/following',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const supabase = getSupabaseClient();

    // Get user
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get following count
    const { count } = await supabase
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', user.id)
      .eq('status', 'accepted');

    // Always use HTTPS with instance domain (req.protocol returns http behind nginx proxy)
    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const collectionUrl = `${baseUrl}/users/${username}/following`;

    res.setHeader('Content-Type', 'application/activity+json');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: collectionUrl,
      type: 'OrderedCollection',
      totalItems: count || 0,
      first: `${collectionUrl}?page=1`,
    });
  })
);

export default router;

