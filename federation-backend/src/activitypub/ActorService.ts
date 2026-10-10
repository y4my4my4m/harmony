import { Router, Request, Response } from 'express';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { profileToActor } from './converters/toActivityPub.js';
import { actorToProfile, noteToContent } from './converters/fromActivityPub.js';
import { misskeyDisplayNameEmojis } from '../utils/misskeyEmojis.js';
import { resolveLocalProfileEmojis } from './emojiResolver.js';
import { stripOwnEmojiDomain } from '../utils/emojiResolvers.js';
import { isHeartReaction, storeFavourite } from '../utils/heartReaction.js';
import { ActivityProcessor } from './ActivityProcessor.js';
import { SignatureService } from './SignatureService.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { validateExternalHostname, validateExternalUrl, safeFetch } from '../utils/ssrfProtection.js';
import { discoveryLimiter, reactionsLimiter, repliesLimiter, repliesStatusLimiter } from '../middleware/rateLimit.js';
import { actorOwnsKeys, fetchAuthoritativeDocument, readApDocument, sameOrigin, urlHost, type FetchedDocument } from '../utils/apOrigin.js';
import { BlockedInstancesCache } from '../services/BlockedInstancesCache.js';
import { crawlReplies, DEFAULT_REPLY_CRAWL, replyCrawlInterval, storeReplies, type ReplyCrawl, type ReplyStore } from './repliesCollection.js';
import { noteDocumentSoftware } from './instanceSoftware.js';
import { confirmActorAcct, parseAcct, resolveActorUrl, sameAcct, withCanonicalAcct, type WebFingerCache } from './webfingerClient.js';
import { actorTombstone, deletedActorByProfile, deletedActorByUsername } from './deletedActors.js';
import { parseFocalPoint } from '../utils/focalPoint.js';
import { questionPollMetadata } from '../utils/polls.js';
import { movedColumns } from './accountMigration.js';
import { pgrstOrValue } from '../utils/postgrestFilter.js';
import {
  collectionTotal, engagementColumns, fetchProfileCounts, misskeyNoteTotals, noteEngagementColumns,
  noteEngagementTotals, profileCountColumns, profileCountsStale, refreshRemoteProfileCounts,
} from './remoteCounts.js';

const router = Router();

// Remote-reaction fetch coalescing.
// `fetchRemotePostReactions` costs up to two outbound HTTP calls per post
// (post object → likes collection). Two mechanisms bound that cost:
//
//   * TTL cache: `posts.metadata.remote_reactions_fetched_at` fresher than
//     REACTIONS_TTL_MS means callers skip the fetch and read the aggregated
//     `remote_reactions` from the row they already SELECTed.
//   * In-flight dedup: concurrent fetches for the same `post_ap_id` share
//     one Promise.
//
// 30s: likes arriving via federation push (/inbox → post_interactions
// trigger → broadcast) stay real-time on the hot path; the cache only
// governs the stale-profile path.
const REACTIONS_TTL_MS = 30_000;
const inFlightReactionFetches = new Map<string, Promise<any[]>>();

function isReactionsCacheFresh(metadata: any): boolean {
  const fetchedAt = metadata?.remote_reactions_fetched_at;
  if (!fetchedAt) return false;
  const t = Date.parse(fetchedAt);
  return Number.isFinite(t) && Date.now() - t < REACTIONS_TTL_MS;
}

/**
 * Record a failed or empty reaction fetch so the TTL cache short-circuits
 * the next call; deleted remote posts (404 on every request) are not
 * re-tried on every feed refresh. Writes only the timestamp; existing
 * `remote_reactions` is preserved.
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
    logger.debug(`markRemoteReactionsAttempted failed (non-fatal): ${err}`);
  }
}

/**
 * Stored profile of `username@domain`: the account itself, or the one remote
 * account whose actor is served from `domain` (a split-domain account named
 * by its web domain). Null when absent or ambiguous.
 */
async function findStoredRemoteAccount(supabase: any, username: string, domain: string): Promise<any | null> {
  const { data: exact } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', username)
    .eq('domain', domain)
    .maybeSingle();
  if (exact) return exact;

  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(domain)) return null;
  const { data: served } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', username)
    .eq('is_local', false)
    .ilike('federated_id', `https://${domain.toLowerCase()}/%`)
    .limit(2);
  return Array.isArray(served) && served.length === 1 ? served[0] : null;
}

export type RemoteAccountResolution =
  | { ok: true; user: any; actor: any }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * WebFinger, an authoritative fetch of the actor document, key ownership and account
 * confirmation, then the profile upsert keyed by actor id. The returned actor is the
 * document as fetched now.
 */
export async function resolveRemoteAccount(username: string, domain: string): Promise<RemoteAccountResolution> {
  const supabase = getSupabaseClient();
  try {
    // SSRF protection: validate the domain before fetching
    validateExternalHostname(domain);

    // Step 1: WebFinger, unsigned (Mastodon signs neither WebFinger nor
    // host-meta). One cache serves this lookup and the confirmation below.
    const webfingers: WebFingerCache = new Map();
    const resolved = await resolveActorUrl(username, domain, 10_000, webfingers);
    if (!resolved) {
      logger.warn(`WebFinger names no ActivityPub actor for ${username}@${domain}`);
      return { ok: false, status: 404, body: { error: 'User not found on remote instance' } };
    }

    // Step 2: Fetch the Actor
    logger.info(`Fetching actor: ${resolved.actorUrl}`);
    // BUGS.md H15: the actor URL comes from the remote webfinger response.
    // safeFetch re-validates the URL/DNS and follows redirects manually.
    // The profile is upserted under the document's own id, so the document
    // must be served from its own id (fetchAuthoritativeDocument), own its
    // keys, and name the account that was looked up.
    const actor = await fetchAuthoritativeDocument(resolved.actorUrl, async (url) => {
      const response = await SignatureService.signedApFetch(url, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
          'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
        },
        timeoutMs: 10000,
      });
      return readApDocument(response, url);
    });

    if (!actor) {
      logger.warn(`No authoritative actor document at ${resolved.actorUrl}`);
      return { ok: false, status: 404, body: {
        error: 'Failed to fetch user profile from remote instance'
      } };
    }
    noteDocumentSoftware(actor.id, actor);
    if (!actorOwnsKeys(actor)) {
      logger.warn(`Actor ${actor.id} publishes a key it does not own`);
      return { ok: false, status: 502, body: { error: 'Remote actor key owner does not match the actor' } };
    }
    // The actor's canonical account, confirmed from the actor's side, is
    // the looked-up account or the subject the queried domain named for it.
    // Unconfirmed, the actor stands on its host under its preferredUsername.
    const acct = await confirmActorAcct(actor, 10_000, webfingers);
    const queried = parseAcct(`${username}@${domain}`);
    const named = acct
      ? sameAcct(acct, queried) || sameAcct(acct, resolved.subject)
      : typeof actor.preferredUsername === 'string'
        && actor.preferredUsername.toLowerCase() === username.toLowerCase();
    if (!named) {
      logger.warn(`Actor ${actor.id} is ${acct ? `${acct.username}@${acct.domain}` : actor.preferredUsername}, not the looked-up ${username}@${domain}`);
      return { ok: false, status: 502, body: { error: 'Remote actor does not match the looked-up account' } };
    }
    logger.info(`Actor fetched: ${actor.preferredUsername || actor.name}`);
    
    // Step 3: the actor's collection totals, stored apart from the local counters.
    const countColumns = profileCountColumns(await fetchProfileCounts({
      federated_id: actor.id,
      outbox_url: typeof actor.outbox === 'string' ? actor.outbox : actor.outbox?.id,
      followers_url: typeof actor.followers === 'string' ? actor.followers : actor.followers?.id,
      following_url: typeof actor.following === 'string' ? actor.following : actor.following?.id,
    }));
    logger.info(`Stats: ${countColumns.remote_posts_count ?? '-'} posts, ${countColumns.remote_following_count ?? '-'} following, ${countColumns.remote_followers_count ?? '-'} followers`);

    // Step 4: Convert and store the profile
    logger.debug(`Actor has tag array: ${Array.isArray(actor.tag)}, length: ${actor.tag?.length || 0}`);
    logger.debug(`Actor has emojis object: ${!!actor.emojis}, keys: ${actor.emojis ? Object.keys(actor.emojis).length : 0}`);
    if (actor.tag) {
      const emojiTags = actor.tag.filter((t: any) => t.type === 'Emoji');
      logger.debug(`Emoji tags in actor: ${emojiTags.length}`);
      if (emojiTags.length > 0) {
        logger.debug(`Sample emoji tag: ${JSON.stringify(emojiTags[0])}`);
      }
    }
    if (actor.emojis && Object.keys(actor.emojis).length > 0) {
      const firstKey = Object.keys(actor.emojis)[0];
      logger.debug(`Sample emoji from object: ${firstKey} = ${actor.emojis[firstKey]}`);
    }
    
    // Unconfirmed, a stored account keeps its name rather than reverting to
    // the actor's host.
    const { data: stored } = acct
      ? { data: null }
      : await supabase.from('profiles').select('username, domain').eq('federated_id', actor.id).maybeSingle();
    const profileData = withCanonicalAcct(
      actorToProfile(actor),
      acct ?? (stored?.username && stored?.domain ? { username: stored.username, domain: String(stored.domain).toLowerCase() } : null),
    );
    logger.debug(`Profile bio_emojis count: ${profileData.bio_emojis?.length || 0}`);
    
    // SECURITY: reject a remote actor claiming the local instance domain.
    if (profileData.domain.toLowerCase() === config.INSTANCE_DOMAIN.toLowerCase()) {
      logger.warn(`SECURITY: Remote actor claims local domain! Actor: ${actor.id}, Domain: ${profileData.domain}`);
      return { ok: false, status: 400, body: { 
        error: 'Remote actor cannot claim local instance domain',
        security_violation: true
      } };
    }
    
    // SECURITY: second guard against overwriting a local profile. Unreachable
    // given the domain check above.
    const { data: existingLocalUser } = await supabase
      .from('profiles')
      .select('id, is_local')
      .eq('username', profileData.username)
      .eq('domain', profileData.domain)
      .eq('is_local', true)
      .maybeSingle();
    
    if (existingLocalUser) {
      logger.warn(`SECURITY: Refusing to overwrite local user ${profileData.username}@${profileData.domain}`);
      return { ok: false, status: 400, body: { 
        error: 'Cannot overwrite local user with federated data',
        security_violation: true
      } };
    }
    
    // A stored account stays bound to its actor id; a different document
    // for the same username@domain does not take it over.
    const { data: boundUser } = await supabase
      .from('profiles')
      .select('id, federated_id')
      .eq('username', profileData.username)
      .eq('domain', profileData.domain)
      .maybeSingle();
    if (boundUser?.federated_id && boundUser.federated_id !== profileData.federated_id) {
      logger.warn(`Refusing to rebind ${profileData.username}@${profileData.domain} from ${boundUser.federated_id} to ${profileData.federated_id}`);
      return { ok: false, status: 409, body: { error: 'Account is bound to a different actor' } };
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
    const { data: previous } = await supabase
      .from('profiles')
      .select('id, moved_to_uri')
      .eq('federated_id', profileData.federated_id)
      .maybeSingle();
    Object.assign(profileRecord, await movedColumns(supabase, profileData, previous));
    
    // Persist ActivityPub profile fields (PropertyValue attachments)
    if (profileData.profile_fields) {
      profileRecord.profile_fields = profileData.profile_fields;
    }

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

    Object.assign(profileRecord, countColumns);

    // Keyed by actor id: a row stored under the actor's host before its
    // canonical account was known moves to that account.
    let savedUser;
    const { data: upsertedUser, error: saveError } = await supabase
      .from('profiles')
      .upsert(profileRecord, {
        onConflict: 'federated_id',
      })
      .select()
      .single();

    if (saveError) {
      // Concurrent request already inserted the row; read it back.
      if (saveError.message.includes('duplicate key') || saveError.code === '23505') {
        logger.info(`Race condition detected, fetching existing user: ${profileData.federated_id}`);
        const { data: existingUser } = await supabase
          .from('profiles')
          .select('*')
          .eq('federated_id', profileData.federated_id)
          .maybeSingle();
        
        if (existingUser) {
          savedUser = existingUser;
        } else {
          logger.error(`Failed to save remote user and couldn't find existing: ${saveError.message}`);
          return { ok: false, status: 500, body: { 
            error: 'Failed to store user profile',
            details: saveError.message
          } };
        }
      } else {
        logger.error(`Failed to save remote user: ${saveError.message}`);
        return { ok: false, status: 500, body: { 
          error: 'Failed to store user profile',
          details: saveError.message
        } };
      }
    } else {
      savedUser = upsertedUser;
    }

    return { ok: true, user: savedUser, actor };
  } catch (error: any) {
    logger.error(`Error looking up remote user ${username}@${domain}:`, error);

    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return { ok: false, status: 504, body: { error: 'Remote server took too long to respond' } };
    }

    return { ok: false, status: 500, body: { error: 'Failed to lookup remote user', details: error.message } };
  }
}

/**
 * Lookup remote user via WebFinger.
 * POST /lookup-user (proxied via /api/federation/lookup-user)
 * Body: { handle: "username@domain" }
 *
 * Server-side proxy; browsers cannot fetch WebFinger cross-origin.
 */
router.post(
  '/lookup-user',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { handle, forceRefresh } = req.body;

    if (!handle || typeof handle !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid handle parameter' });
    }

    const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
    const parts = cleanHandle.split('@');
    
    if (parts.length !== 2) {
      return res.status(400).json({ error: 'Invalid handle format. Use username@domain' });
    }

    const [username, domain] = parts;
    const supabase = getSupabaseClient();

    // SECURITY: local users are never resolved through federation lookup.
    if (domain.toLowerCase() === config.INSTANCE_DOMAIN.toLowerCase()) {
      logger.warn(`Refusing federation lookup for local domain: ${username}@${domain}`);
      
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

    logger.info(`Looking up remote user: ${username}@${domain}${forceRefresh ? ' (force refresh)' : ''}`);

    if (!forceRefresh) {
      const existingUser = await findStoredRemoteAccount(supabase, username, domain);

      if (existingUser) {
        logger.info(`Found existing user in database: ${username}@${domain}`);
        
        // Absent emoji metadata forces a refetch.
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
        
        // Refresh only when metadata is absent and display name or bio carry shortcodes.
        const hasEmojiPatterns = 
          (existingUser.bio && existingUser.bio.includes(':')) ||
          (existingUser.display_name && existingUser.display_name.includes(':'));
        if (needsMetadataRefresh && hasEmojiPatterns) {
          logger.info(`User ${username}@${domain} has emoji patterns but no emoji metadata - forcing refresh`);
          // Falls through to the full fetch; the cached row is not returned.
        } else {
          // Background outbox fetch when outbox_url is known and the last sync
          // is absent or older than 5 minutes.
          const shouldFetchPosts = existingUser.outbox_url && (
            !existingUser.last_federation_sync || 
            (Date.now() - new Date(existingUser.last_federation_sync).getTime()) > 5 * 60 * 1000
          );
          
          const backfilling = !!shouldFetchPosts
            && startOutboxBackfill(existingUser.id, existingUser.outbox_url, supabase, `${username}@${domain}`);

          // Collection totals older than PROFILE_COUNTS_TTL_MS are read again before answering.
          if (!existingUser.is_local && profileCountsStale(existingUser)) {
            const columns = await refreshRemoteProfileCounts(supabase, existingUser);
            if (columns) Object.assign(existingUser, columns);
          }
          
          return res.json({
            success: true,
            user: existingUser,
            outbox_url: existingUser.outbox_url, // Always include for pagination
            cached: true,
            backfilling,
          });
        }
      }
    }

    const resolved = await resolveRemoteAccount(username, domain);
    if (!resolved.ok) {
      return res.status(resolved.status).json(resolved.body);
    }
    const { user: savedUser, actor } = resolved;

    logger.info(`${forceRefresh ? 'Refreshed' : 'Created'} remote user: ${username}@${domain}`);
    
    const backfilling = typeof actor.outbox === 'string'
      && startOutboxBackfill(savedUser.id, actor.outbox, supabase, `${username}@${domain}`);
    
    return res.json({
      success: true,
      user: savedUser,
      outbox_url: actor.outbox, // Include for pagination
      cached: false,
      refreshed: forceRefresh || false,
      backfilling,
    });
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

    // SSRF gate (BUGS.md H13): reject internal/private targets before any
    // fetch. safeFetch re-validates downstream, but failing here returns a
    // clean 400 instead of leaking timing/behavior differences.
    try {
      validateExternalUrl(url);
    } catch {
      return res.status(400).json({ error: 'Invalid or disallowed url' });
    }

    const supabase = getSupabaseClient();

    // Fediverse platforms serve one post under several URL forms
    // (GoToSocial: /users/x/statuses/ID vs /@x/statuses/ID).
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
    } catch { /* invalid URL; only the original is used */ }

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

    logger.info(`Resolving remote post: ${url}`);
    const result = await ActivityProcessor.fetchAndCreateRemotePost(url);

    if (!result) {
      return res.status(404).json({ error: 'Could not resolve remote post' });
    }

    logger.info(`Resolved remote post ${url} → ${result.id}`);
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

    // SSRF gate (BUGS.md H14): caller-supplied URLs are never fetched. The
    // outbox URL must match the stored profile row, reducing client input to
    // a confirmation of server-known state.
    const { data: profileRow } = await supabase
      .from('profiles')
      .select('outbox_url, is_local')
      .eq('id', user_id)
      .maybeSingle();

    if (!profileRow || profileRow.is_local || !profileRow.outbox_url || profileRow.outbox_url !== outbox_url) {
      return res.status(400).json({ error: 'outbox_url does not match the stored profile' });
    }
    try {
      validateExternalUrl(outbox_url);
    } catch {
      return res.status(400).json({ error: 'Invalid or disallowed outbox_url' });
    }

    logger.info(`Fetch posts request for user ${user_id} (load_more=${!!max_id})`);

    try {
      const result = await fetchRecentPostsInBackground(
        user_id, 
        outbox_url, 
        supabase, 
        max_id, 
        Math.min(limit, 20)
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
  reactionsLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { posts } = req.body;

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ error: 'posts array is required' });
    }

    const MAX_BATCH = 30;
    const batch = posts.slice(0, MAX_BATCH);
    const supabase = getSupabaseClient();
    const results: Record<string, any> = {};

    // One round-trip metadata lookup for every entry carrying a post_id,
    // feeding both the TTL cache check below and the returned counts.
    // Replaces a per-post SELECT.
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

        // TTL cache hit: no outbound HTTP. The aggregated `remote_reactions`
        // is on the row already SELECTed.
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
            // Re-read AFTER the fetch: `fetchRemotePostReactions` may have
            // written metadata. The Misskey path writes remote_reactions
            // in-line; the standard AP path returns raw reactions that are
            // aggregated below.
            const { data } = await supabase
              .from('posts')
              .select('metadata, favorites_count, replies_count, reblogs_count')
              .eq('id', entry.post_id)
              .single();
            updatedPost = data ?? null;
            remote_reactions = updatedPost?.metadata?.remote_reactions || null;
          }

          if (!remote_reactions && reactions.length > 0) {
            remote_reactions = aggregateRemoteReactions(reactions);
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
            // Successful fetch with zero reactions still marks the TTL cache;
            // an empty post is not re-hit on every refresh.
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
          // TTL-cache the failure: a broken remote (HTML 404 served as 200,
          // malformed JSON) is not re-tried on every refresh.
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
  reactionsLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    logger.debug(`fetch-reactions raw body: ${JSON.stringify(req.body)}`);
    
    const { post_ap_id, post_id } = req.body;

    if (!post_ap_id) {
      logger.warn(`fetch-reactions missing post_ap_id, body was: ${JSON.stringify(req.body)}`);
      return res.status(400).json({ error: 'post_ap_id is required' });
    }

    const supabase = getSupabaseClient();

    // Local posts already hold their reactions in the database.
    try {
      const apDomain = new URL(post_ap_id).hostname;
      if (apDomain === config.INSTANCE_DOMAIN) {
        logger.debug(`Skipping fetch-reactions for local post: ${post_ap_id}`);
        return res.json({ success: true, reactions: [], count: 0 });
      }
    } catch { /* invalid URL, proceed */ }

    try {
      // TTL cache: rows refreshed within REACTIONS_TTL_MS return the stored
      // aggregate without touching the network.
      if (post_id) {
        const { data: cached } = await supabase
          .from('posts')
          .select('metadata, favorites_count, replies_count, reblogs_count')
          .eq('id', post_id)
          .maybeSingle();
        if (cached && isReactionsCacheFresh(cached.metadata)) {
          logger.debug(`fetch-reactions cache HIT for ${post_ap_id}`);
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

      logger.info(`Fetching reactions for remote post: ${post_ap_id}`);

      const reactions = await fetchRemotePostReactions(post_ap_id, post_id, supabase);

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

      // For non-Misskey instances (Mastodon, Pleroma, GoToSocial),
      // fetchRemotePostReactions returns raw reactions and never builds
      // remote_reactions; aggregation happens here.
      if (!remote_reactions && reactions.length > 0) {
        remote_reactions = aggregateRemoteReactions(reactions);
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
        // Zero reactions on a successful fetch still TTL-caches the attempt.
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
      // TTL-cache the failure, as in the batch handler.
      await markRemoteReactionsAttempted(post_id, supabase);
      return res.status(500).json({ error: 'Failed to fetch reactions' });
    }
  })
);

/**
 * Reaction chips by emoji, at most 10 reactors each. Favourites (bare Likes and unicode
 * hearts) are counted in favorites_count, not as a chip.
 */
function aggregateRemoteReactions(
  reactions: Array<{ emoji: string; emoji_url?: string; actor?: any }>,
): Record<string, { count: number; url?: string; reactors: any[] }> {
  const byEmoji = new Map<string, { count: number; url?: string; reactors: any[] }>();
  for (const r of reactions) {
    if (!r.emoji_url && isHeartReaction(r.emoji)) continue;
    const key = r.emoji;
    if (!byEmoji.has(key)) byEmoji.set(key, { count: 0, url: r.emoji_url, reactors: [] });
    const entry = byEmoji.get(key)!;
    entry.count++;
    if (entry.reactors.length < 10 && r.actor) {
      entry.reactors.push({
        username: r.actor.username,
        display_name: r.actor.display_name || r.actor.username,
        display_name_emojis: r.actor.display_name_emojis,
        avatar_url: r.actor.avatar_url,
        domain: r.actor.domain,
      });
    }
  }
  return Object.fromEntries(byEmoji);
}

/**
 * "https://misskey.io/notes/abc123" -> "abc123"
 */
function extractMisskeyNoteId(url: string): string | null {
  const match = url.match(/\/notes\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Hostname and path heuristics; covers Misskey and its forks.
 */
function isMisskeyInstance(url: string): boolean {
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
 * Reactions via Misskey's POST /api/notes/reactions.
 */
async function fetchMisskeyReactions(
  domain: string,
  noteId: string,
  postId: string | undefined,
  supabase: any
): Promise<any[]> {
  try {
    logger.info(`Fetching reactions via Misskey API for note: ${noteId} on ${domain}`);
    
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
    logger.info(`Misskey returned ${reactionsData.length} reactions`);

    // Counts per emoji type; custom emojis also carry a URL.
    const reactionCounts: Map<string, { count: number; emoji_url?: string; is_custom: boolean }> = new Map();
    const reactions: any[] = [];
    
    // Two custom-emoji classes in Misskey reactions:
    // 1. Native to the origin instance (:kawa_yu@.:) - only in the origin's emoji API.
    // 2. Third-party (:name@remote.example:) - present in the note's reactionEmojis.
    
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
        // reactionEmojis holds emojis federated in from other instances.
        if (noteData.reactionEmojis) {
          thirdPartyEmojis = noteData.reactionEmojis;
          logger.info(`Found ${Object.keys(thirdPartyEmojis).length} third-party emoji definitions`);
        }
        if (postId) {
          const columns = engagementColumns(misskeyNoteTotals(noteData));
          if (Object.keys(columns).length > 0) {
            await supabase.from('posts').update(columns).eq('id', postId);
          }
        }
      }
    } catch (e) {
      logger.warn(`Could not fetch note emoji definitions: ${e}`);
    }
    
    // Misskey marks origin-instance emojis with an @. suffix.
    const originEmojiNames: string[] = [];
    for (const reaction of reactionsData) {
      const emoji = reaction.type || '';
      if (emoji.startsWith(':') && emoji.endsWith('@.:')) {
        const emojiName = emoji.slice(1, -3); // strips leading ':' and trailing '@.:'
        originEmojiNames.push(emojiName);
      }
    }
    
    if (originEmojiNames.length > 0) {
      try {
        logger.info(`Fetching ${originEmojiNames.length} origin-instance emojis from ${domain}`);
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
          // emojiData.emojis: array of { name, url, ... }
          if (emojiData.emojis && Array.isArray(emojiData.emojis)) {
            for (const e of emojiData.emojis) {
              if (originEmojiNames.includes(e.name)) {
                originInstanceEmojis[`:${e.name}@.:`] = e.url;
                logger.debug(`Found origin emoji :${e.name}@.: -> ${e.url}`);
              }
            }
            logger.info(`Found ${Object.keys(originInstanceEmojis).length} origin-instance emoji URLs`);
          }
        }
      } catch (e) {
        logger.warn(`Could not fetch origin-instance emoji definitions: ${e}`);
        
        // Fallback to Misskey's conventional emoji URL layout.
        for (const name of originEmojiNames) {
          const fallbackUrl = `https://${domain}/emoji/${name}.webp`;
          originInstanceEmojis[`:${name}@.:`] = fallbackUrl;
          logger.debug(`Using fallback URL for :${name}@.: -> ${fallbackUrl}`);
        }
      }
    }
    
    // Reactors are aggregated by emoji only; no profile rows are created.
    for (const reaction of reactionsData) {
      const user = reaction.user;
      const emoji = reaction.type || '❤️';
      
      const isCustomEmoji = emoji.startsWith(':') && emoji.endsWith(':');
      let emojiUrl: string | undefined;
      
      if (isCustomEmoji) {
        if (emoji.endsWith('@.:')) {
          emojiUrl = originInstanceEmojis[emoji];
        } else {
          // reactionEmojis is keyed by emoji name without surrounding colons.
          const emojiName = emoji.slice(1, -1);
          emojiUrl = thirdPartyEmojis[emojiName] || thirdPartyEmojis[emoji];
        }
        
        if (emojiUrl) {
          logger.debug(`Found URL for custom emoji ${emoji}: ${emojiUrl}`);
        } else {
          logger.debug(`No URL found for custom emoji ${emoji}`);
        }
      }
      
      const existing = reactionCounts.get(emoji) || { count: 0, is_custom: isCustomEmoji, emoji_url: undefined };
      existing.count++;
      if (emojiUrl && !existing.emoji_url) {
        existing.emoji_url = emojiUrl;
      }
      reactionCounts.set(emoji, existing);
      
      // remote_emojis_cache backs the emoji importer.
      if (isCustomEmoji && emojiUrl) {
        try {
          let shortcode: string;
          let originDomain: string;
          let normalizedFullCode: string;
          
          if (emoji.endsWith('@.:')) {
            // :kawa_yu@.: -> shortcode=kawa_yu, domain=origin
            shortcode = emoji.slice(1, -3);
            originDomain = domain;
            normalizedFullCode = `${shortcode}@${domain}`;
          } else if (emoji.includes('@')) {
            // :name@remote.example: -> shortcode=name, domain=remote.example
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
            // :smile: -> shortcode=smile, domain=origin
            shortcode = emoji.slice(1, -1);
            originDomain = domain;
            normalizedFullCode = `${shortcode}@${domain}`;
          }
          
          await supabase.rpc('upsert_remote_emoji', {
            p_shortcode: shortcode,
            p_origin_domain: originDomain,
            p_full_code: normalizedFullCode,
            p_url: emojiUrl,
          });
          
          logger.debug(`Cached remote emoji: ${shortcode}@${originDomain}`);
        } catch (cacheError) {
          // Cache write failure is non-fatal.
          logger.debug(`Could not cache emoji ${emoji}: ${cacheError}`);
        }
      }
      
      const displayNameEmojis = misskeyDisplayNameEmojis(user, domain);
      
      if (user?.host !== null && user?.host !== undefined) {
        logger.debug(`Reactor ${user?.username} has host: "${user.host}"`);
      }
      
      // Misskey reports user.host as null (or '.') for its own local users.
      const reactorDomain = (user?.host && user.host !== '.') ? user.host : domain;
      
      // Actor info is for display only; nothing is persisted.
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

    if (postId && reactionCounts.size > 0) {
      const { data: currentPost } = await supabase
        .from('posts')
        .select('metadata')
        .eq('id', postId)
        .single();
      
      // Reactors grouped by emoji, capped at 10 per emoji.
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
      
      // Misskey's like is its heart reaction, counted in favorites_count from notes/show.
      for (const [emoji, data] of reactionCounts) {
        if (!data.is_custom && isHeartReaction(emoji)) {
          continue;
        }
        // Misskey keys are :name@.: or :name@domain:; the frontend expects :name:.
        let normalizedEmoji = emoji;
        if (emoji.startsWith(':') && emoji.endsWith(':')) {
          normalizedEmoji = emoji.replace(/@[^:]*:$/, ':');
        }
        
        reactionSummary[normalizedEmoji] = { 
          count: data.count,
          url: data.emoji_url,
          reactors: reactorsByEmoji.get(emoji) || [],
        };
      }
      
      const updatedMetadata = {
        ...(currentPost?.metadata || {}),
        remote_reactions: reactionSummary,
        remote_reactions_fetched_at: new Date().toISOString(),
      };
      
      const { error: updateError } = await supabase
        .from('posts')
        .update({ metadata: updatedMetadata })
        .eq('id', postId);
      
      if (updateError) {
        logger.warn(`Failed to update post metadata: ${updateError.message}`);
      } else {
        const totalReactors = Array.from(reactorsByEmoji.values()).reduce((sum, r) => sum + r.length, 0);
        logger.info(`Updated post with ${reactionCounts.size} reaction types, ${totalReactors} reactor profiles`);
      }
    }
    
    const summary = Array.from(reactionCounts.entries())
      .map(([emoji, data]) => `${emoji}: ${data.count}`)
      .join(', ');
    logger.info(`Reaction breakdown: ${summary}`);

    return reactions;
  } catch (error) {
    logger.error(`Failed to fetch Misskey reactions:`, error);
    return [];
  }
}

/**
 * Fetch reactions from a remote post's likes collection.
 *
 * Concurrent calls for the same `postApId` are coalesced through
 * `inFlightReactionFetches` into a single outbound burst. The TTL cache
 * lives in the route handlers, which already SELECT the post row and so
 * check it without extra DB round-trips.
 */
async function fetchRemotePostReactions(
  postApId: string,
  postId: string | undefined,
  supabase: any
): Promise<any[]> {
  // Local posts return before the dedup map can hold a same-host key.
  try {
    if (new URL(postApId).hostname === config.INSTANCE_DOMAIN) return [];
  } catch { /* invalid URL; _impl handles the failure */ }

  const existing = inFlightReactionFetches.get(postApId);
  if (existing) {
    logger.debug(`In-flight dedup HIT for ${postApId}`);
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
    // Local post reactions are already in the DB.
    try {
      const apDomain = new URL(postApId).hostname;
      if (apDomain === config.INSTANCE_DOMAIN) {
        return [];
      }
    } catch { /* invalid URL, proceed */ }

    // Misskey's native API carries emoji reactions that ActivityPub does not.
    if (isMisskeyInstance(postApId)) {
      const noteId = extractMisskeyNoteId(postApId);
      const domain = new URL(postApId).hostname;
      
      if (noteId) {
        const misskeyReactions = await fetchMisskeyReactions(domain, noteId, postId, supabase);
        if (misskeyReactions.length > 0) {
          return misskeyReactions;
        }
        // Empty result falls through to the standard ActivityPub path.
        logger.info(`Misskey API returned no reactions, trying standard ActivityPub...`);
      }
    }

    // Standard ActivityPub path.
    //
    // The post object carries the likes, shares and replies totals (Mastodon embeds likes
    // and shares as collections holding totalItems only); the three are stored together as
    // the post's origin figures. The likes collection is then read for its items: embedded,
    // at the URL the post names, or at `${ap_id}/likes`, where Pleroma, Akkoma, GoToSocial,
    // Friendica, Pixelfed and Harmony serve it.
    //
    // BUGS.md H15: postApId is attacker-influenced (inbox / remote feed);
    // every outbound call goes through safeFetch for SSRF protection.
    const apHeaders = {
      'Accept': 'application/activity+json, application/ld+json',
      'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`,
    } as const;

    const postResponse = await SignatureService.signedApFetch(postApId, {
      headers: apHeaders,
      timeoutMs: 10000,
    });

    if (!postResponse.ok) {
      logger.warn(`Failed to fetch post: ${postResponse.status}`);
      // 404 / 410 / unauthorized is sticky for the TTL window; a known-dead
      // post is not re-hit on the next feed refresh.
      await markRemoteReactionsAttempted(postId, supabase);
      return [];
    }

    const post = await postResponse.json();
    const totals = noteEngagementTotals(post);
    const storeTotals = async () => {
      const columns = engagementColumns(totals);
      if (postId && Object.keys(columns).length > 0) {
        await supabase.from('posts').update(columns).eq('id', postId);
      }
    };

    let likesCollection: any = null;
    const likesRef = post.likes ?? post.reactions;
    const embeddedLikes = likesRef && typeof likesRef === 'object'
      && (likesRef.first !== undefined || Array.isArray(likesRef.items) || Array.isArray(likesRef.orderedItems)
        || collectionTotal(likesRef) !== null);
    if (embeddedLikes) {
      likesCollection = likesRef;
    } else {
      const likesCollectionUrl = typeof likesRef === 'string' ? likesRef
        : typeof likesRef?.id === 'string' ? likesRef.id
        : `${postApId}/likes`;
      try {
        if (new URL(likesCollectionUrl).hostname === config.INSTANCE_DOMAIN) {
          logger.info(`Skipping self-fetch for likes: ${likesCollectionUrl}`);
          await storeTotals();
          await markRemoteReactionsAttempted(postId, supabase);
          return [];
        }
      } catch { /* invalid URL, proceed */ }

      const likesResponse = await SignatureService.signedApFetch(likesCollectionUrl, {
        headers: apHeaders,
        timeoutMs: 10000,
      });
      if (likesResponse.ok) {
        likesCollection = await likesResponse.json();
        totals.likes = collectionTotal(likesCollection) ?? totals.likes;
      } else {
        logger.debug(`📬 No likes collection at ${likesCollectionUrl}: ${likesResponse.status}`);
      }
    }

    if (!likesCollection) {
      await storeTotals();
      await markRemoteReactionsAttempted(postId, supabase);
      return [];
    }

    const totalLikes: number | null = collectionTotal(likesCollection);

    let items: any[] = [];
    
    if (likesCollection.orderedItems) {
      items = likesCollection.orderedItems;
    } else if (likesCollection.items) {
      items = likesCollection.items;
    } else if (likesCollection.first) {
      const first = likesCollection.first;
      if (typeof first === 'object' && (Array.isArray(first.orderedItems) || Array.isArray(first.items))) {
        items = first.orderedItems || first.items;
      } else {
        const firstPageUrl = typeof first === 'string' ? first : first.id;
        try {
          const pageResponse = await SignatureService.signedApFetch(firstPageUrl, {
            headers: apHeaders,
            timeoutMs: 10000,
          });
          if (pageResponse.ok) {
            const page = await pageResponse.json();
            items = page.orderedItems || page.items || [];
          }
        } catch (err) {
          logger.debug(`Likes page ${firstPageUrl} unreadable: ${err}`);
        }
      }
    }

    logger.info(`Found ${items.length} reactions`);

    const reactions: any[] = [];
    let favouriteItems = 0;
    
    for (const item of items.slice(0, 50)) {
      try {
        let actorUrl: string;
        let emoji: string = '❤️';
        let reactionContent: string | null = null;
        let isCustomEmoji = false;

        if (typeof item === 'string') {
          // Bare actor URL denotes a plain Like.
          actorUrl = item;
        } else if (item.type === 'Like' || item.type === 'EmojiReaction') {
          actorUrl = typeof item.actor === 'string' ? item.actor : item.actor?.id;
          
          // Misskey carries the reaction emoji in `content` / `_misskey_reaction`.
          if (item.content) {
            emoji = item.content;
            reactionContent = item.content;
          }
          if (item._misskey_reaction) {
            emoji = item._misskey_reaction;
            reactionContent = item._misskey_reaction;
          }
          // Mastodon/Pleroma name the custom emoji in an Emoji tag.
          if (item.tag && Array.isArray(item.tag)) {
            const emojiTag = item.tag.find((t: any) => t.type === 'Emoji');
            if (emojiTag) {
              emoji = emojiTag.name || emoji;
              reactionContent = emojiTag.name;
              isCustomEmoji = true;
            }
          }
        } else {
          continue;
        }

        if (!actorUrl) continue;

        // A bare Like or a unicode heart is a favourite (utils/heartReaction.ts).
        const isFavourite = !isCustomEmoji && (!reactionContent || isHeartReaction(reactionContent));
        if (isFavourite) favouriteItems++;

        // Mastodon/Pleroma carry the custom emoji image at tag.icon.url. No
        // column holds it, so remote reactions keep only the shortcode.

        // Known profiles supply full actor info; otherwise it is derived from the URL.
        let actorInfo: any = { url: actorUrl };
        
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

        // Persisted only when both the post and the reactor are known locally, and the
        // reactor is remote: a local actor listed here is our own Like coming back, and
        // the local row is authoritative. Every unique index over emoji_reaction rows is
        // partial and PostgREST emits no index predicate, so ON CONFLICT infers no
        // arbiter. Mirrors ActivityProcessor.processLike.
        if (postId && localProfile?.id && !localProfile.is_local && isFavourite) {
          const outcome = await storeFavourite(supabase, postId, localProfile.id, {
            ap_id: item.id || `${actorUrl}#like-${postId}`,
          });
          if (outcome === 'failed') {
            logger.error(`Failed to persist remote favourite on post ${postId}`);
          }
        } else if (postId && localProfile?.id && !localProfile.is_local) {
          // A reaction this instance emitted returns qualified with our own domain, as
          // `:name@our.domain:` against the `:name:` already stored. The dedupe below
          // compares the shortcode literally, so the two spellings both persist and the
          // chip splits. Strip the suffix when the domain is ours.
          const content = stripOwnEmojiDomain(reactionContent || emoji);

          const { data: existing } = await supabase
            .from('post_interactions')
            .select('id')
            .eq('user_id', localProfile.id)
            .eq('post_id', postId)
            .eq('interaction_type', 'emoji_reaction')
            .eq('custom_emoji_content', content)
            .maybeSingle();

          if (!existing) {
            const { error: interactionError } = await supabase
              .from('post_interactions')
              .insert({
                user_id: localProfile.id,
                post_id: postId,
                interaction_type: 'emoji_reaction',
                custom_emoji_content: content,
                ap_id: item.id || `${actorUrl}#like-${postId}`,
                is_local: false,
              });

            if (interactionError) {
              logger.error(`Failed to persist remote reaction on post ${postId}: ${interactionError.message}`);
            }
          }
        }
      } catch (err) {
        logger.debug(`Failed to process reaction:`, err);
      }
    }

    // A collection enumerated in full counts its favourites without its emoji reactions.
    if (totalLikes !== null && items.length >= totalLikes && items.length <= 50) {
      totals.likes = favouriteItems;
    }
    await storeTotals();

    logger.info(`Processed ${reactions.length} reactions for post`);
    return reactions;

  } catch (error) {
    logger.warn(`Failed to fetch remote reactions:`, error);
    return [];
  }
}

// Reply crawls. One post is crawled once at a time; the next crawl is due replyCrawlInterval
// after the last, recorded in posts.replies_fetched_at, or FORCED_REPLY_CRAWL_COOLDOWN_MS after
// it when the reader asks. lastReplyCrawls holds start times as well, for posts without a row
// here. A crawl costs up to DEFAULT_REPLY_CRAWL.maxPages + maxReplies + 1 requests, so at most
// MAX_REPLY_CRAWLS run at once across all posts.
const FORCED_REPLY_CRAWL_COOLDOWN_MS = 60 * 1000;
const MAX_REPLY_CRAWLS = 4;
/** POST /fetch-replies answers 'started' when the crawl takes longer than this. */
const REPLY_CRAWL_ANSWER_WAIT_MS = 800;
/** A finished crawl's result stays readable from /fetch-replies/status this long. */
const REPLY_CRAWL_RESULT_TTL_MS = 15 * 60 * 1000;
/** replyCrawlInterval of a post older than a day. */
const LONGEST_REPLY_CRAWL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REPLY_CRAWL_MAP_LIMIT = 5000;
const lastReplyCrawls = new Map<string, number>();
const inflightReplyCrawls = new Map<string, Promise<RemoteReplyFetch>>();
const finishedReplyCrawls = new Map<string, { result: RemoteReplyFetch; at: number }>();

type RemoteReplyFetch = Omit<ReplyCrawl, 'status'> & {
  /** 'unavailable': the post could not be read from its origin; 'unauthorized': it answered 401 or 403. */
  status: ReplyCrawl['status'] | 'unavailable' | 'unauthorized';
  /**
   * remote_replies_count the crawl established: `found` after a complete walk of a Note that
   * carries no reply total of its own. Null otherwise.
   */
  total: number | null;
};

const unreadReplies = (status: 'unavailable' | 'unauthorized'): RemoteReplyFetch => ({
  status, found: 0, stored: 0, existing: 0, skipped: 0, pages: 0, truncated: false, complete: false, total: null,
});

function pruneReplyCrawlState(now: number): void {
  if (lastReplyCrawls.size > REPLY_CRAWL_MAP_LIMIT) {
    for (const [key, at] of lastReplyCrawls) {
      if (now - at >= LONGEST_REPLY_CRAWL_INTERVAL_MS) lastReplyCrawls.delete(key);
    }
  }
  if (finishedReplyCrawls.size > REPLY_CRAWL_MAP_LIMIT) {
    for (const [key, entry] of finishedReplyCrawls) {
      if (now - entry.at >= REPLY_CRAWL_RESULT_TTL_MS) finishedReplyCrawls.delete(key);
    }
  }
}

/** Signed GET as the instance actor; blocked hosts are not contacted. */
const fetchSignedDocument = (url: string, onStatus?: (status: number) => void): Promise<FetchedDocument | null> =>
  ActivityProcessor.fetchApDocument(url, onStatus);

function replyStore(supabase: any): ReplyStore {
  return {
    isBlockedHost: (host) => BlockedInstancesCache.isBlocked(host),
    existing: async (ids) => {
      const { data } = await supabase.from('posts').select('ap_id').in('ap_id', ids);
      return new Set((data || []).map((row: { ap_id: string }) => row.ap_id));
    },
    storeById: async (id) => (await ActivityProcessor.fetchAndCreateRemotePost(id)) ? 'stored' : 'skipped',
    storeObject: async (object) => (await ActivityProcessor.storeRemotePost(object)) ? 'stored' : 'skipped',
  };
}

interface ReplyTarget {
  id: string;
  created_at: string | null;
  replies_fetched_at: string | null;
  replies_count: number | null;
  favorites_count: number | null;
  reblogs_count: number | null;
}

/** The row stored under `postApId`, as its ap_id or url. post_id from a client is not trusted to name it. */
async function readReplyTarget(supabase: any, postApId: string): Promise<ReplyTarget | null> {
  const { data } = await supabase
    .from('posts')
    .select('id, created_at, replies_fetched_at, replies_count, favorites_count, reblogs_count')
    .or(`ap_id.eq.${pgrstOrValue(postApId)},url.eq.${pgrstOrValue(postApId)}`)
    .eq('is_deleted', false)
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

function replyTargetCounts(target: ReplyTarget | null): Record<string, number | string | null> {
  if (!target) return {};
  return {
    replies_count: target.replies_count ?? 0,
    favorites_count: target.favorites_count ?? 0,
    reblogs_count: target.reblogs_count ?? 0,
    replies_fetched_at: target.replies_fetched_at ?? null,
  };
}

function replyCrawlBody(result: RemoteReplyFetch) {
  return {
    outcome: result.status,
    found: result.found,
    stored: result.stored,
    existing: result.existing,
    skipped: result.skipped,
    pages: result.pages,
    truncated: result.truncated,
    complete: result.complete,
  };
}

/** Records the end of a crawl on the post: its time, and the reply total it established. */
async function recordReplyCrawl(supabase: any, postId: string, result: RemoteReplyFetch, readAt: Date): Promise<void> {
  const columns: Record<string, number | string> = { replies_fetched_at: new Date().toISOString() };
  if (result.total !== null) {
    columns.remote_replies_count = result.total;
    columns.remote_counts_fetched_at = readAt.toISOString();
  }
  const { error } = await supabase.from('posts').update(columns).eq('id', postId);
  if (error) logger.warn(`Recording the reply crawl of post ${postId} failed: ${error.message}`);
}

/** Starts a crawl of `postApId`; the promise never rejects. */
function startReplyCrawl(postApId: string, postId: string | undefined, supabase: any, maxReplies: number, now: number): Promise<RemoteReplyFetch> {
  lastReplyCrawls.set(postApId, now);
  pruneReplyCrawlState(now);
  logger.info(`Fetching replies for remote post: ${postApId}`);
  const readAt = new Date(now);
  const crawl = (async () => {
    let result: RemoteReplyFetch;
    try {
      result = await fetchRemotePostReplies(postApId, postId, supabase, maxReplies, readAt);
    } catch (error) {
      logger.error(`Reply crawl of ${postApId} failed:`, error);
      result = unreadReplies('unavailable');
    }
    if (postId) await recordReplyCrawl(supabase, postId, result, readAt);
    finishedReplyCrawls.set(postApId, { result, at: Date.now() });
    return result;
  })().finally(() => inflightReplyCrawls.delete(postApId));
  inflightReplyCrawls.set(postApId, crawl);
  return crawl;
}

/** The crawl's result when it ends within `ms`, else null. */
async function replyCrawlWithin(crawl: Promise<RemoteReplyFetch>, ms: number): Promise<RemoteReplyFetch | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([crawl, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch replies for a remote post
 * POST /fetch-replies (proxied via /api/federation/fetch-replies)
 * Body: { post_ap_id: string, post_id?: string, limit?: number, force?: boolean, async?: boolean }
 *
 * Reads the post from its origin, stores its likes, shares and replies figures, and stores
 * the replies its collection lists (DEFAULT_REPLY_CRAWL bounds, `limit` lowering the reply
 * bound). `force` is the reader asking from the post menu: it shortens the interval to
 * FORCED_REPLY_CRAWL_COOLDOWN_MS.
 *
 * With `async: true` the answer comes within REPLY_CRAWL_ANSWER_WAIT_MS and the crawl goes on;
 * /fetch-replies/status follows it. `status` is 'started' (this request began a crawl),
 * 'running' (one was under way), 'done' (it ended within the wait; `result` holds it) or
 * 'recent' (none was due; `result` holds the last one this process remembers, or null).
 * Without it the answer waits for the crawl and carries the counts at top level, as clients
 * up to 1.7.0 read them. 503 'busy' answers a request that finds MAX_REPLY_CRAWLS running.
 */
router.post(
  '/fetch-replies',
  repliesLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { post_ap_id, limit, force } = req.body;
    const answerEarly = req.body?.async === true;

    if (!post_ap_id || typeof post_ap_id !== 'string') {
      return res.status(400).json({ error: 'post_ap_id is required' });
    }

    // Local posts already hold their replies in the database.
    try {
      const apDomain = new URL(post_ap_id).hostname;
      if (apDomain === config.INSTANCE_DOMAIN) {
        logger.debug(`Skipping fetch-replies for local post: ${post_ap_id}`);
        return answerEarly
          ? res.json({ success: true, status: 'recent', result: null })
          : res.json({ success: true, status: 'ok', replies: [], count: 0 });
      }
    } catch { /* invalid URL, rejected below */ }
    try {
      validateExternalUrl(post_ap_id);
    } catch {
      return res.status(400).json({ error: 'Invalid or disallowed post_ap_id' });
    }

    const supabase = getSupabaseClient();
    const target = await readReplyTarget(supabase, post_ap_id);
    const maxReplies = Math.max(1, Math.min(Number(limit) || DEFAULT_REPLY_CRAWL.maxReplies, DEFAULT_REPLY_CRAWL.maxReplies));

    let crawl = inflightReplyCrawls.get(post_ap_id);
    let status: 'started' | 'running' | 'recent' = crawl ? 'running' : 'recent';
    if (!crawl) {
      const now = Date.now();
      const recorded = target?.replies_fetched_at ? Date.parse(target.replies_fetched_at) : NaN;
      const remembered = lastReplyCrawls.get(post_ap_id) ?? NaN;
      const last = Math.max(Number.isFinite(recorded) ? recorded : -Infinity, Number.isFinite(remembered) ? remembered : -Infinity);
      const interval = force === true ? FORCED_REPLY_CRAWL_COOLDOWN_MS : replyCrawlInterval(target?.created_at, now);
      if (now - last >= interval) {
        if (inflightReplyCrawls.size >= MAX_REPLY_CRAWLS) {
          res.setHeader('Retry-After', 5);
          return res.status(503).json({ success: false, status: 'busy', error: 'Too many reply fetches running', retry_after: 5 });
        }
        crawl = startReplyCrawl(post_ap_id, target?.id, supabase, maxReplies, now);
        status = 'started';
      }
    }

    if (!answerEarly) {
      const result = crawl ? await crawl : null;
      const counts = replyTargetCounts(target ? await readReplyTarget(supabase, post_ap_id) : null);
      delete counts.replies_fetched_at;
      if (!result) {
        return res.json({ success: true, status: 'recent', replies: [], count: 0, ...counts });
      }
      return res.json({
        success: true,
        status: result.status === 'unauthorized' ? 'unavailable' : result.status,
        replies: [],
        count: result.stored + result.existing,
        new: result.stored,
        existing: result.existing,
        skipped: result.skipped,
        found: result.found,
        pages: result.pages,
        truncated: result.truncated,
        ...counts,
      });
    }

    if (!crawl) {
      const last = finishedReplyCrawls.get(post_ap_id);
      return res.json({
        success: true,
        status,
        result: last && Date.now() - last.at < REPLY_CRAWL_RESULT_TTL_MS ? replyCrawlBody(last.result) : null,
        ...replyTargetCounts(target),
      });
    }
    const result = await replyCrawlWithin(crawl, REPLY_CRAWL_ANSWER_WAIT_MS);
    if (!result) {
      return res.json({ success: true, status, result: null, ...replyTargetCounts(target) });
    }
    return res.json({
      success: true,
      status: 'done',
      result: replyCrawlBody(result),
      ...replyTargetCounts(target ? await readReplyTarget(supabase, post_ap_id) : null),
    });
  })
);

/**
 * State of the reply crawl of a remote post
 * GET /fetch-replies/status?post_ap_id= (proxied via /api/federation/fetch-replies/status)
 *
 * 'running' while a crawl runs; 'done' with the result of one that ended within
 * REPLY_CRAWL_RESULT_TTL_MS; 'idle' otherwise, which includes a crawl this process did not run.
 * Contacts no remote server.
 */
router.get(
  '/fetch-replies/status',
  repliesStatusLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const postApId = typeof req.query.post_ap_id === 'string' ? req.query.post_ap_id : '';
    if (!postApId) {
      return res.status(400).json({ error: 'post_ap_id is required' });
    }
    const target = urlHost(postApId) ? await readReplyTarget(getSupabaseClient(), postApId) : null;
    const finished = finishedReplyCrawls.get(postApId);
    const fresh = finished && Date.now() - finished.at < REPLY_CRAWL_RESULT_TTL_MS ? finished : undefined;
    const status = inflightReplyCrawls.has(postApId) ? 'running' : fresh ? 'done' : 'idle';
    return res.json({
      success: true,
      status,
      result: status === 'done' && fresh ? replyCrawlBody(fresh.result) : null,
      ...replyTargetCounts(target),
    });
  })
);

/**
 * AP ids of a Misskey note's replies, via its POST /api/notes/children. Quote renotes in the
 * answer are not replies and are left out. Null when the API does not answer.
 */
async function misskeyReplyIds(domain: string, noteId: string, limit: number): Promise<string[] | null> {
  try {
    const response = await safeFetch(`https://${domain}/api/notes/children`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`
      },
      body: JSON.stringify({ noteId, limit: Math.min(limit, 100) }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      logger.warn(`Misskey children API failed: ${response.status}`);
      return null;
    }
    const notes = await response.json();
    if (!Array.isArray(notes)) return null;
    return notes
      .filter((note: any) => note && note.replyId === noteId && typeof note.id === 'string')
      .map((note: any) => (typeof note.uri === 'string' && note.uri ? note.uri : `https://${domain}/notes/${note.id}`))
      .filter((id: string) => urlHost(id) !== null);
  } catch (error) {
    logger.warn(`Misskey children API unreachable: ${error}`);
    return null;
  }
}

/**
 * Replies of a remote post: Misskey's children API for a Misskey note, else the Note's
 * replies collection. Each reply goes through ActivityProcessor.storeRemotePost.
 */
async function fetchRemotePostReplies(
  postApId: string,
  postId: string | undefined,
  supabase: any,
  maxReplies: number,
  readAt: Date,
): Promise<RemoteReplyFetch> {
  const limits = {
    maxPages: DEFAULT_REPLY_CRAWL.maxPages,
    maxReplies,
    deadline: readAt.getTime() + DEFAULT_REPLY_CRAWL.timeoutMs,
  };
  const store = replyStore(supabase);

  // Misskey publishes no replies collection; its children API names them. Its notes/show
  // repliesCount is the post's figure, so the listing sets none.
  if (isMisskeyInstance(postApId)) {
    const noteId = extractMisskeyNoteId(postApId);
    const ids = noteId ? await misskeyReplyIds(new URL(postApId).hostname, noteId, maxReplies) : null;
    if (ids) {
      const counts = await storeReplies(ids.map((id) => ({ id })), store, limits.deadline);
      return { status: 'ok', found: ids.length, pages: 0, ...counts, complete: false, total: null };
    }
    logger.info(`Misskey API returned no replies, trying standard ActivityPub...`);
  }

  // BUGS.md H15: postApId is attacker-influenced; every request goes through safeFetch.
  let noteStatus = 0;
  const note = await fetchAuthoritativeDocument(postApId, (url) => fetchSignedDocument(url, (status) => { noteStatus = status; }));
  if (!note) {
    logger.warn(`Failed to fetch post ${postApId} (${noteStatus || 'no answer'})`);
    return unreadReplies(noteStatus === 401 || noteStatus === 403 ? 'unauthorized' : 'unavailable');
  }

  if (postId) {
    const columns = noteEngagementColumns(note, readAt);
    if (Object.keys(columns).length > 0) {
      await supabase.from('posts').update(columns).eq('id', postId);
    }
  }

  const crawl = await crawlReplies(note, fetchSignedDocument, store, limits);
  logger.info(`Replies of ${postApId}: ${crawl.found} listed over ${crawl.pages} page(s), ${crawl.stored} stored, ${crawl.existing} held, ${crawl.skipped} skipped${crawl.truncated ? ', truncated' : ''}${crawl.complete ? '' : ', incomplete'}`);
  const ownTotal = noteEngagementTotals(note).replies;
  return { ...crawl, total: crawl.status === 'ok' && crawl.complete && ownTotal === null ? crawl.found : null };
}

/**
 * Generate an RSA keypair for a local user that lacks one.
 * POST /generate-keys (proxied via /api/federation/generate-keys)
 * Body: { user_id: uuid }
 *
 * Called during profile creation.
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

    if (profile.public_key) {
      const { data: privateKeyExists } = await supabase
        .from('user_private_keys')
        .select('id')
        .eq('user_id', user_id)
        .maybeSingle();

      if (privateKeyExists) {
        logger.info(`Keys already exist for user ${profile.username}`);
        return res.json({ 
          success: true, 
          message: 'Keys already exist',
          already_exists: true
        });
      }
    }

    logger.info(`Generating keys for user ${profile.username}...`);
    
    try {
      const { SignatureService } = await import('./SignatureService.js');
      const keys = await SignatureService.generateKeyPair();

      // Private key is stored first and deleted again if the public key write fails.
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

      const { error: publicKeyError } = await supabase
        .from('profiles')
        .update({ public_key: keys.publicKey })
        .eq('id', user_id);

      if (publicKeyError) {
        await supabase
          .from('user_private_keys')
          .delete()
          .eq('user_id', user_id);
        
        logger.error(`Failed to store public key for ${profile.username}:`, publicKeyError);
        return res.status(500).json({ error: 'Failed to store public key' });
      }

      logger.info(`Generated keys for user ${profile.username}`);
      
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
 * GET /users/:username - ActivityPub Actor object.
 */
router.get(
  '/users/:username',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const supabase = getSupabaseClient();

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    // A deleted account answers 410 under its old handle and under its tombstone name.
    let deleted: { actor_uri: string; deleted_at: string | null } | null = null;
    if (profile?.deleted_at) {
      deleted = (await deletedActorByProfile(profile.id).catch(() => null)) ?? {
        actor_uri: `https://${config.INSTANCE_DOMAIN}/users/${profile.username}`,
        deleted_at: profile.deleted_at,
      };
    } else if (!profile) {
      deleted = await deletedActorByUsername(username);
    }
    if (deleted) {
      res.status(410);
      res.setHeader('Content-Type', 'application/activity+json');
      res.json(actorTombstone(deleted.actor_uri, deleted.deleted_at));
      return;
    }

    if (error || !profile) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    // Incoming activity lookups key on federated_id; backfill it for local users.
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

    // Keys are generated here when /generate-keys never ran for this profile.
    if (!profile.public_key) {
      logger.info(`Actor ${username} missing keys, generating on-the-fly...`);
      
      try {
        const { SignatureService } = await import('./SignatureService.js');
        const keys = await SignatureService.generateKeyPair();

        // Private key is stored first and deleted again if the public key write fails.
        const { error: privateKeyError } = await supabase
          .from('user_private_keys')
          .upsert({
            user_id: profile.id,
            private_key: keys.privateKey,
          });

        if (!privateKeyError) {
          const { error: publicKeyError } = await supabase
            .from('profiles')
            .update({ public_key: keys.publicKey })
            .eq('id', profile.id);

          if (!publicKeyError) {
            profile.public_key = keys.publicKey;
            logger.info(`Generated keys on-the-fly for ${username}`);
          } else {
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
        // Non-fatal: the Actor response omits publicKey.
      }
    }

    // Shortcodes resolve to Emoji tags so remote instances can render them.
    await resolveLocalProfileEmojis(profile, supabase);

    const actor = profileToActor(profile);

    res.setHeader('Content-Type', 'application/activity+json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(actor);
  })
);

/**
 * GET /users/:username/featured - OrderedCollection of pinned posts, max 10.
 */
router.get(
  '/users/:username/featured',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const supabase = getSupabaseClient();

    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (userError || !user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const featuredUrl = `${baseUrl}/users/${username}/featured`;

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
      res.status(500).json({ error: 'Failed to fetch pinned posts' });
      return;
    }

    const orderedItems = (pinnedPosts || []).map(post => {
      const postUrl = post.ap_id || `${baseUrl}/posts/${post.id}`;
      
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
 * GET /users/:username/followers
 * Query params:
 *   - cursor: id of the last item seen
 *   - page: page number, legacy
 *   - limit: items per page, default 20, max 100
 * Without cursor or page the response is collection metadata only.
 */
router.get(
  '/users/:username/followers',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const page = req.query.page as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const supabase = getSupabaseClient();

    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const collectionUrl = `${baseUrl}/users/${username}/followers`;

    if (!page && !cursor) {
      const { count } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('following_id', user.id)
        .eq('status', 'accepted');

      res.setHeader('Content-Type', 'application/activity+json');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${collectionUrl}?cursor=start&limit=${limit}`,
      });
      return;
    }

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
      .limit(limit + 1); // one extra row signals a further page

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

    // federated_id, else a URL derived from domain and username.
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

    if (hasMore && lastItem?.id) {
      response.next = `${collectionUrl}?cursor=${lastItem.id}&limit=${limit}`;
    }

    res.setHeader('Content-Type', 'application/activity+json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(response);
  })
);

/**
 * GET /users/:username/following
 * Query params:
 *   - cursor: id of the last item seen
 *   - page: page number, legacy
 *   - limit: items per page, default 20, max 100
 * Without cursor or page the response is collection metadata only.
 */
router.get(
  '/users/:username/following',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const page = req.query.page as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const supabase = getSupabaseClient();

    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const collectionUrl = `${baseUrl}/users/${username}/following`;

    if (!page && !cursor) {
      const { count } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('follower_id', user.id)
        .eq('status', 'accepted');

      res.setHeader('Content-Type', 'application/activity+json');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${collectionUrl}?cursor=start&limit=${limit}`,
      });
      return;
    }

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

    // federated_id, else a URL derived from domain and username.
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
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(response);
  })
);

// Outbox pagination state, keyed by author id. Process-local; lost on restart.
const userNextPageCache = new Map<string, string | null>();

// Visited page URLs; a repeat means the remote's `next` chain loops.
const userFetchedUrls = new Map<string, Set<string>>();

const userZeroSaveCount = new Map<string, number>();

const MAX_ZERO_SAVES = 3;

/**
 * Fetch recent posts from a remote user's outbox.
 * Paginates by following the collection's `next` links.
 */
async function fetchRecentPostsInBackground(
  authorId: string, 
  outboxUrl: string, 
  supabase: any,
  maxId?: string, // presence requests the next page; the cached next URL is used
  limit: number = 10
): Promise<{ hasMore: boolean; oldestId?: string; nextPageUrl?: string }> {
  try {
    let fetchUrl: string;
    
    if (maxId) {
      const cachedNextUrl = userNextPageCache.get(authorId);
      if (!cachedNextUrl) {
        logger.info(`No cached next page for user ${authorId}, fetching first page`);
        fetchUrl = outboxUrl;
        userFetchedUrls.delete(authorId);
        userZeroSaveCount.delete(authorId);
      } else {
        fetchUrl = cachedNextUrl;
        logger.info(`Using cached next page: ${fetchUrl}`);
      }
    } else {
      // Initial fetch resets all pagination state.
      fetchUrl = outboxUrl;
      userNextPageCache.delete(authorId);
      userFetchedUrls.delete(authorId);
      userZeroSaveCount.delete(authorId);
    }
    
    const fetchedUrls = userFetchedUrls.get(authorId) || new Set<string>();
    if (fetchedUrls.has(fetchUrl)) {
      logger.info(`Loop detected - already fetched ${fetchUrl}, stopping pagination`);
      userNextPageCache.delete(authorId);
      userFetchedUrls.delete(authorId);
      userZeroSaveCount.delete(authorId);
      return { hasMore: false };
    }
    
    fetchedUrls.add(fetchUrl);
    userFetchedUrls.set(authorId, fetchedUrls);
    
    logger.info(`Fetching posts from: ${fetchUrl}`);
    
    const outboxResponse = await SignatureService.signedApFetch(fetchUrl, {
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
    
    let items: any[] = [];
    let nextPageUrl: string | null = null;
    
    if (outbox.orderedItems && Array.isArray(outbox.orderedItems)) {
      // Response is already a page.
      items = outbox.orderedItems.slice(0, limit);
      nextPageUrl = typeof outbox.next === 'string' ? outbox.next : outbox.next?.id || null;
    } else if (outbox.first) {
      // Response is a collection; its first page holds the items.
      const firstPageUrl = typeof outbox.first === 'string' ? outbox.first : outbox.first.id;
      logger.info(`Fetching first page: ${firstPageUrl}`);
      
      const pageResponse = await SignatureService.signedApFetch(firstPageUrl, {
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
    
    if (nextPageUrl) {
      userNextPageCache.set(authorId, nextPageUrl);
      logger.info(`Cached next page URL: ${nextPageUrl}`);
    } else {
      userNextPageCache.delete(authorId);
      logger.info(`No more pages available`);
    }
    
    if (items.length === 0) {
      logger.info(`No posts found in outbox`);
      return { hasMore: false };
    }
    
    logger.info(`Processing ${items.length} posts from outbox`);
    
    let savedCount = 0;
    let oldestId: string | undefined;
    
    const { noteToContent } = await import('./converters/fromActivityPub.js');
    
    for (const item of items) {
      try {
        const activityType = item.type;
        
        // Outbox entries are the actor's own activities, on the outbox host.
        if (activityType === 'Announce') {
          oldestId = item.id;
          if (!sameOrigin(item.id, outboxUrl)) continue;

          const { data: existingReblog } = await supabase
            .from('posts')
            .select('id')
            .eq('ap_id', item.id)
            .maybeSingle();
          
          if (existingReblog) {
            continue;
          }
          
          const originalUrl = typeof item.object === 'string' ? item.object : item.object?.id;
          if (!originalUrl) continue;
          
          // Full row is needed to embed the reblog JSON; absent when the original is unknown.
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
            logger.debug(`Saved reblog of ${originalUrl}`);
          }
          continue;
        }
        
        // Outboxes contain Create wrappers or bare objects.
        const note = activityType === 'Create' ? item.object : item;
        
        // Question is a poll and is kept.
        if (!note || (note.type !== 'Note' && note.type !== 'Article' && note.type !== 'Question')) {
          continue;
        }
        if (!sameOrigin(note.id, outboxUrl)) {
          continue;
        }
        
        oldestId = note.id;
        
        const { data: existing } = await supabase
          .from('posts')
          .select('id')
          .eq('ap_id', note.id)
          .maybeSingle();
        
        if (existing) {
          continue;
        }
        
        // noteToContent resolves mentions, hashtags, emoji and attachments.
        const content = noteToContent(note);
        
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
        
        const mediaAttachments = extractMediaAttachments(note.attachment);
        
        const metadata: any = {};
        
        if (note.type === 'Question') {
          Object.assign(metadata, questionPollMetadata(note));
        }
        
        // Quote target: Mastodon quoteUrl/quoteUri, Misskey _misskey_quote.
        const quoteUrl = note.quoteUrl || note.quoteUri || note._misskey_quote;
        if (quoteUrl) {
          metadata.is_quote = true;
          metadata.quote_url = quoteUrl;
          logger.debug(`Found quote post referencing: ${quoteUrl}`);
        }
        
        const customEmojis = extractCustomEmojis(note.tag);
        if (customEmojis.length > 0) {
          metadata.custom_emojis = customEmojis;
        }
        
        let inReplyToId: string | null = null;
        if (note.inReplyTo) {
          metadata.in_reply_to_ap_url = note.inReplyTo;
          
          const { data: parentPost } = await supabase
            .from('posts')
            .select('id')
            .eq('ap_id', note.inReplyTo)
            .maybeSingle();
          
          if (parentPost) {
            inReplyToId = parentPost.id;
          }
        }
        
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
          ...noteEngagementColumns(note),
        };
        
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
    
    logger.info(`Saved ${savedCount} new posts from remote user`);
    
    await supabase
      .from('profiles')
      .update({ last_federation_sync: new Date().toISOString() })
      .eq('id', authorId);
    
    // MAX_ZERO_SAVES consecutive fetches yielding nothing new end pagination.
    if (savedCount === 0) {
      const zeroCount = (userZeroSaveCount.get(authorId) || 0) + 1;
      userZeroSaveCount.set(authorId, zeroCount);
      
      if (zeroCount >= MAX_ZERO_SAVES) {
        logger.info(`${MAX_ZERO_SAVES} consecutive fetches with 0 new posts, stopping pagination`);
        userNextPageCache.delete(authorId);
        userFetchedUrls.delete(authorId);
        userZeroSaveCount.delete(authorId);
        return { hasMore: false };
      }
      
      logger.info(`Zero new posts (${zeroCount}/${MAX_ZERO_SAVES} before giving up)`);
    } else {
      userZeroSaveCount.delete(authorId);
    }
    
    const hasMore = !!nextPageUrl;
    
    logger.info(`Result: saved ${savedCount} new posts, has_more=${hasMore}`);
    
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

const outboxBackfills = new Set<string>();

/** Starts the first-page outbox import of an author unless one is running; true when started. */
function startOutboxBackfill(authorId: string, outboxUrl: string, supabase: any, label: string): boolean {
  if (outboxBackfills.has(authorId)) return false;
  outboxBackfills.add(authorId);
  logger.info(`Triggering background post fetch for ${label}`);
  fetchRecentPostsInBackground(authorId, outboxUrl, supabase)
    .catch((err) => logger.warn(`Background post fetch failed for ${label}:`, err.message))
    .finally(() => outboxBackfills.delete(authorId));
  return true;
}

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
    focalPoint: parseFocalPoint(att.focalPoint),
  })).filter((att: any) => att.url);
}

/**
 * Refetch a remote post from its origin, reprocessing content and link previews.
 * POST /refetch-post
 * Body: { post_id: string }
 * Requires an authenticated admin or moderator.
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
      const response = await SignatureService.signedApFetch(post.ap_id, {
        headers: { 'Accept': 'application/activity+json, application/ld+json' },
      });

      if (!response.ok) {
        return res.status(502).json({ error: `Remote server returned ${response.status}` });
      }

      let remoteObject = await response.json();

      // Announce (reblog) wraps the Note; follow object to reach it.
      if (remoteObject.type === 'Announce') {
        const objectUrl = typeof remoteObject.object === 'string'
          ? remoteObject.object
          : remoteObject.object?.id;
        if (!objectUrl) {
          return res.status(400).json({ error: 'Announce has no object URL to follow' });
        }
        const noteResponse = await SignatureService.signedApFetch(objectUrl, {
          headers: { 'Accept': 'application/activity+json, application/ld+json' },
        });
        if (!noteResponse.ok) {
          return res.status(502).json({ error: `Remote server returned ${noteResponse.status} for announced object` });
        }
        remoteObject = await noteResponse.json();
      }

      if (remoteObject.type !== 'Note' && remoteObject.type !== 'Article') {
        return res.status(400).json({ error: `Remote object is type "${remoteObject.type}", expected Note or Article` });
      }

      const content = noteToContent(remoteObject);

      const updatePayload: any = { content, ...noteEngagementColumns(remoteObject) };
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

      logger.info(`Admin refetched post ${post_id} from ${post.ap_id}`);

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

