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

      const responseText = await webfingerResponse.text();
      const contentType = webfingerResponse.headers.get('content-type') || '';
      
      let webfinger: { subject?: string; links?: Array<{ rel: string; type?: string; href?: string }> };
      
      // Check if response is XML and parse it
      if (contentType.includes('xml') || responseText.trim().startsWith('<?xml') || responseText.trim().startsWith('<XRD')) {
        logger.info(`📋 WebFinger returned XML, parsing...`);
        
        // Parse XML WebFinger (XRD format)
        // Extract links from XML like: <Link rel="self" type="application/activity+json" href="..."/>
        const subjectMatch = responseText.match(/<Subject>([^<]+)<\/Subject>/);
        const selfLinkMatch = responseText.match(/<Link[^>]+rel="self"[^>]+type="application\/activity\+json"[^>]+href="([^"]+)"/);
        const altSelfLinkMatch = responseText.match(/<Link[^>]+href="([^"]+)"[^>]+type="application\/activity\+json"[^>]+rel="self"/);
        
        const actorHref = selfLinkMatch?.[1] || altSelfLinkMatch?.[1];
        
        if (!actorHref) {
          logger.warn(`❌ Could not find ActivityPub link in XML WebFinger for ${username}@${domain}`);
          return res.status(404).json({
            error: 'User is not on an ActivityPub-compatible instance',
            details: 'No ActivityPub self link found in XRD response'
          });
        }
        
        // Convert to JSON-like structure
        webfinger = {
          subject: subjectMatch?.[1] || `acct:${username}@${domain}`,
          links: [
            { rel: 'self', type: 'application/activity+json', href: actorHref }
          ]
        };
        
        logger.info(`📋 Parsed XML WebFinger: found actor at ${actorHref}`);
      } else {
        // Try to parse as JSON
        try {
          webfinger = JSON.parse(responseText);
        } catch (parseError) {
          logger.error(`❌ Failed to parse WebFinger response: ${responseText.substring(0, 100)}...`);
          return res.status(500).json({
            error: 'Invalid WebFinger response from remote instance',
            details: 'Response was neither valid JSON nor XML'
          });
        }
      }
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
 * Fetch reactions/likes for a remote post
 * POST /api/federation/fetch-reactions
 * Body: { post_ap_id: string, post_id?: string }
 */
router.post(
  '/api/federation/fetch-reactions',
  asyncHandler(async (req: Request, res: Response) => {
    const { post_ap_id, post_id } = req.body;

    if (!post_ap_id) {
      return res.status(400).json({ error: 'post_ap_id is required' });
    }

    const supabase = getSupabaseClient();
    
    logger.info(`📬 Fetching reactions for remote post: ${post_ap_id}`);

    try {
      const reactions = await fetchRemotePostReactions(post_ap_id, post_id, supabase);
      
      // Fetch the updated post metadata to return to the frontend
      let remote_reactions = null;
      if (post_id) {
        const { data: updatedPost } = await supabase
          .from('posts')
          .select('metadata')
          .eq('id', post_id)
          .single();
        
        remote_reactions = updatedPost?.metadata?.remote_reactions || null;
      }
      
      return res.json({
        success: true,
        reactions,
        count: reactions.length,
        remote_reactions, // Include the aggregated data for immediate UI update
      });
    } catch (error: any) {
      logger.error('Failed to fetch reactions:', error);
      return res.status(500).json({ error: 'Failed to fetch reactions' });
    }
  })
);

/**
 * Extract note ID from a Misskey URL
 * e.g., "https://misskey.io/notes/abc123" -> "abc123"
 */
function extractMisskeyNoteId(url: string): string | null {
  const match = url.match(/\/notes\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Check if a URL is from a Misskey-like instance
 */
function isMisskeyInstance(url: string): boolean {
  // Common Misskey instance patterns
  const misskeyPatterns = [
    /misskey\./i,
    /\.misskey\./i,
    /calckey\./i,
    /firefish\./i,
    /sharkey\./i,
    /foundkey\./i,
    /\/notes\//i,  // Misskey uses /notes/ in URLs
  ];
  return misskeyPatterns.some(pattern => pattern.test(url));
}

/**
 * Fetch reactions using Misskey API
 */
async function fetchMisskeyReactions(
  domain: string,
  noteId: string,
  postId: string | undefined,
  supabase: any
): Promise<any[]> {
  try {
    logger.info(`📬 Fetching reactions via Misskey API for note: ${noteId} on ${domain}`);
    
    const apiUrl = `https://${domain}/api/notes/reactions`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      body: JSON.stringify({
        noteId: noteId,
        limit: 50,
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      logger.warn(`Misskey reactions API failed: ${response.status}`);
      return [];
    }

    const reactionsData = await response.json();
    logger.info(`📬 Misskey returned ${reactionsData.length} reactions`);

    // Aggregate reactions by emoji type for counting
    // Store emoji URLs for custom emojis
    const reactionCounts: Map<string, { count: number; emoji_url?: string; is_custom: boolean }> = new Map();
    const reactions: any[] = [];
    
    // Fetch custom emoji definitions from the remote instance
    // Two types of custom emojis in reactions:
    // 1. Native to origin instance (e.g., :kawa_yu@.: on misskey.io) - need to fetch from origin's emoji API
    // 2. Third-party emojis (e.g., :suteki2@fedibird.com:) - included in note's reactionEmojis
    
    let thirdPartyEmojis: Record<string, string> = {};  // Emojis from other instances (via reactionEmojis)
    let originInstanceEmojis: Record<string, string> = {};  // Emojis native to the origin instance
    
    try {
      const noteResponse = await fetch(`https://${domain}/api/notes/show`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        body: JSON.stringify({ noteId }),
        signal: AbortSignal.timeout(10000)
      });
      
      if (noteResponse.ok) {
        const noteData = await noteResponse.json();
        // reactionEmojis contains third-party emojis (from other instances, federated through this one)
        if (noteData.reactionEmojis) {
          thirdPartyEmojis = noteData.reactionEmojis;
          logger.info(`📬 Found ${Object.keys(thirdPartyEmojis).length} third-party emoji definitions`);
        }
      }
    } catch (e) {
      logger.warn(`📬 Could not fetch note emoji definitions: ${e}`);
    }
    
    // Collect emojis native to the origin instance (marked with @. in Misskey)
    const originEmojiNames: string[] = [];
    for (const reaction of reactionsData) {
      const emoji = reaction.type || '';
      // Origin instance emojis end with @. like :kawa_yu@.:
      if (emoji.startsWith(':') && emoji.endsWith('@.:')) {
        const emojiName = emoji.slice(1, -3); // Remove : and @.:
        originEmojiNames.push(emojiName);
      }
    }
    
    // Fetch origin instance emoji URLs if we have any
    if (originEmojiNames.length > 0) {
      try {
        logger.info(`📬 Fetching ${originEmojiNames.length} origin-instance emojis from ${domain}`);
        const emojiResponse = await fetch(`https://${domain}/api/emojis`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10000)
        });
        
        if (emojiResponse.ok) {
          const emojiData = await emojiResponse.json();
          // emojiData.emojis is an array of { name, url, ... }
          if (emojiData.emojis && Array.isArray(emojiData.emojis)) {
            for (const e of emojiData.emojis) {
              if (originEmojiNames.includes(e.name)) {
                originInstanceEmojis[`:${e.name}@.:`] = e.url;
                logger.debug(`📬 Found origin emoji :${e.name}@.: -> ${e.url}`);
              }
            }
            logger.info(`📬 Found ${Object.keys(originInstanceEmojis).length} origin-instance emoji URLs`);
          }
        }
      } catch (e) {
        logger.warn(`📬 Could not fetch origin-instance emoji definitions: ${e}`);
        
        // Fallback: Try to construct URLs directly (Misskey standard pattern)
        for (const name of originEmojiNames) {
          const fallbackUrl = `https://${domain}/emoji/${name}.webp`;
          originInstanceEmojis[`:${name}@.:`] = fallbackUrl;
          logger.debug(`📬 Using fallback URL for :${name}@.: -> ${fallbackUrl}`);
        }
      }
    }
    
    // Just aggregate reactions by emoji - no need to create profiles for every reactor
    for (const reaction of reactionsData) {
      const user = reaction.user;
      const emoji = reaction.type || '❤️';
      
      // Check if this is a custom emoji and get its URL
      const isCustomEmoji = emoji.startsWith(':') && emoji.endsWith(':');
      let emojiUrl: string | undefined;
      
      if (isCustomEmoji) {
        // Check if it's an origin-instance emoji (ends with @.:)
        if (emoji.endsWith('@.:')) {
          emojiUrl = originInstanceEmojis[emoji];
        } else {
          // Try to find emoji URL from third-party emojis (federated through origin)
          // The key in reactionEmojis is the emoji name without colons
          const emojiName = emoji.slice(1, -1); // Remove : from both ends
          emojiUrl = thirdPartyEmojis[emojiName] || thirdPartyEmojis[emoji];
        }
        
        if (emojiUrl) {
          logger.debug(`📬 Found URL for custom emoji ${emoji}: ${emojiUrl}`);
        } else {
          logger.debug(`📬 No URL found for custom emoji ${emoji}`);
        }
      }
      
      // Track counts per emoji with URL if available
      const existing = reactionCounts.get(emoji) || { count: 0, is_custom: isCustomEmoji, emoji_url: undefined };
      existing.count++;
      if (emojiUrl && !existing.emoji_url) {
        existing.emoji_url = emojiUrl;
      }
      reactionCounts.set(emoji, existing);
      
      // Cache the emoji in remote_emojis_cache for the emoji importer feature
      if (isCustomEmoji && emojiUrl) {
        try {
          // Extract shortcode and origin domain from the emoji
          let shortcode: string;
          let originDomain: string;
          let normalizedFullCode: string;
          
          if (emoji.endsWith('@.:')) {
            // Origin instance emoji: :kawa_yu@.: -> shortcode=kawa_yu, domain=misskey.io
            shortcode = emoji.slice(1, -3);
            originDomain = domain;
            // Store full code WITHOUT colons (just shortcode@domain)
            normalizedFullCode = `${shortcode}@${domain}`;
          } else if (emoji.includes('@')) {
            // Third-party emoji: :suteki2@fedibird.com: -> shortcode=suteki2, domain=fedibird.com
            const match = emoji.match(/:([^@]+)@([^:]+):/);
            if (match) {
              shortcode = match[1];
              originDomain = match[2];
              normalizedFullCode = `${shortcode}@${originDomain}`;
            } else {
              shortcode = emoji.slice(1, -1);
              originDomain = domain;
              normalizedFullCode = `${shortcode}@${domain}`;
            }
          } else {
            // Simple emoji: :smile: -> shortcode=smile, domain=origin
            shortcode = emoji.slice(1, -1);
            originDomain = domain;
            normalizedFullCode = `${shortcode}@${domain}`;
          }
          
          // Upsert into remote_emojis_cache
          await supabase.rpc('upsert_remote_emoji', {
            p_shortcode: shortcode,
            p_origin_domain: originDomain,
            p_full_code: normalizedFullCode,
            p_url: emojiUrl,
          });
          
          logger.debug(`📬 Cached remote emoji: ${shortcode}@${originDomain}`);
        } catch (cacheError) {
          // Don't fail the whole operation if caching fails
          logger.debug(`📬 Could not cache emoji ${emoji}: ${cacheError}`);
        }
      }
      
      // Build reaction object with actor info (for display purposes only, no DB storage)
      reactions.push({
        emoji,
        emoji_url: emojiUrl,
        content: emoji,
        actor: {
          username: user?.username || 'unknown',
          display_name: user?.name || user?.username,
          avatar_url: user?.avatarUrl,
          domain: user?.host || domain,
          is_local: false,
        },
        actor_url: user?.id ? `https://${user.host || domain}/users/${user.id}` : null,
      });
    }

    // Update post metadata with aggregated reaction counts (lightweight approach)
    if (postId && reactionCounts.size > 0) {
      // Get current post metadata
      const { data: currentPost } = await supabase
        .from('posts')
        .select('metadata')
        .eq('id', postId)
        .single();
      
      // Group reactions by emoji with first 10 reactors
      const reactorsByEmoji: Map<string, Array<{
        username: string;
        display_name: string;
        avatar_url: string;
        domain: string;
      }>> = new Map();
      
      for (const reaction of reactions) {
        const emoji = reaction.emoji;
        if (!reactorsByEmoji.has(emoji)) {
          reactorsByEmoji.set(emoji, []);
        }
        const reactors = reactorsByEmoji.get(emoji)!;
        // Only keep first 10 reactors per emoji
        if (reactors.length < 10 && reaction.actor) {
          reactors.push({
            username: reaction.actor.username,
            display_name: reaction.actor.display_name || reaction.actor.username,
            avatar_url: reaction.actor.avatar_url,
            domain: reaction.actor.domain,
          });
        }
      }
      
      // Build reaction summary with emoji URLs and reactor info
      const reactionSummary: Record<string, { 
        count: number; 
        url?: string;
        reactors: Array<{ username: string; display_name: string; avatar_url: string; domain: string }>;
      }> = {};
      
      for (const [emoji, data] of reactionCounts) {
        reactionSummary[emoji] = { 
          count: data.count,
          url: data.emoji_url,
          reactors: reactorsByEmoji.get(emoji) || [],
        };
      }
      
      // Update post metadata with remote reactions
      const updatedMetadata = {
        ...(currentPost?.metadata || {}),
        remote_reactions: reactionSummary,
        remote_reactions_fetched_at: new Date().toISOString(),
      };
      
      const { error: updateError } = await supabase
        .from('posts')
        .update({ 
          metadata: updatedMetadata,
          favorites_count: Array.from(reactionCounts.values()).reduce((sum, r) => sum + r.count, 0),
        })
        .eq('id', postId);
      
      if (updateError) {
        logger.warn(`📬 Failed to update post metadata: ${updateError.message}`);
      } else {
        const totalReactors = Array.from(reactorsByEmoji.values()).reduce((sum, r) => sum + r.length, 0);
        logger.info(`📬 Updated post with ${reactionCounts.size} reaction types, ${totalReactors} reactor profiles`);
      }
    }
    
    // Log reaction summary
    const summary = Array.from(reactionCounts.entries())
      .map(([emoji, data]) => `${emoji}: ${data.count}`)
      .join(', ');
    logger.info(`📬 Reaction breakdown: ${summary}`);

    return reactions;
  } catch (error) {
    logger.error(`Failed to fetch Misskey reactions:`, error);
    return [];
  }
}

/**
 * Fetch reactions from a remote post's likes collection
 */
async function fetchRemotePostReactions(
  postApId: string,
  postId: string | undefined,
  supabase: any
): Promise<any[]> {
  try {
    // Check if this is a Misskey instance and try their API first
    if (isMisskeyInstance(postApId)) {
      const noteId = extractMisskeyNoteId(postApId);
      const domain = new URL(postApId).hostname;
      
      if (noteId) {
        const misskeyReactions = await fetchMisskeyReactions(domain, noteId, postId, supabase);
        if (misskeyReactions.length > 0) {
          return misskeyReactions;
        }
        // Fall through to standard ActivityPub if Misskey API fails
        logger.info(`📬 Misskey API returned no reactions, trying standard ActivityPub...`);
      }
    }

    // Standard ActivityPub approach
    // First, fetch the post object to get the likes collection URL
    const postResponse = await fetch(postApId, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!postResponse.ok) {
      logger.warn(`Failed to fetch post: ${postResponse.status}`);
      return [];
    }

    const post = await postResponse.json();
    
    // Log the post structure for debugging
    logger.info(`📬 Post structure keys: ${Object.keys(post).join(', ')}`);
    
    // Extract counts from the post object itself if available
    // Mastodon style: favouritesCount, repliesCount, sharesCount
    // Misskey style: _misskey_reaction, _misskey_votes
    const counts = {
      likes: post.likes?.totalItems || post.favouritesCount || post._misskey_likes || 0,
      replies: post.replies?.totalItems || post.repliesCount || 0,
      shares: post.shares?.totalItems || post.sharesCount || 0,
    };
    
    // Update the local post with these counts if we have a post_id
    if (postId && (counts.likes > 0 || counts.replies > 0 || counts.shares > 0)) {
      logger.info(`📬 Updating post counts: likes=${counts.likes}, replies=${counts.replies}, shares=${counts.shares}`);
      await supabase
        .from('posts')
        .update({
          favorites_count: counts.likes,
          replies_count: counts.replies,
          reblogs_count: counts.shares,
        })
        .eq('id', postId);
    }
    
    // Get likes collection URL - check multiple possible locations
    const likesUrl = post.likes || post.reactions || post._misskey_likes;
    if (!likesUrl) {
      logger.info(`📬 No likes collection found for post (available: ${Object.keys(post).filter(k => k.includes('like') || k.includes('reaction')).join(', ') || 'none'})`);
      // Return with counts even if no likes collection
      return [];
    }

    // Fetch the likes collection
    const likesCollectionUrl = typeof likesUrl === 'string' ? likesUrl : likesUrl.id;
    logger.info(`📬 Fetching likes from: ${likesCollectionUrl}`);

    const likesResponse = await fetch(likesCollectionUrl, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!likesResponse.ok) {
      logger.warn(`Failed to fetch likes collection: ${likesResponse.status}`);
      return [];
    }

    const likesCollection = await likesResponse.json();
    
    // Extract likes/reactions
    let items: any[] = [];
    
    if (likesCollection.orderedItems) {
      items = likesCollection.orderedItems;
    } else if (likesCollection.items) {
      items = likesCollection.items;
    } else if (likesCollection.first) {
      // Need to fetch first page
      const firstPageUrl = typeof likesCollection.first === 'string' 
        ? likesCollection.first 
        : likesCollection.first.id;
      
      const pageResponse = await fetch(firstPageUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        signal: AbortSignal.timeout(10000)
      });

      if (pageResponse.ok) {
        const page = await pageResponse.json();
        items = page.orderedItems || page.items || [];
      }
    }

    logger.info(`📬 Found ${items.length} reactions`);

    // Process reactions and store them if we have a local post_id
    const reactions: any[] = [];
    
    for (const item of items.slice(0, 50)) { // Limit to 50 reactions
      try {
        // Handle different reaction formats
        let actorUrl: string;
        let emoji: string = '❤️'; // Default to heart
        let reactionContent: string | null = null;

        if (typeof item === 'string') {
          // Simple actor URL (just a like)
          actorUrl = item;
        } else if (item.type === 'Like' || item.type === 'EmojiReaction') {
          actorUrl = typeof item.actor === 'string' ? item.actor : item.actor?.id;
          
          // Check for custom emoji content (Misskey style)
          if (item.content) {
            emoji = item.content;
            reactionContent = item.content;
          }
          if (item._misskey_reaction) {
            emoji = item._misskey_reaction;
            reactionContent = item._misskey_reaction;
          }
          // Check for tag-based emoji (Mastodon style)
          if (item.tag && Array.isArray(item.tag)) {
            const emojiTag = item.tag.find((t: any) => t.type === 'Emoji');
            if (emojiTag) {
              emoji = emojiTag.name || emoji;
              reactionContent = emojiTag.name;
            }
          }
        } else {
          continue;
        }

        if (!actorUrl) continue;

        // Try to get actor info
        let actorInfo: any = { url: actorUrl };
        
        // Check if we have this user locally
        const { data: localProfile } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url, domain, is_local')
          .eq('federated_id', actorUrl)
          .maybeSingle();

        if (localProfile) {
          actorInfo = {
            id: localProfile.id,
            username: localProfile.username,
            display_name: localProfile.display_name,
            avatar_url: localProfile.avatar_url,
            domain: localProfile.domain,
            is_local: localProfile.is_local,
          };
        } else {
          // Extract username from URL
          const urlParts = actorUrl.split('/');
          const username = urlParts[urlParts.length - 1];
          const domain = new URL(actorUrl).hostname;
          actorInfo = {
            username,
            domain,
            is_local: false,
          };
        }

        reactions.push({
          emoji,
          content: reactionContent,
          actor: actorInfo,
          actor_url: actorUrl,
        });

        // If we have a local post ID, store the reaction
        if (postId && localProfile?.id) {
          await supabase
            .from('post_interactions')
            .upsert({
              user_id: localProfile.id,
              post_id: postId,
              interaction_type: 'emoji_reaction',
              emoji_content: reactionContent || emoji,
              ap_id: item.id || `${actorUrl}#like-${postId}`,
            }, {
              onConflict: 'user_id,post_id,interaction_type',
            });
        }
      } catch (err) {
        logger.debug(`Failed to process reaction:`, err);
      }
    }

    logger.info(`📬 Processed ${reactions.length} reactions for post`);
    return reactions;

  } catch (error) {
    logger.warn(`Failed to fetch remote reactions:`, error);
    return [];
  }
}

/**
 * Fetch replies for a remote post
 * POST /api/federation/fetch-replies
 * Body: { post_ap_id: string, post_id?: string, limit?: number }
 */
router.post(
  '/api/federation/fetch-replies',
  asyncHandler(async (req: Request, res: Response) => {
    const { post_ap_id, post_id, limit = 10 } = req.body;

    if (!post_ap_id) {
      return res.status(400).json({ error: 'post_ap_id is required' });
    }

    const supabase = getSupabaseClient();
    
    logger.info(`📬 Fetching replies for remote post: ${post_ap_id}`);

    try {
      const replies = await fetchRemotePostReplies(post_ap_id, post_id, supabase, Math.min(limit, 20));
      
      return res.json({
        success: true,
        replies,
        count: replies.length,
      });
    } catch (error: any) {
      logger.error('Failed to fetch replies:', error);
      return res.status(500).json({ error: 'Failed to fetch replies' });
    }
  })
);

/**
 * Fetch replies using Misskey API
 */
async function fetchMisskeyReplies(
  domain: string,
  noteId: string,
  parentPostId: string | undefined,
  supabase: any,
  limit: number = 10
): Promise<any[]> {
  try {
    logger.info(`📬 Fetching replies via Misskey API for note: ${noteId} on ${domain}`);
    
    const apiUrl = `https://${domain}/api/notes/children`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      body: JSON.stringify({
        noteId: noteId,
        limit: limit,
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      logger.warn(`Misskey children API failed: ${response.status}`);
      return [];
    }

    const childNotes = await response.json();
    logger.info(`📬 Misskey returned ${childNotes.length} replies/children`);

    const replies: any[] = [];
    
    for (const note of childNotes) {
      const user = note.user;
      const userDomain = user?.host || domain;
      const noteApId = `https://${domain}/notes/${note.id}`;
      
      // Check if we already have this reply
      const { data: existing } = await supabase
        .from('posts')
        .select('id')
        .eq('ap_id', noteApId)
        .maybeSingle();

      if (existing) {
        // Return existing reply data
        const { data: fullPost } = await supabase
          .from('posts')
          .select(`
            *,
            author:profiles!posts_author_id_fkey(
              id, username, display_name, avatar_url, domain, is_local
            )
          `)
          .eq('id', existing.id)
          .single();
        
        if (fullPost) {
          replies.push(fullPost);
        }
        continue;
      }

      // Find or create the author profile
      let authorId: string | null = null;
      
      if (user?.username) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('username', user.username)
          .eq('domain', userDomain)
          .maybeSingle();
        
        if (profile) {
          authorId = profile.id;
        } else {
          // Create a minimal profile for the user
          const { data: newProfile, error } = await supabase
            .from('profiles')
            .insert({
              username: user.username,
              display_name: user.name || user.username,
              avatar_url: user.avatarUrl,
              domain: userDomain,
              is_local: false,
              federated_id: `https://${userDomain}/users/${user.id}`,
            })
            .select('id')
            .single();
          
          if (!error && newProfile) {
            authorId = newProfile.id;
          }
        }
      }

      if (!authorId) continue;

      // Parse the note content as any[] to allow different content types
      const content: any[] = note.text ? [{ type: 'text', content: note.text }] : [];
      
      // Add any files/attachments
      if (note.files && Array.isArray(note.files)) {
        for (const file of note.files) {
          content.push({
            type: 'file',
            url: file.url,
            name: file.name,
            fileType: file.type,
            width: file.properties?.width,
            height: file.properties?.height,
            blurhash: file.blurhash,
          });
        }
      }

      // Create the reply
      const { data: newReply, error } = await supabase
        .from('posts')
        .insert({
          author_id: authorId,
          content: content,
          ap_id: noteApId,
          is_local: false,
          visibility: note.visibility === 'public' ? 'public' 
            : note.visibility === 'home' ? 'unlisted'
            : note.visibility === 'followers' ? 'followers'
            : 'direct',
          in_reply_to: parentPostId,
          metadata: {
            in_reply_to_ap_url: `https://${domain}/notes/${noteId}`,
          },
          created_at: note.createdAt,
        })
        .select(`
          *,
          author:profiles!posts_author_id_fkey(
            id, username, display_name, avatar_url, domain, is_local
          )
        `)
        .single();

      if (!error && newReply) {
        replies.push(newReply);
      }
    }

    return replies;
  } catch (error) {
    logger.error(`Failed to fetch Misskey replies:`, error);
    return [];
  }
}

/**
 * Fetch replies from a remote post's replies collection
 */
async function fetchRemotePostReplies(
  postApId: string,
  postId: string | undefined,
  supabase: any,
  limit: number = 10
): Promise<any[]> {
  try {
    // Check if this is a Misskey instance and try their API first
    if (isMisskeyInstance(postApId)) {
      const noteId = extractMisskeyNoteId(postApId);
      const domain = new URL(postApId).hostname;
      
      if (noteId) {
        const misskeyReplies = await fetchMisskeyReplies(domain, noteId, postId, supabase, limit);
        if (misskeyReplies.length > 0) {
          return misskeyReplies;
        }
        // Fall through to standard ActivityPub if Misskey API fails
        logger.info(`📬 Misskey API returned no replies, trying standard ActivityPub...`);
      }
    }

    // Standard ActivityPub approach
    // Fetch the post object to get the replies collection URL
    const postResponse = await fetch(postApId, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!postResponse.ok) {
      logger.warn(`Failed to fetch post: ${postResponse.status}`);
      return [];
    }

    const post = await postResponse.json();
    
    // Get replies collection URL
    const repliesUrl = post.replies;
    if (!repliesUrl) {
      logger.info(`📬 No replies collection found for post`);
      return [];
    }

    const repliesCollectionUrl = typeof repliesUrl === 'string' ? repliesUrl : repliesUrl.id;
    logger.info(`📬 Fetching replies from: ${repliesCollectionUrl}`);

    const repliesResponse = await fetch(repliesCollectionUrl, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!repliesResponse.ok) {
      logger.warn(`Failed to fetch replies collection: ${repliesResponse.status}`);
      return [];
    }

    const repliesCollection = await repliesResponse.json();
    
    // Extract reply items
    let items: any[] = [];
    
    if (repliesCollection.orderedItems) {
      items = repliesCollection.orderedItems;
    } else if (repliesCollection.items) {
      items = repliesCollection.items;
    } else if (repliesCollection.first) {
      // Need to fetch first page
      const firstPageUrl = typeof repliesCollection.first === 'string' 
        ? repliesCollection.first 
        : repliesCollection.first.id;
      
      const pageResponse = await fetch(firstPageUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        signal: AbortSignal.timeout(10000)
      });

      if (pageResponse.ok) {
        const page = await pageResponse.json();
        items = page.orderedItems || page.items || [];
      }
    }

    logger.info(`📬 Found ${items.length} replies`);

    // Import converters
    const { noteToContent } = await import('./converters/fromActivityPub.js');
    
    // Process replies and save them
    const savedReplies: any[] = [];
    
    for (const item of items.slice(0, limit)) {
      try {
        // Get the actual Note object
        let note = item;
        if (typeof item === 'string') {
          // It's a URL - need to fetch it
          const noteResponse = await fetch(item, {
            headers: {
              'Accept': 'application/activity+json, application/ld+json',
              'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
            },
            signal: AbortSignal.timeout(5000)
          });
          if (!noteResponse.ok) continue;
          note = await noteResponse.json();
        } else if (item.type === 'Create') {
          note = item.object;
        }

        if (note.type !== 'Note' && note.type !== 'Article') {
          continue;
        }

        // Check if reply already exists
        const { data: existing } = await supabase
          .from('posts')
          .select('id')
          .eq('ap_id', note.id)
          .maybeSingle();

        if (existing) {
          savedReplies.push({ id: existing.id, ap_id: note.id, existing: true });
          continue;
        }

        // Get or create the author
        const authorUrl = typeof note.attributedTo === 'string' 
          ? note.attributedTo 
          : note.attributedTo?.id;
        
        if (!authorUrl) continue;

        // Check if we have this user locally
        let { data: author } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', authorUrl)
          .maybeSingle();

        if (!author) {
          // Try to create the user
          try {
            const actorResponse = await fetch(authorUrl, {
              headers: {
                'Accept': 'application/activity+json, application/ld+json',
                'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
              },
              signal: AbortSignal.timeout(5000)
            });
            if (actorResponse.ok) {
              const actor = await actorResponse.json();
              const { actorToProfile } = await import('./converters/fromActivityPub.js');
              const profileData = actorToProfile(actor);
              
              const { data: newProfile } = await supabase
                .from('profiles')
                .insert({
                  ...profileData,
                  is_local: false,
                })
                .select('id')
                .single();
              
              author = newProfile;
            }
          } catch (err) {
            logger.debug(`Failed to create author for reply:`, err);
            continue;
          }
        }

        if (!author) continue;

        // Create the reply post
        const content = noteToContent(note);
        
        const replyData: any = {
          ap_id: note.id,
          ap_type: note.type,
          author_id: author.id,
          content,
          visibility: 'public',
          is_local: false,
          created_at: note.published || new Date().toISOString(),
          in_reply_to: postId,
          metadata: {
            in_reply_to_ap_url: postApId,
          },
        };

        const { data: newReply, error: insertError } = await supabase
          .from('posts')
          .insert(replyData)
          .select('id')
          .single();

        if (!insertError && newReply) {
          savedReplies.push({ id: newReply.id, ap_id: note.id, new: true });
          logger.debug(`📬 Saved reply: ${note.id}`);
        }
      } catch (err) {
        logger.debug(`Failed to process reply:`, err);
      }
    }

    logger.info(`📬 Saved ${savedReplies.filter(r => r.new).length} new replies`);
    return savedReplies;

  } catch (error) {
    logger.warn(`Failed to fetch remote replies:`, error);
    return [];
  }
}

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
        // Handle different activity types
        const activityType = item.type;
        
        // Handle Announce (reblog/boost)
        if (activityType === 'Announce') {
          oldestId = item.id;
          
          // Check if we already have this reblog
          const { data: existingReblog } = await supabase
            .from('posts')
            .select('id')
            .eq('ap_id', item.id)
            .maybeSingle();
          
          if (existingReblog) {
            continue;
          }
          
          // Get the original post URL
          const originalUrl = typeof item.object === 'string' ? item.object : item.object?.id;
          if (!originalUrl) continue;
          
          // Try to find or fetch the original post
          let originalPostId: string | null = null;
          const { data: originalPost } = await supabase
            .from('posts')
            .select('id')
            .eq('ap_id', originalUrl)
            .maybeSingle();
          
          if (originalPost) {
            originalPostId = originalPost.id;
          }
          // Note: We could fetch the original post here, but that's expensive
          // For now, just store the reference in metadata
          
          const reblogData: any = {
            ap_id: item.id,
            ap_type: 'Announce',
            author_id: authorId,
            content: [], // Reblogs typically don't have their own content
            visibility: 'public',
            is_local: false,
            created_at: item.published || new Date().toISOString(),
            metadata: {
              reblog_of: originalPostId,
              reblog_of_ap_url: originalUrl,
              is_reblog: true,
            },
          };
          
          const { error: reblogError } = await supabase
            .from('posts')
            .insert(reblogData);
          
          if (!reblogError) {
            savedCount++;
            logger.debug(`📬 Saved reblog of ${originalUrl}`);
          }
          continue;
        }
        
        // Handle Create activities and direct Note objects
        const note = activityType === 'Create' ? item.object : item;
        
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
        
        // Build metadata for polls, quotes, replies
        const metadata: any = {};
        
        // Handle polls (Question type)
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
        
        // Handle quote posts (Mastodon uses quoteUrl, Misskey uses _misskey_quote)
        const quoteUrl = note.quoteUrl || note.quoteUri || note._misskey_quote;
        if (quoteUrl) {
          metadata.is_quote = true;
          metadata.quote_url = quoteUrl;
          logger.debug(`📬 Found quote post referencing: ${quoteUrl}`);
        }
        
        // Handle custom emoji from tags
        const customEmojis = extractCustomEmojis(note.tag);
        if (customEmojis.length > 0) {
          metadata.custom_emojis = customEmojis;
        }
        
        // Handle reply context
        let inReplyToId: string | null = null;
        if (note.inReplyTo) {
          metadata.in_reply_to_ap_url = note.inReplyTo;
          
          // Try to find the parent post locally
          const { data: parentPost } = await supabase
            .from('posts')
            .select('id')
            .eq('ap_id', note.inReplyTo)
            .maybeSingle();
          
          if (parentPost) {
            inReplyToId = parentPost.id;
          }
        }
        
        // Extract counts from the note (Mastodon/Misskey style)
        const repliesCount = note.replies?.totalItems || note.repliesCount || 0;
        const likesCount = note.likes?.totalItems || note.favouritesCount || 0;
        const sharesCount = note.shares?.totalItems || note.sharesCount || 0;
        
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
          replies_count: repliesCount,
          favorites_count: likesCount,
          reblogs_count: sharesCount,
        };
        
        // Add reply reference if found
        if (inReplyToId) {
          postData.in_reply_to = inReplyToId;
        }
        
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

