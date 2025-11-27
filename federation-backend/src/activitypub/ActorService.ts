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
        outbox_url: actor.outbox, // Include for pagination
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
 * Fetch more posts from a remote user (pagination)
 * POST /api/federation/fetch-posts
 * Body: { user_id: uuid, outbox_url: string, max_id?: string, limit?: number }
 */
router.post(
  '/api/federation/fetch-posts',
  asyncHandler(async (req: Request, res: Response) => {
    const { user_id, outbox_url, max_id, limit = 10 } = req.body;

    if (!user_id || !outbox_url) {
      return res.status(400).json({ error: 'user_id and outbox_url are required' });
    }

    const supabase = getSupabaseClient();
    
    logger.info(`📬 Fetch posts request for user ${user_id} (load_more=${!!max_id})`);

    try {
      const result = await fetchRecentPostsInBackground(
        user_id, 
        outbox_url, 
        supabase, 
        max_id, 
        Math.min(limit, 20) // Cap at 20
      );

      return res.json({
        success: true,
        has_more: result.hasMore,
        oldest_id: result.oldestId,
        next_page: result.nextPageUrl ? 'available' : 'none',
      });
    } catch (error: any) {
      logger.error('Failed to fetch more posts:', error);
      return res.status(500).json({ error: 'Failed to fetch posts' });
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
 * Featured/Pinned posts collection endpoint
 * GET /users/:username/featured - Returns pinned posts
 */
router.get(
  '/users/:username/featured',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const supabase = getSupabaseClient();

    // Get user
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const featuredUrl = `${baseUrl}/users/${username}/featured`;

    // Get pinned posts
    const { data: pinnedPosts, error: postsError } = await supabase
      .from('posts')
      .select('id, ap_id, content, created_at, visibility, content_warning, is_sensitive')
      .eq('author_id', user.id)
      .eq('is_pinned', true)
      .eq('is_deleted', false)
      .in('visibility', ['public', 'unlisted'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (postsError) {
      logger.error('Failed to fetch pinned posts:', postsError);
      return res.status(500).json({ error: 'Failed to fetch pinned posts' });
    }

    // Convert posts to ActivityPub Note objects
    const orderedItems = (pinnedPosts || []).map(post => {
      const postUrl = post.ap_id || `${baseUrl}/posts/${post.id}`;
      
      // Extract text content from JSONB
      let textContent = '';
      if (Array.isArray(post.content)) {
        textContent = post.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text || '')
          .join('');
      }

      const note: any = {
        id: postUrl,
        type: 'Note',
        attributedTo: `${baseUrl}/users/${username}`,
        content: textContent,
        published: post.created_at,
        to: post.visibility === 'public' 
          ? ['https://www.w3.org/ns/activitystreams#Public']
          : [`${baseUrl}/users/${username}/followers`],
        cc: post.visibility === 'public'
          ? [`${baseUrl}/users/${username}/followers`]
          : [],
      };

      if (post.content_warning) {
        note.summary = post.content_warning;
      }
      if (post.is_sensitive) {
        note.sensitive = true;
      }

      return note;
    });

    res.setHeader('Content-Type', 'application/activity+json');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: featuredUrl,
      type: 'OrderedCollection',
      totalItems: orderedItems.length,
      orderedItems,
    });
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

// Cache for next page URLs per user
const userNextPageCache = new Map<string, string | null>();

// Track fetched URLs per user to detect loops
const userFetchedUrls = new Map<string, Set<string>>();

// Track consecutive zero-save fetches per user
const userZeroSaveCount = new Map<string, number>();

// Max consecutive zero-save fetches before giving up
const MAX_ZERO_SAVES = 3;

/**
 * Fetch recent posts from a remote user's outbox in the background
 * Uses proper ActivityPub pagination via 'next' links
 */
async function fetchRecentPostsInBackground(
  authorId: string, 
  outboxUrl: string, 
  supabase: any,
  maxId?: string, // Used to signal "get next page" - we use cached next URL
  limit: number = 10
): Promise<{ hasMore: boolean; oldestId?: string; nextPageUrl?: string }> {
  try {
    // Determine which URL to fetch
    let fetchUrl: string;
    
    if (maxId) {
      // User wants more posts - use cached next page URL
      const cachedNextUrl = userNextPageCache.get(authorId);
      if (!cachedNextUrl) {
        logger.info(`📬 No cached next page for user ${authorId}, fetching first page`);
        fetchUrl = outboxUrl;
        // Reset tracking for fresh start
        userFetchedUrls.delete(authorId);
        userZeroSaveCount.delete(authorId);
      } else {
        fetchUrl = cachedNextUrl;
        logger.info(`📬 Using cached next page: ${fetchUrl}`);
      }
    } else {
      // Initial fetch - start from the beginning
      fetchUrl = outboxUrl;
      userNextPageCache.delete(authorId);
      userFetchedUrls.delete(authorId);
      userZeroSaveCount.delete(authorId);
    }
    
    // Check if we've already fetched this URL (loop detection)
    const fetchedUrls = userFetchedUrls.get(authorId) || new Set<string>();
    if (fetchedUrls.has(fetchUrl)) {
      logger.info(`📬 Loop detected - already fetched ${fetchUrl}, stopping pagination`);
      userNextPageCache.delete(authorId);
      userFetchedUrls.delete(authorId);
      userZeroSaveCount.delete(authorId);
      return { hasMore: false };
    }
    
    // Track this URL
    fetchedUrls.add(fetchUrl);
    userFetchedUrls.set(authorId, fetchedUrls);
    
    logger.info(`📬 Fetching posts from: ${fetchUrl}`);
    
    // Fetch the outbox collection or page
    const outboxResponse = await fetch(fetchUrl, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      signal: AbortSignal.timeout(15000)
    });
    
    if (!outboxResponse.ok) {
      logger.warn(`Failed to fetch outbox: ${outboxResponse.status}`);
      userNextPageCache.delete(authorId);
      return { hasMore: false };
    }
    
    const outbox = await outboxResponse.json();
    
    // Get items from the collection
    let items: any[] = [];
    let nextPageUrl: string | null = null;
    
    if (outbox.orderedItems && Array.isArray(outbox.orderedItems)) {
      // This is already a page with items
      items = outbox.orderedItems.slice(0, limit);
      nextPageUrl = typeof outbox.next === 'string' ? outbox.next : outbox.next?.id || null;
    } else if (outbox.first) {
      // This is a collection - need to fetch the first page
      const firstPageUrl = typeof outbox.first === 'string' ? outbox.first : outbox.first.id;
      logger.info(`📬 Fetching first page: ${firstPageUrl}`);
      
      const pageResponse = await fetch(firstPageUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        signal: AbortSignal.timeout(15000)
      });
      
      if (pageResponse.ok) {
        const page = await pageResponse.json();
        items = (page.orderedItems || []).slice(0, limit);
        nextPageUrl = typeof page.next === 'string' ? page.next : page.next?.id || null;
      }
    }
    
    // Cache the next page URL for this user
    if (nextPageUrl) {
      userNextPageCache.set(authorId, nextPageUrl);
      logger.info(`📬 Cached next page URL: ${nextPageUrl}`);
    } else {
      userNextPageCache.delete(authorId);
      logger.info(`📬 No more pages available`);
    }
    
    if (items.length === 0) {
      logger.info(`📬 No posts found in outbox`);
      return { hasMore: false };
    }
    
    logger.info(`📬 Processing ${items.length} posts from outbox`);
    
    let savedCount = 0;
    let oldestId: string | undefined;
    
    // Import the proper converter
    const { noteToContent } = await import('./converters/fromActivityPub.js');
    
    for (const item of items) {
      try {
        // Handle both Create activities and direct Note objects
        const note = item.type === 'Create' ? item.object : item;
        
        // Skip non-Note types (but handle Question for polls)
        if (note.type !== 'Note' && note.type !== 'Article' && note.type !== 'Question') {
          continue;
        }
        
        // Track oldest ID for pagination
        oldestId = note.id;
        
        // Check if post already exists
        const { data: existing } = await supabase
          .from('posts')
          .select('id')
          .eq('ap_id', note.id)
          .maybeSingle();
        
        if (existing) {
          continue; // Already have this post
        }
        
        // Use proper content converter that handles mentions, hashtags, emoji, attachments
        const content = noteToContent(note);
        
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
        
        // Extract media attachments separately for the media_attachments column
        const mediaAttachments = extractMediaAttachments(note.attachment);
        
        // Build metadata for polls
        const metadata: any = {};
        if (note.type === 'Question') {
          const pollOptions = note.oneOf || note.anyOf || [];
          metadata.is_poll = true;
          metadata.poll_options = pollOptions.map((opt: any) => ({
            name: opt.name || '',
            votes: opt.replies?.totalItems || 0,
          }));
          metadata.poll_multiple_choice = !!note.anyOf;
          metadata.poll_end_time = note.endTime || note.closed || null;
          metadata.poll_closed = !!note.closed;
        }
        
        // Handle custom emoji from tags
        const customEmojis = extractCustomEmojis(note.tag);
        if (customEmojis.length > 0) {
          metadata.custom_emojis = customEmojis;
        }
        
        // Create the post with full content
        const postData: any = {
          ap_id: note.id,
          ap_type: note.type,
          author_id: authorId,
          content,
          visibility,
          is_local: false,
          created_at: note.published || new Date().toISOString(),
          content_warning: note.summary || null,
          is_sensitive: note.sensitive === true,
        };
        
        if (mediaAttachments.length > 0) {
          postData.media_attachments = mediaAttachments;
        }
        
        if (Object.keys(metadata).length > 0) {
          postData.metadata = metadata;
        }
        
        const { error: insertError } = await supabase
          .from('posts')
          .insert(postData);
        
        if (!insertError) {
          savedCount++;
        }
      } catch (postError) {
        logger.debug(`Failed to save post:`, postError);
      }
    }
    
    logger.info(`📬 Saved ${savedCount} new posts from remote user`);
    
    // Track consecutive zero-save fetches to avoid infinite pagination
    if (savedCount === 0) {
      const zeroCount = (userZeroSaveCount.get(authorId) || 0) + 1;
      userZeroSaveCount.set(authorId, zeroCount);
      
      if (zeroCount >= MAX_ZERO_SAVES) {
        logger.info(`📬 ${MAX_ZERO_SAVES} consecutive fetches with 0 new posts, stopping pagination`);
        userNextPageCache.delete(authorId);
        userFetchedUrls.delete(authorId);
        userZeroSaveCount.delete(authorId);
        return { hasMore: false };
      }
      
      logger.info(`📬 Zero new posts (${zeroCount}/${MAX_ZERO_SAVES} before giving up)`);
    } else {
      // Reset zero counter on successful save
      userZeroSaveCount.delete(authorId);
    }
    
    // Has more only if there's a valid next page
    const hasMore = !!nextPageUrl;
    
    logger.info(`📬 Result: saved ${savedCount} new posts, has_more=${hasMore}`);
    
    return { 
      hasMore,
      oldestId,
      nextPageUrl: nextPageUrl || undefined
    };
    
  } catch (error) {
    logger.warn(`Failed to fetch outbox posts:`, error);
    userNextPageCache.delete(authorId);
    userFetchedUrls.delete(authorId);
    userZeroSaveCount.delete(authorId);
    return { hasMore: false };
  }
}

/**
 * Extract media attachments from ActivityPub attachment array
 */
function extractMediaAttachments(attachments: any): any[] {
  if (!attachments || !Array.isArray(attachments)) {
    return [];
  }
  
  return attachments.map((att: any) => ({
    type: att.type || 'Document',
    mediaType: att.mediaType || 'application/octet-stream',
    url: att.url,
    name: att.name || null,
    width: att.width || null,
    height: att.height || null,
    blurhash: att.blurhash || null,
  })).filter((att: any) => att.url);
}

/**
 * Extract custom emoji definitions from ActivityPub tags
 */
function extractCustomEmojis(tags: any): any[] {
  if (!tags || !Array.isArray(tags)) {
    return [];
  }
  
  return tags
    .filter((tag: any) => tag.type === 'Emoji')
    .map((tag: any) => ({
      name: tag.name?.replace(/:/g, '') || '',
      url: tag.icon?.url || tag.icon,
      id: tag.id || `remote-${tag.name?.replace(/:/g, '')}`,
    }));
}

export default router;

