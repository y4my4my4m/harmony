import { Router, Request, Response } from 'express';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { profileToActor } from './converters/toActivityPub.js';
import { actorToProfile, noteToContent } from './converters/fromActivityPub.js';
import { resolveLocalProfileEmojis } from './emojiResolver.js';
import { ActivityProcessor } from './ActivityProcessor.js';
import { SignatureService } from './SignatureService.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { validateExternalHostname, safeFetch } from '../utils/ssrfProtection.js';
import { discoveryLimiter } from '../middleware/rateLimit.js';

const router = Router();

// ============================================================================
// Remote-reaction fetch coalescing
// ----------------------------------------------------------------------------
// `fetchRemotePostReactions` does up to TWO outbound HTTP calls per post
// (post object → likes collection). To avoid hammering remote instances when
// many users browse the same profile or a single user refreshes rapidly:
//
//   * TTL cache: if `posts.metadata.remote_reactions_fetched_at` is fresher
//     than REACTIONS_TTL_MS, callers skip the fetch entirely and read the
//     already-aggregated `remote_reactions` straight from the DB row they
//     already SELECTed.
//   * In-flight dedup: concurrent fetches for the same `post_ap_id` share
//     a single Promise, so two users opening the same profile at once
//     produce one outbound burst, not two.
//
// 30s is chosen so that new likes arriving via federation push (/inbox →
// post_interactions trigger → broadcast) keep showing in real time on the
// hot path; the cache only governs the "open a stale profile" path. Tune
// in one place if needed.
// ============================================================================
const REACTIONS_TTL_MS = 30_000;
const inFlightReactionFetches = new Map<string, Promise<any[]>>();

function isReactionsCacheFresh(metadata: any): boolean {
  const fetchedAt = metadata?.remote_reactions_fetched_at;
  if (!fetchedAt) return false;
  const t = Date.parse(fetchedAt);
  return Number.isFinite(t) && Date.now() - t < REACTIONS_TTL_MS;
}

/**
 * Mark a post as "we tried to fetch reactions and got nothing useful" so
 * the TTL cache short-circuits the next call. This is what stops deleted
 * remote posts (404 on every outbound request) from being re-tried on
 * every feed refresh. Stores ONLY the timestamp; existing
 * `remote_reactions` (if any) is preserved.
 */
async function markRemoteReactionsAttempted(
  postId: string | undefined,
  supabase: any
): Promise<void> {
  if (!postId) return;
  try {
    const { data } = await supabase
      .from('posts')
      .select('metadata')
      .eq('id', postId)
      .maybeSingle();
    await supabase
      .from('posts')
      .update({
        metadata: {
          ...(data?.metadata || {}),
          remote_reactions_fetched_at: new Date().toISOString(),
        },
      })
      .eq('id', postId);
  } catch (err) {
    logger.debug(`📬 markRemoteReactionsAttempted failed (non-fatal): ${err}`);
  }
}

/**
 * Lookup remote user via WebFinger
 * POST /lookup-user (proxied via /api/federation/lookup-user)
 * Body: { handle: "username@domain" }
 * 
 * This endpoint proxies WebFinger requests to bypass CORS restrictions
 */
router.post(
  '/lookup-user',
  discoveryLimiter,
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

    // SECURITY: Prevent looking up local users via federation lookup
    // This prevents a malicious actor from potentially overwriting local user data
    if (domain.toLowerCase() === config.INSTANCE_DOMAIN.toLowerCase()) {
      logger.warn(`❌ Refusing federation lookup for local domain: ${username}@${domain}`);
      
      // Return the local user if they exist, but mark as local
      const { data: localUser } = await supabase
        .from('profiles')
        .select('*')
        .eq('username', username)
        .eq('domain', domain)
        .eq('is_local', true)
        .single();
      
      if (localUser) {
        return res.json({
          success: true,
          user: localUser,
          cached: true,
          is_local: true,
          message: 'This is a local user, not a federated user'
        });
      }
      
      return res.status(400).json({ 
        error: 'Cannot lookup local users via federation. This is a local instance domain.',
        is_local_domain: true
      });
    }

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
        
        // Check if federation_metadata is missing or incomplete - if so, force a refresh
        let needsMetadataRefresh = false;
        try {
          const metadata = existingUser.federation_metadata 
            ? (typeof existingUser.federation_metadata === 'string' 
                ? JSON.parse(existingUser.federation_metadata) 
                : existingUser.federation_metadata)
            : {};
          const hasBioEmojis = Array.isArray(metadata.bio_emojis) && metadata.bio_emojis.length > 0;
          const hasDisplayNameEmojis = Array.isArray(metadata.display_name_emojis) && metadata.display_name_emojis.length > 0;
          needsMetadataRefresh = !hasBioEmojis && !hasDisplayNameEmojis;
        } catch {
          needsMetadataRefresh = true;
        }
        
        // Refresh if metadata is missing AND display name or bio contain shortcode patterns
        const hasEmojiPatterns = 
          (existingUser.bio && existingUser.bio.includes(':')) ||
          (existingUser.display_name && existingUser.display_name.includes(':'));
        if (needsMetadataRefresh && hasEmojiPatterns) {
          logger.info(`🔄 User ${username}@${domain} has emoji patterns but no emoji metadata - forcing refresh`);
          // Don't return cached - fall through to full fetch
        } else {
          // Check if we should trigger a background post fetch
          // Fetch if: user has outbox_url AND (no posts yet OR last sync was over 5 minutes ago)
          const shouldFetchPosts = existingUser.outbox_url && (
            !existingUser.last_federation_sync || 
            (Date.now() - new Date(existingUser.last_federation_sync).getTime()) > 5 * 60 * 1000
          );
          
          if (shouldFetchPosts) {
            logger.info(`📬 Triggering background post fetch for cached user ${username}@${domain}`);
            fetchRecentPostsInBackground(existingUser.id, existingUser.outbox_url, supabase).catch(err => {
              logger.warn(`Background post fetch failed for ${username}@${domain}:`, err.message);
            });
          }
          
          return res.json({
            success: true,
            user: existingUser,
            outbox_url: existingUser.outbox_url, // Always include for pagination
            cached: true
          });
        }
      }
    }

    try {
      // SSRF protection: validate the domain before fetching
      validateExternalHostname(domain);

      // Step 1: WebFinger lookup
      const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${encodeURIComponent(username)}@${encodeURIComponent(domain)}`;
      logger.info(`🌐 WebFinger lookup: ${webfingerUrl}`);
      
      const webfingerResponse = await safeFetch(webfingerUrl, {
        headers: { 
          'Accept': 'application/jrd+json, application/json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        timeoutMs: 10000, // 10 second timeout
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
      // BUGS.md H15: selfLink.href comes from the remote webfinger response.
      // safeFetch re-validates the URL/DNS and follows redirects manually.
      const actorResponse = await safeFetch(selfLink.href, {
        headers: { 
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        timeoutMs: 10000,
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
          const response = await safeFetch(url, {
            headers: { 
              'Accept': 'application/activity+json, application/ld+json',
              'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
            },
            timeoutMs: 5000,
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
      // Debug: log actor emoji data
      logger.debug(`📋 Actor has tag array: ${Array.isArray(actor.tag)}, length: ${actor.tag?.length || 0}`);
      logger.debug(`📋 Actor has emojis object: ${!!actor.emojis}, keys: ${actor.emojis ? Object.keys(actor.emojis).length : 0}`);
      if (actor.tag) {
        const emojiTags = actor.tag.filter((t: any) => t.type === 'Emoji');
        logger.debug(`📋 Emoji tags in actor: ${emojiTags.length}`);
        if (emojiTags.length > 0) {
          logger.debug(`📋 Sample emoji tag: ${JSON.stringify(emojiTags[0])}`);
        }
      }
      if (actor.emojis && Object.keys(actor.emojis).length > 0) {
        const firstKey = Object.keys(actor.emojis)[0];
        logger.debug(`📋 Sample emoji from object: ${firstKey} = ${actor.emojis[firstKey]}`);
      }
      
      const profileData = actorToProfile(actor);
      logger.debug(`📋 Profile bio_emojis count: ${profileData.bio_emojis?.length || 0}`);
      
      // SECURITY: Double-check the domain from the actor data
      // This protects against a remote server claiming to represent our domain
      if (profileData.domain.toLowerCase() === config.INSTANCE_DOMAIN.toLowerCase()) {
        logger.warn(`🚨 SECURITY: Remote actor claims local domain! Actor: ${actor.id}, Domain: ${profileData.domain}`);
        return res.status(400).json({ 
          error: 'Remote actor cannot claim local instance domain',
          security_violation: true
        });
      }
      
      // SECURITY: Check if there's an existing LOCAL user with this username/domain
      // This should not happen given the earlier domain check, but belt-and-suspenders
      const { data: existingLocalUser } = await supabase
        .from('profiles')
        .select('id, is_local')
        .eq('username', profileData.username)
        .eq('domain', profileData.domain)
        .eq('is_local', true)
        .maybeSingle();
      
      if (existingLocalUser) {
        logger.warn(`🚨 SECURITY: Refusing to overwrite local user ${profileData.username}@${profileData.domain}`);
        return res.status(400).json({ 
          error: 'Cannot overwrite local user with federated data',
          security_violation: true
        });
      }
      
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
      
      // Persist ActivityPub profile fields (PropertyValue attachments)
      if (profileData.profile_fields) {
        profileRecord.profile_fields = profileData.profile_fields;
      }

      // Store bio and display name emojis in federation_metadata for rendering
      const federationMetadata: any = {};
      if (profileData.bio_emojis && profileData.bio_emojis.length > 0) {
        federationMetadata.bio_emojis = profileData.bio_emojis;
      }
      if (profileData.display_name_emojis && profileData.display_name_emojis.length > 0) {
        federationMetadata.display_name_emojis = profileData.display_name_emojis;
      }
      if (Object.keys(federationMetadata).length > 0) {
        profileRecord.federation_metadata = JSON.stringify(federationMetadata);
      }

      // Add counts if columns exist (may need migration)
      if (followersCount > 0) profileRecord.followers_count = followersCount;
      if (followingCount > 0) profileRecord.following_count = followingCount;
      if (postsCount > 0) profileRecord.posts_count = postsCount;

      let savedUser;
      const { data: upsertedUser, error: saveError } = await supabase
        .from('profiles')
        .upsert(profileRecord, {
          onConflict: 'username,domain',
        })
        .select()
        .single();

      if (saveError) {
        // Handle race condition: if another request created this user, fetch it
        if (saveError.message.includes('duplicate key') || saveError.code === '23505') {
          logger.info(`🔄 Race condition detected, fetching existing user: ${username}@${domain}`);
          const { data: existingUser } = await supabase
            .from('profiles')
            .select('*')
            .eq('username', username)
            .eq('domain', domain)
            .single();
          
          if (existingUser) {
            savedUser = existingUser;
          } else {
            logger.error(`❌ Failed to save remote user and couldn't find existing: ${saveError.message}`);
            return res.status(500).json({ 
              error: 'Failed to store user profile',
              details: saveError.message
            });
          }
        } else {
          logger.error(`❌ Failed to save remote user: ${saveError.message}`);
          return res.status(500).json({ 
            error: 'Failed to store user profile',
            details: saveError.message
          });
        }
      } else {
        savedUser = upsertedUser;
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
 * Resolve a remote post by URL - imports it (and its author) via ActivityPub if not already local.
 * POST /resolve-post (proxied via /api/federation/resolve-post)
 * Body: { url: string }
 */
router.post(
  '/resolve-post',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    const supabase = getSupabaseClient();

    // Build a set of URL variants to check - fediverse platforms use different
    // URL formats for the same post (e.g. GoToSocial: /users/x/statuses/ID vs /@x/statuses/ID)
    const urlVariants = new Set<string>([url]);
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      // GoToSocial: /users/username/statuses/ID ↔ /@username/statuses/ID
      const gtsUsers = path.match(/^\/users\/([^/]+)\/statuses\/(.+)$/);
      if (gtsUsers) {
        urlVariants.add(`${parsed.origin}/@${gtsUsers[1]}/statuses/${gtsUsers[2]}`);
      }
      const gtsAt = path.match(/^\/@([^/]+)\/statuses\/(.+)$/);
      if (gtsAt) {
        urlVariants.add(`${parsed.origin}/users/${gtsAt[1]}/statuses/${gtsAt[2]}`);
      }
      // Mastodon: /users/username/statuses/ID ↔ /@username/ID
      const mastoUsers = path.match(/^\/users\/([^/]+)\/statuses\/(.+)$/);
      if (mastoUsers) {
        urlVariants.add(`${parsed.origin}/@${mastoUsers[1]}/${mastoUsers[2]}`);
      }
      const mastoAt = path.match(/^\/@([^/]+)\/(\d+)$/);
      if (mastoAt) {
        urlVariants.add(`${parsed.origin}/users/${mastoAt[1]}/statuses/${mastoAt[2]}`);
      }
    } catch { /* invalid URL, just use the original */ }

    const orFilter = [...urlVariants]
      .flatMap(u => [`ap_id.eq.${u}`, `url.eq.${u}`])
      .join(',');

    const { data: existing } = await supabase
      .from('posts')
      .select('id, author_id')
      .or(orFilter)
      .eq('is_deleted', false)
      .limit(1)
      .maybeSingle();

    if (existing) {
      return res.json({ success: true, post_id: existing.id });
    }

    logger.info(`🔍 Resolving remote post: ${url}`);
    const result = await ActivityProcessor.fetchAndCreateRemotePost(url);

    if (!result) {
      return res.status(404).json({ error: 'Could not resolve remote post' });
    }

    logger.info(`✅ Resolved remote post ${url} → ${result.id}`);
    return res.json({ success: true, post_id: result.id });
  })
);

/**
 * Fetch more posts from a remote user (pagination)
 * POST /fetch-posts (proxied via /api/federation/fetch-posts)
 * Body: { user_id: uuid, outbox_url: string, max_id?: string, limit?: number }
 */
router.post(
  '/fetch-posts',
  discoveryLimiter,
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
 * Batch fetch reactions for multiple remote posts in one request.
 * POST /fetch-reactions-batch
 * Body: { posts: [{ post_ap_id: string, post_id?: string }, ...] }
 */
router.post(
  '/fetch-reactions-batch',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { posts } = req.body;

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ error: 'posts array is required' });
    }

    const MAX_BATCH = 30;
    const batch = posts.slice(0, MAX_BATCH);
    const supabase = getSupabaseClient();
    const results: Record<string, any> = {};

    // Single round-trip metadata lookup for every entry that gave us a
    // post_id. Used for the TTL cache hit-check below AND for the counts
    // we return — avoids the original per-post SELECT roundtrip.
    const idsToLookup = batch
      .map((e: any) => e.post_id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
    const postRowsById = new Map<string, any>();
    if (idsToLookup.length > 0) {
      const { data } = await supabase
        .from('posts')
        .select('id, metadata, favorites_count, replies_count, reblogs_count')
        .in('id', idsToLookup);
      for (const row of data || []) {
        postRowsById.set(row.id, row);
      }
    }

    await Promise.allSettled(
      batch.map(async (entry: { post_ap_id: string; post_id?: string }) => {
        if (!entry.post_ap_id) return;

        try {
          const apDomain = new URL(entry.post_ap_id).hostname;
          if (apDomain === config.INSTANCE_DOMAIN) {
            results[entry.post_ap_id] = { success: true, reactions: [], count: 0 };
            return;
          }
        } catch { /* invalid URL, proceed */ }

        const cachedRow = entry.post_id ? postRowsById.get(entry.post_id) : null;

        // TTL cache hit — skip all outbound HTTP. The aggregated
        // `remote_reactions` is already on the row we just SELECTed.
        if (cachedRow && isReactionsCacheFresh(cachedRow.metadata)) {
          results[entry.post_ap_id] = {
            success: true,
            reactions: [],
            count: 0,
            remote_reactions: cachedRow.metadata?.remote_reactions || null,
            favorites_count: cachedRow.favorites_count || 0,
            replies_count: cachedRow.replies_count || 0,
            reblogs_count: cachedRow.reblogs_count || 0,
            cached: true,
          };
          return;
        }

        try {
          const reactions = await fetchRemotePostReactions(entry.post_ap_id, entry.post_id, supabase);

          let remote_reactions: Record<string, any> | null = null;
          let updatedPost: any = null;

          if (entry.post_id) {
            // Re-read AFTER the fetch — metadata may have been updated by
            // `fetchRemotePostReactions` itself (Misskey path writes
            // remote_reactions in-line; standard AP path writes only the
            // raw `reactions` and lets us aggregate below).
            const { data } = await supabase
              .from('posts')
              .select('metadata, favorites_count, replies_count, reblogs_count')
              .eq('id', entry.post_id)
              .single();
            updatedPost = data ?? null;
            remote_reactions = updatedPost?.metadata?.remote_reactions || null;
          }

          if (!remote_reactions && reactions.length > 0) {
            const byEmoji = new Map<string, { count: number; url?: string; reactors: any[] }>();
            for (const r of reactions as Array<{ emoji: string; emoji_url?: string; actor?: any }>) {
              const key = r.emoji;
              if (!byEmoji.has(key)) byEmoji.set(key, { count: 0, url: r.emoji_url, reactors: [] });
              const e = byEmoji.get(key)!;
              e.count++;
              if (e.reactors.length < 10 && r.actor) {
                e.reactors.push({
                  username: r.actor.username,
                  display_name: r.actor.display_name || r.actor.username,
                  avatar_url: r.actor.avatar_url,
                  domain: r.actor.domain,
                });
              }
            }
            remote_reactions = Object.fromEntries(byEmoji);
            if (entry.post_id) {
              await supabase
                .from('posts')
                .update({
                  metadata: {
                    ...(updatedPost?.metadata || {}),
                    remote_reactions,
                    remote_reactions_fetched_at: new Date().toISOString(),
                  },
                })
                .eq('id', entry.post_id);
            }
          } else if (!remote_reactions && reactions.length === 0 && entry.post_id) {
            // Successful fetch but zero reactions - still mark the TTL
            // cache so we don't re-hit the origin for an empty post on
            // every refresh.
            await markRemoteReactionsAttempted(entry.post_id, supabase);
          }

          results[entry.post_ap_id] = {
            success: true,
            reactions,
            count: reactions.length,
            remote_reactions,
            favorites_count: updatedPost?.favorites_count || 0,
            replies_count: updatedPost?.replies_count || 0,
            reblogs_count: updatedPost?.reblogs_count || 0,
          };
        } catch (error: any) {
          logger.error(`Batch fetch-reactions failed for ${entry.post_ap_id}:`, error.message);
          // TTL-cache the failure so a broken remote (HTML 404 disguised
          // as 200, malformed JSON, etc.) doesn't get re-tried on every
          // refresh.
          await markRemoteReactionsAttempted(entry.post_id, supabase);
          results[entry.post_ap_id] = { success: false, error: error.message };
        }
      })
    );

    return res.json({ results });
  })
);

/**
 * Fetch reactions/likes for a remote post
 * POST /fetch-reactions (proxied via /api/federation/fetch-reactions)
 * Body: { post_ap_id: string, post_id?: string }
 */
router.post(
  '/fetch-reactions',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    // Debug: log raw request body
    logger.debug(`📬 fetch-reactions raw body: ${JSON.stringify(req.body)}`);
    
    const { post_ap_id, post_id } = req.body;

    if (!post_ap_id) {
      logger.warn(`📬 fetch-reactions missing post_ap_id, body was: ${JSON.stringify(req.body)}`);
      return res.status(400).json({ error: 'post_ap_id is required' });
    }

    const supabase = getSupabaseClient();

    // Skip federation fetch for local posts - data is already in the database
    try {
      const apDomain = new URL(post_ap_id).hostname;
      if (apDomain === config.INSTANCE_DOMAIN) {
        logger.debug(`📬 Skipping fetch-reactions for local post: ${post_ap_id}`);
        return res.json({ success: true, reactions: [], count: 0 });
      }
    } catch { /* invalid URL, proceed */ }

    try {
      // TTL cache: skip the outbound HTTP if the row was refreshed within
      // REACTIONS_TTL_MS. Read first; if cached, return without touching
      // the network (the aggregated `remote_reactions` is right here).
      if (post_id) {
        const { data: cached } = await supabase
          .from('posts')
          .select('metadata, favorites_count, replies_count, reblogs_count')
          .eq('id', post_id)
          .maybeSingle();
        if (cached && isReactionsCacheFresh(cached.metadata)) {
          logger.debug(`📬 fetch-reactions cache HIT for ${post_ap_id}`);
          return res.json({
            success: true,
            reactions: [],
            count: 0,
            remote_reactions: cached.metadata?.remote_reactions || null,
            favorites_count: cached.favorites_count || 0,
            replies_count: cached.replies_count || 0,
            reblogs_count: cached.reblogs_count || 0,
            cached: true,
          });
        }
      }

      logger.info(`📬 Fetching reactions for remote post: ${post_ap_id}`);

      const reactions = await fetchRemotePostReactions(post_ap_id, post_id, supabase);

      // Fetch the updated post with metadata and counts to return to the frontend
      let remote_reactions: Record<string, { count: number; url?: string; reactors?: any[] }> | null = null;
      let favorites_count = 0;
      let replies_count = 0;
      let reblogs_count = 0;
      let updatedPost: { metadata?: any; favorites_count?: number; replies_count?: number; reblogs_count?: number } | null = null;

      if (post_id) {
        const { data } = await supabase
          .from('posts')
          .select('metadata, favorites_count, replies_count, reblogs_count')
          .eq('id', post_id)
          .single();
        updatedPost = data ?? null;

        remote_reactions = updatedPost?.metadata?.remote_reactions || null;
        favorites_count = updatedPost?.favorites_count || 0;
        replies_count = updatedPost?.replies_count || 0;
        reblogs_count = updatedPost?.reblogs_count || 0;
      }

      // For non-Misskey instances (Mastodon, Pleroma, GoToSocial), fetchRemotePostReactions
      // returns raw reactions but never builds remote_reactions. Aggregate them here.
      if (!remote_reactions && reactions.length > 0) {
        const byEmoji = new Map<string, { count: number; url?: string; reactors: any[] }>();
        for (const r of reactions as Array<{ emoji: string; emoji_url?: string; actor?: any }>) {
          const key = r.emoji;
          if (!byEmoji.has(key)) {
            byEmoji.set(key, { count: 0, url: r.emoji_url, reactors: [] });
          }
          const entry = byEmoji.get(key)!;
          entry.count++;
          if (entry.reactors.length < 10 && r.actor) {
            entry.reactors.push({
              username: r.actor.username,
              display_name: r.actor.display_name || r.actor.username,
              avatar_url: r.actor.avatar_url,
              domain: r.actor.domain,
            });
          }
        }
        remote_reactions = Object.fromEntries(byEmoji);
        if (post_id) {
          await supabase
            .from('posts')
            .update({
              metadata: {
                ...(updatedPost?.metadata || {}),
                remote_reactions,
                remote_reactions_fetched_at: new Date().toISOString(),
              },
            })
            .eq('id', post_id);
        }
      } else if (!remote_reactions && reactions.length === 0 && post_id) {
        // Successful fetch returning zero reactions - TTL-cache the
        // attempt to avoid re-hitting the origin on every refresh.
        await markRemoteReactionsAttempted(post_id, supabase);
      }

      return res.json({
        success: true,
        reactions,
        count: reactions.length,
        remote_reactions,
        favorites_count,
        replies_count,
        reblogs_count,
      });
    } catch (error: any) {
      logger.error('Failed to fetch reactions:', error);
      // Same rationale as the batch handler: TTL-cache the failure to
      // stop a broken remote from being re-hit on every refresh.
      await markRemoteReactionsAttempted(post_id, supabase);
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
    const response = await safeFetch(apiUrl, {
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
    const originInstanceEmojis: Record<string, string> = {};  // Emojis native to the origin instance
    
    try {
      const noteResponse = await safeFetch(`https://${domain}/api/notes/show`, {
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
        const emojiResponse = await safeFetch(`https://${domain}/api/emojis`, {
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
      
      // Extract display name emojis from user if available (Misskey includes this)
      let displayNameEmojis: Array<{name: string, url: string}> = [];
      if (user?.emojis && typeof user.emojis === 'object') {
        displayNameEmojis = Object.entries(user.emojis).map(([name, url]) => ({
          name,
          url: url as string,
        }));
        if (displayNameEmojis.length > 0) {
          logger.debug(`📬 Found ${displayNameEmojis.length} display name emojis for ${user?.username}`);
        }
      }
      
      // Debug: log user host value
      if (user?.host !== null && user?.host !== undefined) {
        logger.debug(`📬 Reactor ${user?.username} has host: "${user.host}"`);
      }
      
      // Determine the reactor's domain - user.host is null for local users in Misskey
      const reactorDomain = (user?.host && user.host !== '.') ? user.host : domain;
      
      // Build reaction object with actor info (for display purposes only, no DB storage)
      reactions.push({
        emoji,
        emoji_url: emojiUrl,
        content: emoji,
        actor: {
          username: user?.username || 'unknown',
          display_name: user?.name || user?.username,
          display_name_emojis: displayNameEmojis.length > 0 ? displayNameEmojis : undefined,
          avatar_url: user?.avatarUrl,
          domain: reactorDomain,
          is_local: false,
        },
        actor_url: user?.id ? `https://${reactorDomain}/users/${user.id}` : null,
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
        display_name_emojis?: Array<{name: string, url: string}>;
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
            display_name_emojis: reaction.actor.display_name_emojis,
            avatar_url: reaction.actor.avatar_url,
            domain: reaction.actor.domain,
          });
        }
      }
      
      // Build reaction summary with emoji URLs and reactor info
      const reactionSummary: Record<string, { 
        count: number; 
        url?: string;
        reactors: Array<{ 
          username: string; 
          display_name: string; 
          display_name_emojis?: Array<{name: string, url: string}>;
          avatar_url: string; 
          domain: string;
        }>;
      }> = {};
      
      for (const [emoji, data] of reactionCounts) {
        // Normalize emoji key for frontend display
        // Misskey format: :emoji_name@.: or :emoji_name@domain:
        // We want: :emoji_name: (clean format)
        let normalizedEmoji = emoji;
        if (emoji.startsWith(':') && emoji.endsWith(':')) {
          // Remove @. and @domain suffixes from within the colons
          normalizedEmoji = emoji.replace(/@[^:]*:$/, ':');
        }
        
        reactionSummary[normalizedEmoji] = { 
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
 * Fetch reactions from a remote post's likes collection.
 *
 * Concurrent calls for the same `postApId` are coalesced via
 * `inFlightReactionFetches` so a profile viewed by 5 users in the same
 * second produces ONE outbound burst, not five. The TTL cache itself
 * lives in the route handlers (they already SELECT the post row, so
 * checking the cache adds zero DB round-trips there).
 */
async function fetchRemotePostReactions(
  postApId: string,
  postId: string | undefined,
  supabase: any
): Promise<any[]> {
  // Skip local posts up-front so dedup map never traps a same-host key.
  try {
    if (new URL(postApId).hostname === config.INSTANCE_DOMAIN) return [];
  } catch { /* invalid URL — fall through, _impl handles the failure */ }

  const existing = inFlightReactionFetches.get(postApId);
  if (existing) {
    logger.debug(`📬 In-flight dedup HIT for ${postApId}`);
    return existing;
  }

  const promise = _fetchRemotePostReactionsImpl(postApId, postId, supabase);
  inFlightReactionFetches.set(postApId, promise);
  try {
    return await promise;
  } finally {
    inFlightReactionFetches.delete(postApId);
  }
}

async function _fetchRemotePostReactionsImpl(
  postApId: string,
  postId: string | undefined,
  supabase: any
): Promise<any[]> {
  try {
    // Skip local posts - reactions are already in our DB
    try {
      const apDomain = new URL(postApId).hostname;
      if (apDomain === config.INSTANCE_DOMAIN) {
        return [];
      }
    } catch { /* invalid URL, proceed */ }

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

    // Standard ActivityPub approach.
    //
    // Mastodon, Pleroma, Akkoma, GoToSocial, Friendica, Pixelfed and Harmony
    // all serialize a Note's likes collection at `${ap_id}/likes`. We try that
    // URL first to skip the post-object roundtrip. Only if it 404s (or some
    // other non-OK response) do we fall back to the legacy "fetch the post,
    // read its `likes` property" path, which protects compatibility with
    // non-conventional AP implementations.
    //
    // BUGS.md H15: postApId is attacker-influenced (from inbox / remote feed),
    // so every outbound call is wrapped by safeFetch which enforces SSRF
    // protection.
    const apHeaders = {
      'Accept': 'application/activity+json, application/ld+json',
      'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`,
    } as const;

    let likesCollection: any = null;
    let likesCollectionUrl = `${postApId}/likes`;

    const shortcutResponse = await safeFetch(likesCollectionUrl, {
      headers: apHeaders,
      timeoutMs: 10000,
    });

    if (shortcutResponse.ok) {
      likesCollection = await shortcutResponse.json();
    } else {
      logger.debug(
        `📬 /likes shortcut returned ${shortcutResponse.status} for ${postApId}; discovering URL via post object`
      );

      const postResponse = await safeFetch(postApId, {
        headers: apHeaders,
        timeoutMs: 10000,
      });

      if (!postResponse.ok) {
        logger.warn(`Failed to fetch post: ${postResponse.status}`);
        // 404 / 410 / unauthorized on a remote post is sticky for the TTL
        // window — mark it attempted so the next feed refresh doesn't
        // re-hit the origin for a known-dead post.
        await markRemoteReactionsAttempted(postId, supabase);
        return [];
      }

      const post = await postResponse.json();

      // Self-healing counts on the fallback path: when we already paid for
      // the post object, salvage favourites/replies/shares counts from it.
      // Hot-path callers (shortcut succeeded) rely on counts staying current
      // via inbound /inbox events instead.
      const counts = {
        likes: post.likes?.totalItems || post.favouritesCount || post._misskey_likes || 0,
        replies: post.replies?.totalItems || post.repliesCount || 0,
        shares: post.shares?.totalItems || post.sharesCount || 0,
      };
      if (postId && (counts.likes > 0 || counts.replies > 0 || counts.shares > 0)) {
        await supabase
          .from('posts')
          .update({
            favorites_count: counts.likes,
            replies_count: counts.replies,
            reblogs_count: counts.shares,
          })
          .eq('id', postId);
      }

      const likesUrl = post.likes || post.reactions || post._misskey_likes;
      if (!likesUrl) {
        logger.info(
          `📬 No likes collection found for post (available: ${Object.keys(post).filter(k => k.includes('like') || k.includes('reaction')).join(', ') || 'none'})`
        );
        await markRemoteReactionsAttempted(postId, supabase);
        return [];
      }
      likesCollectionUrl = typeof likesUrl === 'string' ? likesUrl : likesUrl.id;

      try {
        if (new URL(likesCollectionUrl).hostname === config.INSTANCE_DOMAIN) {
          logger.info(`📬 Skipping self-fetch for likes: ${likesCollectionUrl}`);
          await markRemoteReactionsAttempted(postId, supabase);
          return [];
        }
      } catch { /* invalid URL, proceed */ }

      const likesResponse = await safeFetch(likesCollectionUrl, {
        headers: apHeaders,
        timeoutMs: 10000,
      });
      if (!likesResponse.ok) {
        logger.warn(`Failed to fetch likes collection: ${likesResponse.status}`);
        await markRemoteReactionsAttempted(postId, supabase);
        return [];
      }
      likesCollection = await likesResponse.json();
    }

    // Self-healing of favorites_count from the likes collection itself —
    // works on both the shortcut and fallback paths and is a single column
    // write, much cheaper than the full counts update above.
    if (postId && typeof likesCollection?.totalItems === 'number') {
      await supabase
        .from('posts')
        .update({ favorites_count: likesCollection.totalItems })
        .eq('id', postId);
    }
    
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
      
      const pageResponse = await safeFetch(firstPageUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        timeoutMs: 10000,
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
          // Check for tag-based emoji (Mastodon/Pleroma: custom emoji with icon URL)
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

        // Extract custom emoji URL (Mastodon/Pleroma: tag.icon.url)
        let emojiUrl: string | null = null;
        if (item.tag && Array.isArray(item.tag)) {
          const emojiTag = item.tag.find((t: any) => t.type === 'Emoji');
          if (emojiTag?.icon) {
            // eslint-disable-next-line unused-imports/no-unused-vars
            emojiUrl = typeof emojiTag.icon === 'string' ? emojiTag.icon : emojiTag.icon?.url;
          }
        }

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
 * POST /fetch-replies (proxied via /api/federation/fetch-replies)
 * Body: { post_ap_id: string, post_id?: string, limit?: number }
 */
router.post(
  '/fetch-replies',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { post_ap_id, post_id, limit = 10 } = req.body;

    if (!post_ap_id) {
      return res.status(400).json({ error: 'post_ap_id is required' });
    }

    const supabase = getSupabaseClient();

    // Skip federation fetch for local posts - replies are already in the database
    try {
      const apDomain = new URL(post_ap_id).hostname;
      if (apDomain === config.INSTANCE_DOMAIN) {
        logger.debug(`📬 Skipping fetch-replies for local post: ${post_ap_id}`);
        return res.json({ success: true, replies: [], count: 0 });
      }
    } catch { /* invalid URL, proceed */ }

    logger.info(`📬 Fetching replies for remote post: ${post_ap_id}`);

    try {
      const replies = await fetchRemotePostReplies(post_ap_id, post_id, supabase, Math.min(limit, 20));

      let updatedCounts: any = {};
      if (post_id) {
        const { data: freshPost } = await supabase
          .from('posts')
          .select('replies_count, favorites_count, reblogs_count')
          .eq('id', post_id)
          .single();
        if (freshPost) updatedCounts = freshPost;
      }

      return res.json({
        success: true,
        replies,
        count: replies.length,
        ...updatedCounts,
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
    const response = await safeFetch(apiUrl, {
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

      // Convert Misskey note to ActivityPub-like format for noteToContent
      const apLikeNote: any = {
        // Misskey uses 'text' but AP uses 'content' - wrap in paragraph tags
        content: note.text ? `<p>${note.text.replace(/\n/g, '<br>')}</p>` : '',
        // Convert Misskey emojis to ActivityPub tag format
        tag: [],
        // Convert Misskey files to ActivityPub attachment format
        attachment: [],
      };
      
      // Convert custom emojis
      if (note.emojis && typeof note.emojis === 'object') {
        for (const [name, url] of Object.entries(note.emojis)) {
          apLikeNote.tag.push({
            type: 'Emoji',
            name: `:${name}:`,
            icon: { url: url as string },
          });
        }
      }
      
      // Also check reactionEmojis for emoji URLs
      if (note.reactionEmojis && typeof note.reactionEmojis === 'object') {
        for (const [name, url] of Object.entries(note.reactionEmojis)) {
          if (!apLikeNote.tag.some((t: any) => t.name === `:${name}:`)) {
            apLikeNote.tag.push({
              type: 'Emoji',
              name: `:${name}:`,
              icon: { url: url as string },
            });
          }
        }
      }
      
      // Convert mentions
      if (note.mentions && Array.isArray(note.mentions)) {
        for (const mentionId of note.mentions) {
          apLikeNote.tag.push({
            type: 'Mention',
            href: mentionId,
          });
        }
      }
      
      // Convert files/attachments
      if (note.files && Array.isArray(note.files)) {
        for (const file of note.files) {
          apLikeNote.attachment.push({
            type: 'Document',
            mediaType: file.type,
            url: file.url,
            name: file.name || file.comment,
            width: file.properties?.width,
            height: file.properties?.height,
            blurhash: file.blurhash,
          });
        }
      }
      
      // Use the proper content converter
      const { noteToContent } = await import('./converters/fromActivityPub.js');
      const content = noteToContent(apLikeNote);

      // Build custom emojis array for metadata
      const customEmojis: any[] = [];
      if (note.emojis && typeof note.emojis === 'object') {
        for (const [name, url] of Object.entries(note.emojis)) {
          customEmojis.push({ name, url });
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
          content_warning: note.cw || null, // Misskey uses 'cw' for content warning
          is_sensitive: note.sensitive === true,
          metadata: {
            in_reply_to_ap_url: `https://${domain}/notes/${noteId}`,
            custom_emojis: customEmojis,
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
    // Fetch the post object to get the replies collection URL.
    // BUGS.md H15: postApId attacker-influenced.
    const postResponse = await safeFetch(postApId, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      timeoutMs: 10000,
    });

    if (!postResponse.ok) {
      logger.warn(`Failed to fetch post: ${postResponse.status}`);
      return [];
    }

    const post = await postResponse.json();

    // Update parent post counts from the freshly fetched remote object
    if (postId) {
      const remoteCounts: any = {};
      const remoteReplies = post.replies?.totalItems || post.repliesCount || 0;
      const remoteLikes = post.likes?.totalItems || post.favouritesCount || 0;
      const remoteShares = post.shares?.totalItems || post.sharesCount || 0;
      if (remoteReplies > 0) remoteCounts.replies_count = remoteReplies;
      if (remoteLikes > 0) remoteCounts.favorites_count = remoteLikes;
      if (remoteShares > 0) remoteCounts.reblogs_count = remoteShares;
      if (Object.keys(remoteCounts).length > 0) {
        await supabase.from('posts').update(remoteCounts).eq('id', postId);
      }
    }

    // Get replies collection URL
    const repliesUrl = post.replies;
    if (!repliesUrl) {
      logger.info(`📬 No replies collection found for post`);
      return [];
    }

    const repliesCollectionUrl = typeof repliesUrl === 'string' ? repliesUrl : repliesUrl.id;
    logger.info(`📬 Fetching replies from: ${repliesCollectionUrl}`);

    const repliesResponse = await safeFetch(repliesCollectionUrl, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      timeoutMs: 10000,
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
      
      const pageResponse = await safeFetch(firstPageUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        timeoutMs: 10000,
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
          const noteResponse = await safeFetch(item, {
            headers: {
              'Accept': 'application/activity+json, application/ld+json',
              'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
            },
            timeoutMs: 5000,
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
            const actorResponse = await safeFetch(authorUrl, {
              headers: {
                'Accept': 'application/activity+json, application/ld+json',
                'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
              },
              timeoutMs: 5000,
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
        
        // Determine visibility from AP addressing
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
        
        const replyData: any = {
          ap_id: note.id,
          ap_type: note.type,
          author_id: author.id,
          content,
          visibility,
          is_local: false,
          created_at: note.published || new Date().toISOString(),
          in_reply_to: postId,
          content_warning: note.summary || null,
          is_sensitive: note.sensitive === true,
          metadata: {
            in_reply_to_ap_url: postApId,
            custom_emojis: note.tag?.filter((t: any) => t.type === 'Emoji').map((e: any) => ({
              name: e.name?.replace(/:/g, ''),
              url: e.icon?.url,
            })) || [],
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
 * Generate keys for a local user
 * POST /generate-keys (proxied via /api/federation/generate-keys)
 * Body: { user_id: uuid }
 * 
 * This endpoint generates RSA keys for a local user if they don't have them.
 * Called during profile creation to ensure users are federation-ready.
 */
router.post(
  '/generate-keys',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const supabase = getSupabaseClient();

    // Verify this is a local user
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, domain, is_local, public_key')
      .eq('id', user_id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!profile.is_local) {
      return res.status(400).json({ error: 'Cannot generate keys for remote users' });
    }

    // Check if keys already exist
    if (profile.public_key) {
      const { data: privateKeyExists } = await supabase
        .from('user_private_keys')
        .select('id')
        .eq('user_id', user_id)
        .maybeSingle();

      if (privateKeyExists) {
        logger.info(`🔐 Keys already exist for user ${profile.username}`);
        return res.json({ 
          success: true, 
          message: 'Keys already exist',
          already_exists: true
        });
      }
    }

    // Generate keys
    logger.info(`🔐 Generating keys for user ${profile.username}...`);
    
    try {
      const { SignatureService } = await import('./SignatureService.js');
      const keys = await SignatureService.generateKeyPair();

      // Store private key first
      const { error: privateKeyError } = await supabase
        .from('user_private_keys')
        .upsert({
          user_id: user_id,
          private_key: keys.privateKey,
        });

      if (privateKeyError) {
        logger.error(`Failed to store private key for ${profile.username}:`, privateKeyError);
        return res.status(500).json({ error: 'Failed to store private key' });
      }

      // Update profile with public key
      const { error: publicKeyError } = await supabase
        .from('profiles')
        .update({ public_key: keys.publicKey })
        .eq('id', user_id);

      if (publicKeyError) {
        // Clean up orphaned private key
        await supabase
          .from('user_private_keys')
          .delete()
          .eq('user_id', user_id);
        
        logger.error(`Failed to store public key for ${profile.username}:`, publicKeyError);
        return res.status(500).json({ error: 'Failed to store public key' });
      }

      logger.info(`✅ Generated keys for user ${profile.username}`);
      
      return res.json({
        success: true,
        message: 'Keys generated successfully',
        already_exists: false
      });
    } catch (genError) {
      logger.error(`Failed to generate keys for ${profile.username}:`, genError);
      return res.status(500).json({ error: 'Failed to generate keys' });
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

    // Ensure federated_id is set for local users (required for incoming activity lookups)
    const expectedFederatedId = `https://${config.INSTANCE_DOMAIN}/users/${profile.username}`;
    if (!profile.federated_id || profile.federated_id !== expectedFederatedId) {
      await supabase
        .from('profiles')
        .update({
          federated_id: expectedFederatedId,
          inbox_url: `${expectedFederatedId}/inbox`,
          outbox_url: `${expectedFederatedId}/outbox`,
          followers_url: `${expectedFederatedId}/followers`,
          following_url: `${expectedFederatedId}/following`,
          shared_inbox_url: `https://${config.INSTANCE_DOMAIN}/inbox`,
        })
        .eq('id', profile.id);
      profile.federated_id = expectedFederatedId;
    }

    // SAFETY NET: Generate keys on-the-fly if missing
    // This ensures users are always federation-ready when their Actor is requested
    if (!profile.public_key) {
      logger.info(`🔐 Actor ${username} missing keys, generating on-the-fly...`);
      
      try {
        const { SignatureService } = await import('./SignatureService.js');
        const keys = await SignatureService.generateKeyPair();

        // Store private key first
        const { error: privateKeyError } = await supabase
          .from('user_private_keys')
          .upsert({
            user_id: profile.id,
            private_key: keys.privateKey,
          });

        if (!privateKeyError) {
          // Update profile with public key
          const { error: publicKeyError } = await supabase
            .from('profiles')
            .update({ public_key: keys.publicKey })
            .eq('id', profile.id);

          if (!publicKeyError) {
            profile.public_key = keys.publicKey;
            logger.info(`✅ Generated keys on-the-fly for ${username}`);
          } else {
            // Clean up orphaned private key
            await supabase
              .from('user_private_keys')
              .delete()
              .eq('user_id', profile.id);
            logger.error(`Failed to store public key for ${username}:`, publicKeyError);
          }
        } else {
          logger.error(`Failed to store private key for ${username}:`, privateKeyError);
        }
      } catch (genError) {
        logger.error(`Failed to generate keys for ${username}:`, genError);
        // Continue anyway - the Actor response will just have no public key
      }
    }

    // Resolve emoji shortcodes for local users so remote instances can render them
    await resolveLocalProfileEmojis(profile, supabase);

    // Convert to ActivityPub Actor
    const actor = profileToActor(profile);

    res.setHeader('Content-Type', 'application/activity+json');
    // Allow remote servers to cache actor for 5 minutes, reducing redundant fetches
    res.setHeader('Cache-Control', 'public, max-age=300');
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
    // Allow remote servers to cache featured posts for 5 minutes
    res.setHeader('Cache-Control', 'public, max-age=300');
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
 * Followers collection endpoint with cursor-based pagination
 * GET /users/:username/followers
 * Query params:
 *   - cursor: ID of last item (for cursor-based pagination)
 *   - page: Page number (legacy, for backwards compatibility)
 *   - limit: Items per page (default 20, max 100)
 */
router.get(
  '/users/:username/followers',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const page = req.query.page as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
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

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const collectionUrl = `${baseUrl}/users/${username}/followers`;

    // If no page/cursor, return collection metadata
    if (!page && !cursor) {
      const { count } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('following_id', user.id)
        .eq('status', 'accepted');

      res.setHeader('Content-Type', 'application/activity+json');
      // Allow remote servers to cache followers collection for 5 minutes
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${collectionUrl}?cursor=start&limit=${limit}`,
      });
    }

    // Fetch paginated followers
    let query = supabase
      .from('follows')
      .select(`
        id,
        created_at,
        follower:profiles!follows_follower_id_fkey (
          id,
          username,
          domain,
          federated_id
        )
      `)
      .eq('following_id', user.id)
      .eq('status', 'accepted')
      .order('created_at', { ascending: false })
      .limit(limit + 1); // Fetch one extra to detect if there's more

    // Apply cursor (ID-based for efficient pagination)
    if (cursor && cursor !== 'start') {
      const { data: cursorFollow } = await supabase
        .from('follows')
        .select('created_at')
        .eq('id', cursor)
        .single();
      
      if (cursorFollow) {
        query = query.lt('created_at', cursorFollow.created_at);
      }
    } else if (page) {
      // Legacy page-based pagination
      const offset = (parseInt(page) - 1) * limit;
      query = query.range(offset, offset + limit - 1);
    }

    const { data: follows } = await query;
    const hasMore = (follows?.length || 0) > limit;
    const items = (follows || []).slice(0, limit);
    const lastItem = items[items.length - 1];

    // Build follower actor URLs
    const orderedItems = items.map((f: any) => {
      if (f.follower?.federated_id) return f.follower.federated_id;
      if (f.follower?.domain) return `https://${f.follower.domain}/users/${f.follower.username}`;
      return `${baseUrl}/users/${f.follower?.username}`;
    }).filter(Boolean);

    const response: any = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: cursor ? `${collectionUrl}?cursor=${cursor}&limit=${limit}` : `${collectionUrl}?page=${page || 1}`,
      type: 'OrderedCollectionPage',
      partOf: collectionUrl,
      orderedItems,
    };

    // Add pagination links
    if (hasMore && lastItem?.id) {
      response.next = `${collectionUrl}?cursor=${lastItem.id}&limit=${limit}`;
    }

    res.setHeader('Content-Type', 'application/activity+json');
    // Allow remote servers to cache followers page for 5 minutes
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(response);
  })
);

/**
 * Following collection endpoint with cursor-based pagination
 * GET /users/:username/following
 * Query params:
 *   - cursor: ID of last item (for cursor-based pagination)
 *   - page: Page number (legacy, for backwards compatibility)
 *   - limit: Items per page (default 20, max 100)
 */
router.get(
  '/users/:username/following',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const page = req.query.page as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
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

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const collectionUrl = `${baseUrl}/users/${username}/following`;

    // If no page/cursor, return collection metadata
    if (!page && !cursor) {
      const { count } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('follower_id', user.id)
        .eq('status', 'accepted');

      res.setHeader('Content-Type', 'application/activity+json');
      // Allow remote servers to cache following collection for 5 minutes
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${collectionUrl}?cursor=start&limit=${limit}`,
      });
    }

    // Fetch paginated following
    let query = supabase
      .from('follows')
      .select(`
        id,
        created_at,
        following:profiles!follows_following_id_fkey (
          id,
          username,
          domain,
          federated_id
        )
      `)
      .eq('follower_id', user.id)
      .eq('status', 'accepted')
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    // Apply cursor
    if (cursor && cursor !== 'start') {
      const { data: cursorFollow } = await supabase
        .from('follows')
        .select('created_at')
        .eq('id', cursor)
        .single();
      
      if (cursorFollow) {
        query = query.lt('created_at', cursorFollow.created_at);
      }
    } else if (page) {
      const offset = (parseInt(page) - 1) * limit;
      query = query.range(offset, offset + limit - 1);
    }

    const { data: follows } = await query;
    const hasMore = (follows?.length || 0) > limit;
    const items = (follows || []).slice(0, limit);
    const lastItem = items[items.length - 1];

    // Build following actor URLs
    const orderedItems = items.map((f: any) => {
      if (f.following?.federated_id) return f.following.federated_id;
      if (f.following?.domain) return `https://${f.following.domain}/users/${f.following.username}`;
      return `${baseUrl}/users/${f.following?.username}`;
    }).filter(Boolean);

    const response: any = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: cursor ? `${collectionUrl}?cursor=${cursor}&limit=${limit}` : `${collectionUrl}?page=${page || 1}`,
      type: 'OrderedCollectionPage',
      partOf: collectionUrl,
      orderedItems,
    };

    if (hasMore && lastItem?.id) {
      response.next = `${collectionUrl}?cursor=${lastItem.id}&limit=${limit}`;
    }

    res.setHeader('Content-Type', 'application/activity+json');
    // Allow remote servers to cache following page for 5 minutes
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(response);
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
    const outboxResponse = await safeFetch(fetchUrl, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      timeoutMs: 15000,
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
      
      const pageResponse = await safeFetch(firstPageUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        timeoutMs: 15000,
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
          
          // Try to find the original post with full data for the reblog JSON
          const { data: originalPost } = await supabase
            .from('posts')
            .select('id, content, visibility, author_id, created_at, ap_id, url, is_sensitive, content_warning, favorites_count, replies_count, reblogs_count, media_attachments')
            .eq('ap_id', originalUrl)
            .maybeSingle();

          let reblogJson: any = undefined;
          let reblogAuthorJson: any = null;
          if (originalPost) {
            reblogJson = {
              id: originalPost.id,
              content: originalPost.content,
              created_at: originalPost.created_at,
              visibility: originalPost.visibility,
              ap_id: originalPost.ap_id || originalUrl,
              url: originalPost.url || null,
              is_sensitive: originalPost.is_sensitive || false,
              content_warning: originalPost.content_warning || null,
              favorites_count: originalPost.favorites_count || 0,
              replies_count: originalPost.replies_count || 0,
              reblogs_count: originalPost.reblogs_count || 0,
              media_attachments: originalPost.media_attachments || [],
            };
            const { data: origAuthor } = await supabase
              .from('profiles')
              .select('id, username, display_name, avatar_url, domain, is_local')
              .eq('id', originalPost.author_id)
              .single();
            if (origAuthor) reblogAuthorJson = origAuthor;
          }

          const reblogData: any = {
            ap_id: item.id,
            ap_type: 'Announce',
            author_id: authorId,
            content: [],
            visibility: 'public',
            is_local: false,
            created_at: item.published || new Date().toISOString(),
            reblog: reblogJson || undefined,
            reblog_author: reblogAuthorJson,
            metadata: {
              reblog_of: originalPost?.id || null,
              reblog_of_ap_url: originalUrl,
              original_ap_id: originalUrl,
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
    
    // Update last_federation_sync timestamp for the user
    await supabase
      .from('profiles')
      .update({ last_federation_sync: new Date().toISOString() })
      .eq('id', authorId);
    
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
 * Refetch a remote post from its source, re-process content and link previews.
 * POST /refetch-post
 * Body: { post_id: string }
 * Requires: authenticated admin or moderator
 */
router.post(
  '/refetch-post',
  asyncHandler(async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const supabase = getSupabaseClientWithAuth(authHeader.substring(7));
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin, is_moderator')
      .eq('id', user.id)
      .single();

    if (!profile?.is_admin && !profile?.is_moderator) {
      return res.status(403).json({ error: 'Admin or moderator role required' });
    }

    const { post_id } = req.body;
    if (!post_id || typeof post_id !== 'string') {
      return res.status(400).json({ error: 'post_id is required' });
    }

    const adminSupabase = getSupabaseClient();
    const { data: post, error: postError } = await adminSupabase
      .from('posts')
      .select('id, ap_id, is_local, content, metadata')
      .eq('id', post_id)
      .single();

    if (postError || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (post.is_local) {
      return res.status(400).json({ error: 'Cannot refetch a local post' });
    }

    if (!post.ap_id) {
      return res.status(400).json({ error: 'Post has no ActivityPub ID' });
    }

    try {
      let response = await safeFetch(post.ap_id, {
        headers: { 'Accept': 'application/activity+json, application/ld+json' },
      });

      if (response.status === 401 || response.status === 403) {
        response = await SignatureService.signedApFetch(post.ap_id);
      }

      if (!response.ok) {
        return res.status(502).json({ error: `Remote server returned ${response.status}` });
      }

      let remoteObject = await response.json();

      // Announce (reblog): follow the object URL to get the actual Note
      if (remoteObject.type === 'Announce') {
        const objectUrl = typeof remoteObject.object === 'string'
          ? remoteObject.object
          : remoteObject.object?.id;
        if (!objectUrl) {
          return res.status(400).json({ error: 'Announce has no object URL to follow' });
        }
        let noteResponse = await safeFetch(objectUrl, {
          headers: { 'Accept': 'application/activity+json, application/ld+json' },
        });
        if (noteResponse.status === 401 || noteResponse.status === 403) {
          noteResponse = await SignatureService.signedApFetch(objectUrl);
        }
        if (!noteResponse.ok) {
          return res.status(502).json({ error: `Remote server returned ${noteResponse.status} for announced object` });
        }
        remoteObject = await noteResponse.json();
      }

      if (remoteObject.type !== 'Note' && remoteObject.type !== 'Article') {
        return res.status(400).json({ error: `Remote object is type "${remoteObject.type}", expected Note or Article` });
      }

      const content = noteToContent(remoteObject);

      const updatePayload: any = { content };
      if (remoteObject.summary !== undefined) {
        updatePayload.content_warning = remoteObject.summary || null;
      }
      if (remoteObject.sensitive !== undefined) {
        updatePayload.is_sensitive = remoteObject.sensitive === true;
      }

      const { error: updateError } = await adminSupabase
        .from('posts')
        .update(updatePayload)
        .eq('id', post_id);

      if (updateError) {
        logger.error('Failed to update refetched post:', updateError);
        return res.status(500).json({ error: 'Failed to update post content' });
      }

      const { enrichPostLinkPreviews } = await import('../listeners/DatabaseListener.js');
      enrichPostLinkPreviews({ id: post_id, content, metadata: {} }).catch(err =>
        logger.warn('Link preview enrichment failed for refetched post:', err)
      );

      logger.info(`🔄 Admin refetched post ${post_id} from ${post.ap_id}`);

      return res.json({
        success: true,
        post_id,
        content,
        source_url: post.ap_id,
      });
    } catch (error: any) {
      logger.error(`Failed to refetch post ${post_id}:`, error);
      return res.status(502).json({ error: error.message || 'Failed to fetch from remote server' });
    }
  })
);

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

