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
 * POST /api/federation/lookup-user
 * Body: { handle: "username@domain" }
 * 
 * This endpoint proxies WebFinger requests to bypass CORS restrictions
 */
router.post(
  '/api/federation/lookup-user',
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
      
      // Step 3: Fetch follower/following/posts counts from collections
      let followersCount = 0;
      let followingCount = 0;
      let postsCount = 0;

      // Fetch counts in parallel (with timeouts, don't fail if these fail)
      const fetchCollectionCount = async (url: string): Promise<number> => {
        try {
          const response = await fetch(url, {
            headers: { 
              'Accept': 'application/activity+json, application/ld+json',
              'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
            },
            signal: AbortSignal.timeout(5000)
          });
          if (!response.ok) return 0;
          const collection = await response.json();
          return collection.totalItems || 0;
        } catch {
          return 0;
        }
      };

      const [followers, following, posts] = await Promise.all([
        actor.followers ? fetchCollectionCount(actor.followers) : Promise.resolve(0),
        actor.following ? fetchCollectionCount(actor.following) : Promise.resolve(0),
        actor.outbox ? fetchCollectionCount(actor.outbox) : Promise.resolve(0),
      ]);

      followersCount = followers;
      followingCount = following;
      postsCount = posts;

      logger.info(`📊 Stats: ${postsCount} posts, ${followingCount} following, ${followersCount} followers`);

      // Step 4: Convert and store the profile
      const profileData = actorToProfile(actor);
      
      const profileRecord: any = {
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
        last_synced_at: new Date().toISOString(),
      };

      // Add counts if columns exist (may need migration)
      if (followersCount > 0) profileRecord.followers_count = followersCount;
      if (followingCount > 0) profileRecord.following_count = followingCount;
      if (postsCount > 0) profileRecord.posts_count = postsCount;

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
      
      // Fetch recent posts in the background (don't block the response)
      if (actor.outbox) {
        fetchRecentPostsInBackground(savedUser.id, actor.outbox, supabase).catch(err => {
          logger.warn(`Background post fetch failed for ${username}@${domain}:`, err.message);
        });
      }
      
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

/**
 * Fetch recent posts from a remote user's outbox in the background
 * Only fetches the first page (up to 10 posts) to avoid overwhelming the database
 */
async function fetchRecentPostsInBackground(
  authorId: string, 
  outboxUrl: string, 
  supabase: any
): Promise<void> {
  const MAX_POSTS = 10;
  
  try {
    logger.info(`📬 Fetching recent posts from outbox: ${outboxUrl}`);
    
    // Fetch the outbox collection
    const outboxResponse = await fetch(outboxUrl, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!outboxResponse.ok) {
      logger.warn(`Failed to fetch outbox: ${outboxResponse.status}`);
      return;
    }
    
    const outbox = await outboxResponse.json();
    
    // Get the first page URL or use orderedItems directly
    let items: any[] = [];
    
    if (outbox.orderedItems && Array.isArray(outbox.orderedItems)) {
      // Items are directly in the collection
      items = outbox.orderedItems.slice(0, MAX_POSTS);
    } else if (outbox.first) {
      // Need to fetch the first page
      const firstPageUrl = typeof outbox.first === 'string' ? outbox.first : outbox.first.id;
      
      const pageResponse = await fetch(firstPageUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        signal: AbortSignal.timeout(10000)
      });
      
      if (pageResponse.ok) {
        const page = await pageResponse.json();
        items = (page.orderedItems || []).slice(0, MAX_POSTS);
      }
    }
    
    if (items.length === 0) {
      logger.info(`📬 No posts found in outbox`);
      return;
    }
    
    logger.info(`📬 Processing ${items.length} posts from outbox`);
    
    let savedCount = 0;
    
    for (const item of items) {
      try {
        // Handle both Create activities and direct Note objects
        const note = item.type === 'Create' ? item.object : item;
        
        // Skip non-Note types (Announce, etc.)
        if (note.type !== 'Note' && note.type !== 'Article') {
          continue;
        }
        
        // Check if post already exists
        const { data: existing } = await supabase
          .from('posts')
          .select('id')
          .eq('ap_id', note.id)
          .maybeSingle();
        
        if (existing) {
          continue; // Already have this post
        }
        
        // Convert content - strip HTML but preserve line breaks
        let content = note.content || '';
        content = content.replace(/<br\s*\/?>/gi, '\n');
        content = content.replace(/<\/p>\s*<p>/gi, '\n\n');
        content = content.replace(/<[^>]*>/g, '');
        content = content.replace(/&nbsp;/g, ' ');
        content = content.replace(/&amp;/g, '&');
        content = content.replace(/&lt;/g, '<');
        content = content.replace(/&gt;/g, '>');
        content = content.trim();
        
        // Determine visibility
        let visibility = 'public';
        const to = note.to || [];
        const cc = note.cc || [];
        const allRecipients = [...to, ...cc];
        
        if (allRecipients.includes('https://www.w3.org/ns/activitystreams#Public')) {
          visibility = to.includes('https://www.w3.org/ns/activitystreams#Public') ? 'public' : 'unlisted';
        } else if (allRecipients.some((r: string) => r.endsWith('/followers'))) {
          visibility = 'followers';
        } else {
          visibility = 'direct';
        }
        
        // Create the post (simplified - just the basics for display)
        const { error: insertError } = await supabase
          .from('posts')
          .insert({
            ap_id: note.id,
            author_id: authorId,
            content: [{ type: 'text', text: content }], // Simple text content
            visibility,
            is_local: false,
            created_at: note.published || new Date().toISOString(),
            content_warning: note.summary || null,
            is_sensitive: note.sensitive === true,
          });
        
        if (!insertError) {
          savedCount++;
        }
      } catch (postError) {
        // Skip individual post errors, continue with others
        logger.debug(`Failed to save post:`, postError);
      }
    }
    
    logger.info(`📬 Saved ${savedCount} new posts from remote user`);
    
  } catch (error) {
    logger.warn(`Failed to fetch outbox posts:`, error);
  }
}

export default router;

