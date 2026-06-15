import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import {
  actorToProfile,
  noteToContent,
  extractFollowData,
  extractLikeData,
  extractAnnounceData,
  extractDeleteData,
  normalizeActor,
} from './converters/fromActivityPub.js';
import { VoiceActivityHandler } from './VoiceActivityHandler.js';
import { SignatureService } from './SignatureService.js';
import config from '../config/index.js';
import { harmonyVoiceMessageFromObject } from '../utils/voiceMessageFederation.js';
import { safeFetch } from '../utils/ssrfProtection.js';
import { isDefaultServerIcon } from '../utils/urlUtils.js';

/**
 * Extract message UUID from a URL like https://domain/messages/{uuid}
 */
export function extractMessageId(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/messages\/([a-f0-9-]{36})/);
  return match ? match[1] : null;
}

/**
 * Determine post visibility from ActivityPub 'to' and 'cc' fields.
 * Exported for direct testing.
 */
export function determineVisibility(object: any): string {
  const to = Array.isArray(object.to) ? object.to : [object.to].filter(Boolean);
  const cc = Array.isArray(object.cc) ? object.cc : [object.cc].filter(Boolean);

  const publicUrl = 'https://www.w3.org/ns/activitystreams#Public';

  if (to.includes(publicUrl)) return 'public';
  if (cc.includes(publicUrl)) return 'unlisted';

  const allRecipients = [...to, ...cc];
  const hasFollowersCollection = allRecipients.some(
    (url: any) => typeof url === 'string' && url.includes('/followers')
  );

  if (!hasFollowersCollection && allRecipients.length > 0) return 'direct';
  if (hasFollowersCollection) return 'followers';
  return 'unlisted';
}

/**
 * Resolve an actor URL to a profile ID.
 * Tries federated_id first; falls back to extracting username from
 * our own domain's URL pattern (handles local users whose federated_id
 * was never set).
 */
async function resolveProfileByActorUrl(actorUrl: string): Promise<{ id: string } | null> {
  const supabase = getSupabaseClient();

  // 1) Direct federated_id lookup
  const { data: byFedId } = await supabase
    .from('profiles')
    .select('id')
    .eq('federated_id', actorUrl)
    .maybeSingle();
  if (byFedId) return byFedId;

  // 2) Fallback: if the URL matches our domain, extract username
  const localPattern = new RegExp(
    `^https?://${config.INSTANCE_DOMAIN.replace(/\./g, '\\.')}/users/([^/]+)$`,
    'i'
  );
  const match = actorUrl.match(localPattern);
  if (match) {
    const username = match[1];
    const { data: byUsername } = await supabase
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .eq('is_local', true)
      .maybeSingle();
    if (byUsername) {
      // Backfill federated_id so future lookups are fast
      await supabase
        .from('profiles')
        .update({
          federated_id: `https://${config.INSTANCE_DOMAIN}/users/${username}`,
          inbox_url: `https://${config.INSTANCE_DOMAIN}/users/${username}/inbox`,
          outbox_url: `https://${config.INSTANCE_DOMAIN}/users/${username}/outbox`,
          followers_url: `https://${config.INSTANCE_DOMAIN}/users/${username}/followers`,
          following_url: `https://${config.INSTANCE_DOMAIN}/users/${username}/following`,
          shared_inbox_url: `https://${config.INSTANCE_DOMAIN}/inbox`,
        })
        .eq('id', byUsername.id);
      logger.info(`Backfilled federated_id for local user ${username}`);
      return byUsername;
    }
  }

  return null;
}

export class ActivityProcessor {
  /**
   * Maximum reply-chain depth for federated post resolution. Bounds total
   * outbound fetches per `/resolve-post` call (and per inbox Create) so a
   * malicious or pathological remote can't chain the importer into a deep
   * cascade of remote requests. Shared between `resolveReplyChain` (chain
   * walker) and `fetchAndCreateRemotePost` (per-post fetcher) so the mutual
   * recursion lands at exactly N fetches total, not 2N or N+1.
   */
  private static readonly MAX_REPLY_CHAIN_DEPTH = 10;

  /**
   * Check if an actor is suspended on our instance
   */
  private static async isActorSuspended(actorUrl: string): Promise<boolean> {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('profiles')
      .select('is_suspended')
      .eq('federated_id', actorUrl)
      .maybeSingle();
    
    return data?.is_suspended === true;
  }

  /**
   * Process incoming ActivityPub activity
   */
  static async processIncomingActivity(activity: any): Promise<void> {
    // Check if actor is suspended on our instance
    const actorUrl = normalizeActor(activity.actor);
    if (actorUrl && await this.isActorSuspended(actorUrl)) {
      logger.info(`🚫 Ignoring activity from suspended user: ${actorUrl}`);
      return;
    }

    switch (activity.type) {
      case 'Follow':
        await this.processFollow(activity);
        break;
      case 'Accept':
        await this.processAccept(activity);
        break;
      case 'Reject':
        await this.processReject(activity);
        break;
      case 'Create':
        await this.processCreate(activity);
        break;
      case 'Update':
        await this.processUpdate(activity);
        break;
      case 'Delete':
        await this.processDelete(activity);
        break;
      case 'Like':
      case 'EmojiReaction':
      case 'EmojiReact': // Some instances use EmojiReact instead of EmojiReaction
        await this.processLike(activity);
        break;
      case 'Announce':
        await this.processAnnounce(activity);
        break;
      case 'Undo':
        await this.processUndo(activity);
        break;
      case 'Add':
        await this.processAdd(activity);
        break;
      case 'Remove':
        await this.processRemove(activity);
        break;
      case 'Flag':
        await this.processFlag(activity);
        break;
      case 'Block':
        await this.processBlock(activity);
        break;
      default:
        // Check for Harmony voice activities
        if (VoiceActivityHandler.isVoiceActivity(activity)) {
          await VoiceActivityHandler.processVoiceActivity(activity);
        } else {
          logger.info(`Unhandled activity type: ${activity.type}`);
        }
    }
  }

  /**
   * Process Follow activity
   */
  private static async processFollow(activity: any): Promise<void> {
    const { followerUrl, followingUrl } = extractFollowData(activity);
    const supabase = getSupabaseClient();

    // Ensure remote user exists
    await this.ensureRemoteUser(followerUrl);

    // Get follower and following IDs (resolveProfileByActorUrl handles local users without federated_id)
    const follower = await resolveProfileByActorUrl(followerUrl);
    const following = await resolveProfileByActorUrl(followingUrl);

    if (!follower || !following) {
      logger.error(`Failed to find users for follow relationship: follower=${!!follower}, following=${!!following} (${followerUrl} → ${followingUrl})`);
      return;
    }

    // Create follow relationship (auto-accept)
    const { error: followError } = await supabase.from('follows').upsert({
      follower_id: follower.id,
      following_id: following.id,
      status: 'accepted',
      ap_id: activity.id,
      is_local: false,
      accepted_at: new Date().toISOString()
    }, {
      onConflict: 'follower_id,following_id'
    }).select();

    if (followError) {
      logger.error('Failed to create follow relationship:', followError);
      return;
    }

    logger.info(`Follow created and auto-accepted: ${followerUrl} → ${followingUrl}`);

    // Send Accept activity back to follower
    const { data: followingUser } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', following.id)
      .single();
    
    if (followingUser && followingUser.is_local) {
      const { createAcceptActivity } = await import('./converters/toActivityPub.js');
      const { DeliveryQueue } = await import('./DeliveryQueue.js');
      
      const acceptActivity = createAcceptActivity(followingUser, activity);
      
      // Get follower's inbox
      const { data: followerUser } = await supabase
        .from('profiles')
        .select('inbox_url')
        .eq('id', follower.id)
        .single();
      
      if (followerUser?.inbox_url) {
        await DeliveryQueue.sendToInbox(followerUser.inbox_url, acceptActivity, followingUser.id);
        logger.info(`✅ Sent Accept activity to ${followerUrl}`);
      }
    }
  }

  /**
   * Process Accept activity
   */
  private static async processAccept(activity: any): Promise<void> {
    const supabase = getSupabaseClient();

    if (!activity.object) return;

    if (activity.object.type === 'Follow') {
      await supabase
        .from('follows')
        .update({ status: 'accepted' })
        .eq('ap_activity_id', activity.object.id);

      logger.info(`Follow accepted: ${activity.object.id}`);
    } else if (activity.object.type === 'Join') {
      const serverApId = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
      const userActorUrl = typeof activity.object.actor === 'string'
        ? activity.object.actor
        : activity.object.actor?.id;

      if (!serverApId || !userActorUrl) {
        logger.warn('Accept(Join): missing server or user actor URL');
        return;
      }

      const { data: server } = await supabase
        .from('servers')
        .select('id')
        .eq('ap_id', serverApId)
        .maybeSingle();

      if (!server) {
        logger.warn(`Accept(Join): no local server reference for ${serverApId}`);
        return;
      }

      const userProfile = await resolveProfileByActorUrl(userActorUrl);
      if (!userProfile) {
        logger.warn(`Accept(Join): could not resolve user ${userActorUrl}`);
        return;
      }

      const { error } = await supabase
        .from('user_servers')
        .update({ status: 'accepted' })
        .eq('server_id', server.id)
        .eq('user_id', userProfile.id);

      if (error) {
        logger.error('Accept(Join): failed to update membership:', error);
      } else {
        logger.info(`✅ Join accepted for user ${userProfile.id} in server ${server.id}`);
      }
    }
  }

  /**
   * Process Reject activity
   */
  private static async processReject(activity: any): Promise<void> {
    const supabase = getSupabaseClient();

    if (!activity.object) return;

    if (activity.object.type === 'Follow') {
      await supabase
        .from('follows')
        .delete()
        .eq('ap_activity_id', activity.object.id);

      logger.info(`Follow rejected: ${activity.object.id}`);
    } else if (activity.object.type === 'Join') {
      const serverApId = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
      const userActorUrl = typeof activity.object.actor === 'string'
        ? activity.object.actor
        : activity.object.actor?.id;

      if (!serverApId || !userActorUrl) {
        logger.warn('Reject(Join): missing server or user actor URL');
        return;
      }

      const { data: server } = await supabase
        .from('servers')
        .select('id')
        .eq('ap_id', serverApId)
        .maybeSingle();

      if (!server) {
        logger.warn(`Reject(Join): no local server reference for ${serverApId}`);
        return;
      }

      const userProfile = await resolveProfileByActorUrl(userActorUrl);
      if (!userProfile) {
        logger.warn(`Reject(Join): could not resolve user ${userActorUrl}`);
        return;
      }

      const { error } = await supabase
        .from('user_servers')
        .delete()
        .eq('server_id', server.id)
        .eq('user_id', userProfile.id);

      if (error) {
        logger.error('Reject(Join): failed to remove membership:', error);
      } else {
        logger.info(`❌ Join rejected for user ${userProfile.id} in server ${server.id}`);
      }
    }
  }

  /**
   * Process Create activity (new post/message/poll)
   */
  private static async processCreate(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();

    logger.info(`📨 processCreate: object.type=${object?.type}, id=${object?.id?.substring?.(0, 80)}`);

    // Handle Question type (polls) - store as Note with poll metadata
    if (object.type === 'Question') {
      logger.info(`📊 Processing poll: ${object.id}`);
      await this.processCreatePoll(activity, object);
      return;
    }

    // Handle ChatThread - federated thread creation
    if (object.type === 'ChatThread') {
      logger.info(`📋 Routing Create ChatThread to handler: ${object.id}`);
      const { handleThreadActivity } = await import('./ThreadActivityHandler.js');
      const result = await handleThreadActivity({ ...activity, object });
      if (!result.success) {
        logger.warn(`Thread Create failed: ${result.error}`);
      }
      return;
    }

    if (object.type === 'Note' || object.type === 'Article') {
      // Reject our own posts echoed back (federation round-trip)
      const ownDomain = config.INSTANCE_DOMAIN;
      if (object.id && typeof object.id === 'string') {
        try {
          const objectHost = new URL(object.id).hostname;
          if (objectHost === ownDomain) {
            logger.info(`⏭️ Ignoring own post echoed back: ${object.id}`);
            return;
          }
        } catch { /* not a valid URL, continue */ }
      }

      // Check if this is a Harmony channel message (not a regular ActivityPub post)
      const harmonyServerId = object['harmony:serverId'];
      const harmonyChannelName = object['harmony:channelName'];
      
      if (harmonyServerId) {
        // This is a channel message - route to ServerInboxHandler
        logger.info(`📨 Detected channel message for server ${harmonyServerId}, channel: ${harmonyChannelName}`);
        await this.processChannelMessage(activity, object);
        return;
      }

      // Ensure author exists
      await this.ensureRemoteUser(normalizeActor(activity.actor));

      // Get author ID
      const author = await resolveProfileByActorUrl(normalizeActor(activity.actor));

      if (!author) {
        logger.error('Failed to find author for post');
        return;
      }

      // Convert content (returns raw HTML for now)
      const rawContent = noteToContent(object);
      
      // Check for quote post (quoteUrl for Fediverse, _misskey_quote for Misskey)
      const quoteUrl = object.quoteUrl || object._misskey_quote;
      
      logger.info('📝 Processing ActivityPub Note: ' + JSON.stringify({
        id: object.id,
        inReplyTo: object.inReplyTo,
        quoteUrl: quoteUrl,
        contentPreview: object.content?.substring(0, 100)
      }));
      
      const content = rawContent;

      // Determine visibility
      const visibility = this.determineVisibility(object);

      // Route group invite notifications (sent when remote user is added to group)
      if (object.metadata?.type === 'group_invite') {
        await this.handleGroupInvite(object, author.id);
        return;
      }

      // Route direct messages to messages table, everything else to posts
      if (visibility === 'direct' || visibility === 'private') {
        await this.handleDirectMessage(object, author.id, content);
      } else {
        // Handle reply threading - fetch parent posts if missing and find conversation root
        let parentPostId: string | null = null;
        let conversationRootId: string | null = null;

        if (object.inReplyTo) {
          const replyResult = await this.resolveReplyChain(object.inReplyTo);
          parentPostId = replyResult.parentPostId;
          conversationRootId = replyResult.conversationRootId;
        }

        // Handle quote posts - fetch/create the quoted post and store reference
        let quotedPostData: any = null;
        if (quoteUrl) {
          logger.info(`📝 Processing quote post, quoted URL: ${quoteUrl}`);
          quotedPostData = await this.resolveQuotedPost(quoteUrl);
        }

        // Build metadata object
        const metadata: any = {};
        if (object.inReplyTo) {
          metadata.in_reply_to_ap_url = object.inReplyTo;
        }
        if (quotedPostData) {
          metadata.is_quote = true;
          metadata.reblog_of = quotedPostData.id;
          metadata.quote_ap_url = quoteUrl;
        }

        // Create post with proper reply threading and quote support
        // in_reply_to is a UUID column for the parent post ID
        const postData: any = {
          ap_id: object.id,
          author_id: author.id,
          content,
          visibility,
          is_local: false,
          in_reply_to: parentPostId,
          conversation_root_id: conversationRootId,
          created_at: object.published || new Date().toISOString(),
          metadata,
          content_warning: object.summary || null,
          is_sensitive: object.sensitive === true,
          replies_count: object.replies?.totalItems || object.repliesCount || 0,
          favorites_count: object.likes?.totalItems || object.favouritesCount || 0,
          reblogs_count: object.shares?.totalItems || object.sharesCount || 0,
        };

        // Add reblog data for quote posts (for display purposes)
        if (quotedPostData) {
          postData.reblog = {
            id: quotedPostData.id,
            content: quotedPostData.content,
            created_at: quotedPostData.created_at,
            visibility: quotedPostData.visibility,
          };
          
          // Get quoted post author for reblog_author field
          const { data: quotedAuthor } = await supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url, domain, is_local')
            .eq('id', quotedPostData.author_id)
            .single();
          
          if (quotedAuthor) {
            postData.reblog_author = quotedAuthor;
          }
        }

        // Deduplicate: a post may arrive multiple times (direct + follower delivery)
        const { data: existingPost } = await supabase
          .from('posts')
          .select('id')
          .eq('ap_id', object.id)
          .maybeSingle();

        if (existingPost) {
          logger.info(`⏭️ Post already exists for ${object.id}, skipping duplicate`);
          return;
        }

        const { data: insertedPost, error } = await supabase.from('posts').insert(postData).select('id, author_id, content, metadata, conversation_root_id').single();

        if (error) {
          logger.error('Failed to create post from activity:', error);
        } else {
          const postType = quotedPostData ? 'quote post' : 'post';
          logger.info(`✅ Created ${postType} from ${object.id}${parentPostId ? ` (reply to ${parentPostId})` : ''}${quotedPostData ? ` (quoting ${quotedPostData.id})` : ''}`);

          if (insertedPost) {
            // Heal any orphan replies that were waiting on this post (children
            // that arrived before their parent and got stamped with
            // metadata.in_reply_to_ap_url = object.id). Pass `object.url`
            // too so orphans stamped with the alternate URL form match.
            await this.relinkPendingChildren(
              object.id,
              insertedPost.id,
              (insertedPost as any).conversation_root_id ?? null,
              object.url || null,
            );

            const { enrichPostLinkPreviews } = await import('../listeners/DatabaseListener.js');
            const insertedPostAny = insertedPost as any;
            enrichPostLinkPreviews(insertedPostAny)
              .then(async (wrote: boolean) => {
                if (!wrote) return;
                await supabase.rpc('broadcast_user_event', {
                  p_user_id: insertedPostAny.author_id,
                  p_payload: { type: 'post:embeds_ready', post_id: insertedPostAny.id },
                });
              })
              .catch((err: any) =>
                logger.warn('Link preview enrichment failed for federated post:', err)
              );
          }
        }
      }
    }
  }

  /**
   * Resolve a quoted post - fetch if not local
   */
  private static async resolveQuotedPost(quoteUrl: string): Promise<any | null> {
    const supabase = getSupabaseClient();

    // First check if quoted post exists locally by ap_id
    const { data: existingPost } = await supabase
      .from('posts')
      .select('id, content, created_at, visibility, author_id')
      .eq('ap_id', quoteUrl)
      .maybeSingle();

    if (existingPost) {
      logger.info(`📝 Found quoted post locally: ${existingPost.id}`);
      return existingPost;
    }

    // Try extracting UUID from URL (for local posts)
    if (quoteUrl.includes('/posts/')) {
      const uuidMatch = quoteUrl.match(/\/posts\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const { data: postById } = await supabase
          .from('posts')
          .select('id, content, created_at, visibility, author_id')
          .eq('id', uuidMatch[1])
          .maybeSingle();
        
        if (postById) {
          logger.info(`📝 Found quoted post by UUID: ${postById.id}`);
          return postById;
        }
      }
    }

    // Fetch the quoted post from remote
    logger.info(`📝 Fetching quoted post from remote: ${quoteUrl}`);
    const fetchedPost = await this.fetchAndCreateRemotePost(quoteUrl);
    
    if (fetchedPost) {
      logger.info(`📝 Created quoted post from remote: ${fetchedPost.id}`);
    }
    
    return fetchedPost;
  }

  /**
   * Resolve reply chain - fetch missing parent posts and find conversation root
   * Returns the parent post ID and conversation root ID
   */
  private static async resolveReplyChain(inReplyToRef: string, depth = 0): Promise<{
    parentPostId: string | null;
    conversationRootId: string | null;
  }> {
    const supabase = getSupabaseClient();

    // Use `>=` (not `>`) so the bound matches the intuitive "max N fetches".
    // Combined with the matching guard in `fetchAndCreateRemotePost`, mutual
    // recursion stops at exactly MAX_REPLY_CHAIN_DEPTH outbound fetches.
    if (depth >= this.MAX_REPLY_CHAIN_DEPTH) {
      logger.warn(`Reply chain too deep (>=${this.MAX_REPLY_CHAIN_DEPTH}), stopping resolution`);
      return { parentPostId: null, conversationRootId: null };
    }

    let parentPost = null;
    const isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(inReplyToRef);

    if (isUuid) {
      // Direct UUID lookup (from DB in_reply_to column during recursion)
      const { data: postById } = await supabase
        .from('posts')
        .select('id, in_reply_to, conversation_root_id')
        .eq('id', inReplyToRef)
        .maybeSingle();
      parentPost = postById;
    } else {
      // URL-based lookup: try ap_id first
      const { data: postByApId } = await supabase
        .from('posts')
        .select('id, in_reply_to, conversation_root_id')
        .eq('ap_id', inReplyToRef)
        .maybeSingle();

      parentPost = postByApId;

      // Try extracting UUID from URL
      if (!parentPost && inReplyToRef.includes('/posts/')) {
        const uuidMatch = inReplyToRef.match(/\/posts\/([a-f0-9-]{36})/);
        if (uuidMatch) {
          const { data: postById } = await supabase
            .from('posts')
            .select('id, in_reply_to, conversation_root_id')
            .eq('id', uuidMatch[1])
            .maybeSingle();
          parentPost = postById;
        }
      }

      // Fetch from remote if not found locally. Forward depth so the inner
      // chain walk done by fetchAndCreateRemotePost shares the same depth
      // budget (otherwise mutual recursion could exceed MAX_DEPTH).
      if (!parentPost) {
        logger.info(`🔍 Parent post not found locally, fetching: ${inReplyToRef}`);
        parentPost = await this.fetchAndCreateRemotePost(inReplyToRef, depth + 1);
      }
    }

    if (!parentPost) {
      logger.warn(`Could not resolve parent post: ${inReplyToRef}`);
      return { parentPostId: null, conversationRootId: null };
    }

    if (parentPost.conversation_root_id) {
      return {
        parentPostId: parentPost.id,
        conversationRootId: parentPost.conversation_root_id
      };
    }

    if (!parentPost.in_reply_to) {
      return {
        parentPostId: parentPost.id,
        conversationRootId: parentPost.id
      };
    }

    // Parent is also a reply - in_reply_to is always a UUID (DB column), recurse
    const parentResult = await this.resolveReplyChain(parentPost.in_reply_to, depth + 1);
    
    // Update the parent post with its conversation_root_id if we found it
    if (parentResult.conversationRootId && !parentPost.conversation_root_id) {
      await supabase
        .from('posts')
        .update({ conversation_root_id: parentResult.conversationRootId })
        .eq('id', parentPost.id);
    }

    return {
      parentPostId: parentPost.id,
      conversationRootId: parentResult.conversationRootId || parentPost.id
    };
  }

  /**
   * Re-link orphan replies whose `metadata.in_reply_to_ap_url` matches the
   * given parent ap_id but whose `in_reply_to` foreign key is still NULL.
   *
   * This happens when a child reply arrives (via inbox or /resolve-post)
   * before its parent - we stamp `metadata.in_reply_to_ap_url` so the link
   * isn't lost, but the child stays orphaned in the thread RPC until the
   * parent shows up. Calling this every time we import or look up a post
   * means the thread "self-heals" as soon as the parent arrives.
   */
  private static async relinkPendingChildren(
    parentApId: string,
    parentLocalId: string,
    parentConversationRootId: string | null,
    parentApUrl?: string | null,
  ): Promise<void> {
    if (!parentLocalId) return;
    const supabase = getSupabaseClient();

    // Match orphans by *every* known URL form for this post - Mastodon
    // canonical id (`/users/x/statuses/N`), pretty url (`/@x/N`), GoToSocial
    // (`/users/x/statuses/N` ↔ `/@x/statuses/N`), Pleroma `/objects/UUID`,
    // etc. all surface in different `inReplyTo` payloads, and an orphan
    // could have stamped any of them. PostgREST `.or()` syntax lets us OR
    // multiple jsonb-arrow-extracted comparisons in a single query.
    const candidateUrls = Array.from(
      new Set(
        [parentApId, parentApUrl ?? undefined].filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        ),
      ),
    );
    if (candidateUrls.length === 0) return;

    const orFilter = candidateUrls
      .map((u) => `metadata->>in_reply_to_ap_url.eq.${u}`)
      .join(',');

    const { data: orphans, error: queryError } = await supabase
      .from('posts')
      .select('id')
      .is('in_reply_to', null)
      .or(orFilter)
      .eq('is_deleted', false);

    if (queryError) {
      logger.warn(`Orphan reply lookup failed for ${parentApId}:`, queryError);
      return;
    }
    if (!orphans || orphans.length === 0) return;

    // The conversation root: prefer the parent's root if known, else the
    // parent itself (matches `resolveReplyChain`'s convention).
    const conversationRootId = parentConversationRootId || parentLocalId;
    const orphanIds = orphans.map((o: { id: string }) => o.id);

    const { error: updateError } = await supabase
      .from('posts')
      .update({
        in_reply_to: parentLocalId,
        conversation_root_id: conversationRootId,
      })
      .in('id', orphanIds);

    if (updateError) {
      logger.warn(`Failed to re-link ${orphans.length} orphan(s) → ${parentLocalId}:`, updateError);
      return;
    }
    logger.info(`🔗 Re-linked ${orphans.length} orphan reply(s) → parent ${parentLocalId} (${parentApId})`);
  }

  /**
   * Fetch a remote post and create it locally.
   *
   * If the post is a reply, the parent chain is walked recursively (sharing
   * the depth budget with `resolveReplyChain`) so the imported post lands
   * with `in_reply_to` and `conversation_root_id` populated, and any missing
   * ancestors are imported alongside it. Without this, calling /resolve-post
   * for a federated reply leaves it as a floating post - the local thread
   * RPC then has nothing to walk and the user sees no context.
   *
   * Whether the post was freshly imported or already cached, we also re-link
   * any orphaned local replies whose `metadata.in_reply_to_ap_url` points at
   * this post's ap_id (children that arrived before their parent).
   */
  public static async fetchAndCreateRemotePost(postUrl: string, depth = 0): Promise<{
    id: string;
    in_reply_to: string | null;
    conversation_root_id: string | null;
  } | null> {
    // Hard cap on outbound fetches per chain. Without this guard, mutual
    // recursion through `resolveReplyChain` could overshoot the depth budget
    // by one (resolveReplyChain checks then calls fetchAndCreateRemotePost
    // which calls resolveReplyChain again at depth+1, allowing one extra
    // fetch beyond the intended max).
    if (depth >= this.MAX_REPLY_CHAIN_DEPTH) {
      logger.warn(`Reply chain fetch too deep (>=${this.MAX_REPLY_CHAIN_DEPTH}), aborting fetch for ${postUrl}`);
      return null;
    }

    const supabase = getSupabaseClient();

    try {
      // Check if a post with this URL already exists (by ap_id or url)
      // before doing any network requests
      const { data: existing } = await supabase
        .from('posts')
        .select('id, ap_id, url, in_reply_to, conversation_root_id')
        .or(`ap_id.eq.${postUrl},url.eq.${postUrl}`)
        .eq('is_deleted', false)
        .limit(1)
        .maybeSingle();

      if (existing) {
        logger.info(`⏭️ Post already exists for ${postUrl} → ${existing.id}, skipping fetch`);
        // Heal any orphan replies that arrived before this post got stored.
        // Pass both the canonical ap_id AND the alternate url so an orphan
        // stamped with either form gets matched.
        await this.relinkPendingChildren(
          existing.ap_id || postUrl,
          existing.id,
          existing.conversation_root_id,
          existing.url || postUrl,
        );
        return {
          id: existing.id,
          in_reply_to: existing.in_reply_to,
          conversation_root_id: existing.conversation_root_id,
        };
      }

      // BUGS.md H15: postUrl comes from inbox-supplied AP objects (attacker-
      // influenced). safeFetch validates URL+DNS per hop, follows manual
      // redirects with re-validation, and bounds the attempt with a 10s
      // timeout.
      let response = await safeFetch(postUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      // Retry with HTTP signature for instances requiring authorized fetch.
      // signedApFetch now also routes through safeFetch internally.
      if (response.status === 401 || response.status === 403) {
        logger.debug(`AP fetch got ${response.status}, retrying with HTTP signature: ${postUrl}`);
        response = await SignatureService.signedApFetch(postUrl);
      }

      if (!response.ok) {
        logger.warn(`Failed to fetch remote post ${postUrl}: ${response.status}`);
        return null;
      }

      const remoteObject = await response.json();

      // Only handle Note/Article types
      if (remoteObject.type !== 'Note' && remoteObject.type !== 'Article') {
        logger.warn(`Remote object is not a Note/Article: ${remoteObject.type}`);
        return null;
      }

      // Deduplicate by the canonical AP id (may differ from the URL we fetched)
      const apId = remoteObject.id;
      const apUrl = remoteObject.url || apId;
      if (apId !== postUrl || apUrl !== postUrl) {
        const { data: existingByApId } = await supabase
          .from('posts')
          .select('id, in_reply_to, conversation_root_id')
          .or(`ap_id.eq.${apId},url.eq.${apUrl}`)
          .eq('is_deleted', false)
          .limit(1)
          .maybeSingle();

        if (existingByApId) {
          logger.info(`⏭️ Post already exists for AP id ${apId} → ${existingByApId.id}, skipping create`);
          await this.relinkPendingChildren(
            apId,
            existingByApId.id,
            existingByApId.conversation_root_id,
            apUrl,
          );
          return existingByApId;
        }
      }

      // Ensure author exists
      const authorUrl = normalizeActor(remoteObject.attributedTo || remoteObject.actor);
      await this.ensureRemoteUser(authorUrl);

      // Get author ID
      const { data: author } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', authorUrl)
        .single();

      if (!author) {
        logger.warn(`Could not find/create author for remote post`);
        return null;
      }

      // Convert content
      const content = noteToContent(remoteObject);
      const visibility = this.determineVisibility(remoteObject);

      // Walk the reply chain so the imported post lands with `in_reply_to`
      // and `conversation_root_id` correctly set, AND any missing ancestors
      // are imported alongside it. We share `depth` with the caller so a
      // mutually-recursive walk stops at MAX_DEPTH overall (not per-frame).
      let resolvedInReplyTo: string | null = null;
      let conversationRootId: string | null = null;
      if (remoteObject.inReplyTo) {
        const replyResult = await this.resolveReplyChain(remoteObject.inReplyTo, depth);
        resolvedInReplyTo = replyResult.parentPostId;
        conversationRootId = replyResult.conversationRootId;
      }

      // Always stamp the AP url of the parent in metadata so we have a paper
      // trail even if resolution failed (e.g. parent server unreachable). The
      // client-side ancestor walker can retry from this hint later.
      const metadata: Record<string, any> = {};
      if (remoteObject.inReplyTo) {
        metadata.in_reply_to_ap_url = remoteObject.inReplyTo;
      }

      const { data: newPost, error } = await supabase
        .from('posts')
        .insert({
          ap_id: apId,
          url: apUrl,
          author_id: author.id,
          content,
          visibility,
          is_local: false,
          in_reply_to: resolvedInReplyTo,
          conversation_root_id: conversationRootId,
          metadata,
          created_at: remoteObject.published || new Date().toISOString(),
          content_warning: remoteObject.summary || null,
          is_sensitive: remoteObject.sensitive === true,
          replies_count: remoteObject.replies?.totalItems || remoteObject.repliesCount || 0,
          favorites_count: remoteObject.likes?.totalItems || remoteObject.favouritesCount || 0,
          reblogs_count: remoteObject.shares?.totalItems || remoteObject.sharesCount || 0,
        })
        .select('id, in_reply_to, conversation_root_id')
        .single();

      if (error) {
        // Handle unique constraint violation gracefully (concurrent insert race)
        if (error.code === '23505') {
          const { data: raced } = await supabase
            .from('posts')
            .select('id, in_reply_to, conversation_root_id')
            .eq('ap_id', apId)
            .maybeSingle();
          if (raced) {
            logger.info(`⏭️ Concurrent insert resolved for ${apId} → ${raced.id}`);
            await this.relinkPendingChildren(apId, raced.id, raced.conversation_root_id, apUrl);
            return raced;
          }
        }
        logger.error('Failed to create remote post:', error);
        return null;
      }

      logger.info(`✅ Fetched and created remote post: ${apId}`);

      // Heal any orphan replies that were waiting for this post to land.
      if (newPost) {
        await this.relinkPendingChildren(apId, newPost.id, newPost.conversation_root_id, apUrl);
      }

      // Enrich link previews asynchronously
      if (newPost) {
        const { enrichPostLinkPreviews } = await import('../listeners/DatabaseListener.js');
        enrichPostLinkPreviews({ id: newPost.id, content, metadata: {} }).catch(err =>
          logger.warn('Link preview enrichment failed for fetched post:', err)
        );
      }

      return newPost;
    } catch (error) {
      logger.warn(`Error fetching remote post ${postUrl}:`, error);
      return null;
    }
  }

  /**
   * Process Update activity (profile update, post edit).
   *
   * Each branch verifies that `activity.actor` actually owns the object being
   * modified before writing anything. Without this guard a remote signer can
   * Update someone else's profile or edit any post by URL (BUGS.md C2).
   */
  private static async processUpdate(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);

    if (object.type === 'Person') {
      // The object IS the actor being updated. Refuse unless the activity
      // signer == the actor being updated.
      if (!SignatureService.verifyActorMatch(actorUrl, object.id || '')) {
        logger.warn(
          `🚫 Update Person rejected: actor ${actorUrl} cannot update ${object.id}`,
        );
        return;
      }

      // Update user profile
      const profileData = actorToProfile(object);

      const updateData: any = {
        display_name: profileData.display_name,
        bio: profileData.bio,
        avatar_url: profileData.avatar,
        banner_url: profileData.banner,
        public_key: profileData.public_key,
      };

      // Include custom_status if present
      if (profileData.custom_status) {
        updateData.custom_status = profileData.custom_status;
      }

      // Update profile fields (PropertyValue attachments)
      if (profileData.profile_fields) {
        updateData.profile_fields = profileData.profile_fields;
      }

      // Update federation_metadata with emoji data
      const federationMetadata: any = {};
      if (profileData.bio_emojis && profileData.bio_emojis.length > 0) {
        federationMetadata.bio_emojis = profileData.bio_emojis;
      }
      if (profileData.display_name_emojis && profileData.display_name_emojis.length > 0) {
        federationMetadata.display_name_emojis = profileData.display_name_emojis;
      }
      if (Object.keys(federationMetadata).length > 0) {
        // Merge with existing federation_metadata
        const { data: existing } = await supabase
          .from('profiles')
          .select('federation_metadata')
          .eq('federated_id', object.id)
          .maybeSingle();
        const existingMeta = existing?.federation_metadata ? (typeof existing.federation_metadata === 'string' ? JSON.parse(existing.federation_metadata) : existing.federation_metadata) : {};
        updateData.federation_metadata = JSON.stringify({ ...existingMeta, ...federationMetadata });
      }

      await supabase
        .from('profiles')
        .update(updateData)
        .eq('federated_id', object.id);

      logger.info(`Updated profile: ${object.id}`);
    } else if (object.type === 'Note' || object.type === 'Article') {
      // Handle post edits
      logger.info(`✏️ Processing post edit: ${object.id}`);
      
      // Find the existing post + author actor URL (joined via profiles.federated_id)
      // so we can verify the editor owns the post.
      const { data: existingPost } = await supabase
        .from('posts')
        .select('id, author_id, profiles:author_id(federated_id)')
        .eq('ap_id', object.id)
        .maybeSingle();

      if (!existingPost) {
        logger.warn(`Post not found for edit: ${object.id}`);
        return;
      }

      const ownerActorUrl = (existingPost as any).profiles?.federated_id as string | null | undefined;
      if (!ownerActorUrl || !SignatureService.verifyActorMatch(actorUrl, ownerActorUrl)) {
        logger.warn(
          `🚫 Update Note rejected: actor ${actorUrl} does not own post ${object.id} (owner=${ownerActorUrl ?? 'unknown'})`,
        );
        return;
      }

      // Convert content
      const content = noteToContent(object);
      
      // Update the post
      const { error: updateError } = await supabase
        .from('posts')
        .update({
          content,
          content_warning: object.summary || null,
          is_sensitive: object.sensitive === true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingPost.id);

      if (updateError) {
        logger.error('Failed to update post:', updateError);
      } else {
        logger.info(`✏️ Updated post: ${object.id}`);
      }
    } else if (object.type === 'ChatThread') {
      logger.info(`📋 Routing Update ChatThread to handler: ${object.id}`);
      const { handleThreadActivity } = await import('./ThreadActivityHandler.js');
      const result = await handleThreadActivity({ ...activity, object });
      if (!result.success) {
        logger.warn(`Thread Update failed: ${result.error}`);
      }
    } else if (object['harmony:type'] === 'harmony:GroupConversation') {
      // Update group conversation (DM group) - name, icon changes
      await this.handleGroupConversationUpdate(activity, object);
    } else if (['harmony:TextChannel', 'harmony:VoiceChannel', 'harmony:Category'].includes(object.type)) {
      await this.processHarmonyChannelUpdate(activity, object);
    } else if (object.type === 'Group' || object['harmony:ChatServer']) {
      // Update server (Group) - name, icon, description changes
      logger.info(`🏠 Processing server update: ${object.id}`);
      
      // Extract server ID from the ap_id
      const serverIdMatch = object.id?.match(/\/servers\/([a-f0-9-]{36})$/i);
      if (!serverIdMatch) {
        logger.warn(`Cannot extract server ID from ap_id: ${object.id}`);
        return;
      }
      
      // Find the server by ID (it should already exist as a federated copy)
      const { data: existingServer } = await supabase
        .from('servers')
        .select('id, ap_id')
        .eq('id', serverIdMatch[1])
        .eq('is_local_server', false)
        .maybeSingle();
      
      if (!existingServer) {
        logger.warn(`Remote server not found for Update: ${object.id}`);
        return;
      }

      // Group actor ownership: signer must match the server's stored actor URL.
      // Same-domain delegation is allowed here because the server inbox is
      // the canonical Group inbox (see SignatureService.verifyActorMatch docs).
      const serverActorUrl = (existingServer as any).ap_id as string | null | undefined;
      if (!serverActorUrl || !SignatureService.verifyActorMatch(actorUrl, serverActorUrl, true)) {
        logger.warn(
          `🚫 Update Group rejected: actor ${actorUrl} does not own server ${object.id} (server actor=${serverActorUrl ?? 'unknown'})`,
        );
        return;
      }
      
      // Build update object
      const updateData: any = {
        updated_at: new Date().toISOString(),
      };
      
      if (object.name) {
        updateData.name = object.name;
      }
      if (object.summary !== undefined) {
        updateData.description = object.summary;
      }
      // Only touch the icon when the update actually carries one. Treat the
      // built-in default value as "no icon" (store null) so the local UI falls
      // back instead of loading a bogus default asset URL (400).
      if (object.icon?.url) {
        updateData.icon = isDefaultServerIcon(object.icon.url) ? null : object.icon.url;
      }
      
      const { error: updateError } = await supabase
        .from('servers')
        .update(updateData)
        .eq('id', existingServer.id);
      
      if (updateError) {
        logger.error(`Failed to update server ${existingServer.id}:`, updateError);
      } else {
        logger.info(`🏠 Updated remote server: ${object.name || existingServer.id}`);
      }
    }
  }

  /**
   * Process Delete activity.
   *
   * Verifies that `activity.actor` owns the object before soft-deleting.
   * Without this guard any signed remote actor could delete any post/message
   * by URL (BUGS.md C2).
   */
  private static async processDelete(activity: any): Promise<void> {
    const object = activity.object;
    if (object && typeof object === 'object' && object.type === 'ChatThread') {
      logger.info(`📋 Routing Delete ChatThread to handler: ${object.id}`);
      const { handleThreadActivity } = await import('./ThreadActivityHandler.js');
      const result = await handleThreadActivity({ ...activity, object });
      if (!result.success) {
        logger.warn(`Thread Delete failed: ${result.error}`);
      }
      return;
    }

    const { objectUrl } = extractDeleteData(activity);
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);

    // Look up the post first and check that the deleting actor is the author.
    // We do post and message independently so a Delete that targets one of the
    // two doesn't fail-open on the other.
    const { data: existingPost } = await supabase
      .from('posts')
      .select('id, profiles:author_id(federated_id)')
      .eq('ap_id', objectUrl)
      .maybeSingle();

    let postDeleted = false;
    if (existingPost) {
      const ownerActorUrl = (existingPost as any).profiles?.federated_id as string | null | undefined;
      if (!ownerActorUrl || !SignatureService.verifyActorMatch(actorUrl, ownerActorUrl)) {
        logger.warn(
          `🚫 Delete post rejected: actor ${actorUrl} does not own ${objectUrl} (owner=${ownerActorUrl ?? 'unknown'})`,
        );
      } else {
        const { error: postError } = await supabase
          .from('posts')
          .update({ is_deleted: true, deleted_at: new Date().toISOString() })
          .eq('id', (existingPost as any).id);
        if (!postError) postDeleted = true;
      }
    }

    // Same pattern for messages: look up sender, verify, then delete.
    // `messages.user_id` references `profiles(id)` (see db_schema/init/04_tables_servers.sql:130).
    const { data: existingMessage } = await supabase
      .from('messages')
      .select('id, profiles:user_id(federated_id)')
      .eq('metadata->>ap_id', objectUrl)
      .maybeSingle();

    let messageDeleted = false;
    if (existingMessage) {
      const ownerActorUrl = (existingMessage as any).profiles?.federated_id as string | null | undefined;
      if (!ownerActorUrl || !SignatureService.verifyActorMatch(actorUrl, ownerActorUrl)) {
        logger.warn(
          `🚫 Delete message rejected: actor ${actorUrl} does not own ${objectUrl} (owner=${ownerActorUrl ?? 'unknown'})`,
        );
      } else {
        const { error: messageError } = await supabase
          .from('messages')
          .update({ is_deleted: true })
          .eq('id', (existingMessage as any).id);
        if (!messageError) messageDeleted = true;
      }
    }

    if (postDeleted || messageDeleted) {
      logger.info(`Deleted object: ${objectUrl}`);
    }
  }

  /**
   * Process Like activity (including emoji reactions)
   */
  private static async processLike(activity: any): Promise<void> {
    const { actorUrl, objectUrl, emoji, emojiUrl, emojiName } = extractLikeData(activity);
    const supabase = getSupabaseClient();
    
    logger.info(`📊 Extracted Like data: emoji="${emoji}", emojiUrl="${emojiUrl}", emojiName="${emojiName}"`);

    // Ensure user exists
    await this.ensureRemoteUser(actorUrl);

    // Get user ID
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!user) {
      logger.error('Failed to find user for like');
      return;
    }

    // Find target - could be a post OR a message (DM)
    let post = null;
    let message = null;
    
    // Check if this is a message (DM) reaction - try multiple methods
    // Method 1: Local message URL with UUID
    if (objectUrl.includes('/messages/')) {
      const uuidMatch = objectUrl.match(/\/messages\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const messageId = uuidMatch[1];
        const { data: messageById } = await supabase
          .from('messages')
          .select('id, conversation_id')
          .eq('id', messageId)
          .maybeSingle();
        message = messageById;
        
        if (message) {
          logger.info(`📨 Found message for reaction by local ID: ${messageId}`);
        }
      }
    }
    
    // Method 2: Try finding message by ap_id in metadata (for remote DMs)
    // This handles when a remote user reacts to their own message they sent us
    if (!message) {
      const { data: messageByApId } = await supabase
        .from('messages')
        .select('id, conversation_id')
        .eq('metadata->>ap_id', objectUrl)
        .maybeSingle();
      
      if (messageByApId) {
        message = messageByApId;
        logger.info(`📨 Found message for reaction by ap_id: ${objectUrl}`);
      }
    }
    
    // If still not a message, try to find as a post
    if (!message) {
      // Method 1: Try by ap_id
      const { data: postByApId } = await supabase
        .from('posts')
        .select('id')
        .eq('ap_id', objectUrl)
        .maybeSingle();
      
      post = postByApId;
      
      // Method 2: If not found, try extracting UUID from URL
      if (!post && objectUrl.includes('/posts/')) {
        const uuidMatch = objectUrl.match(/\/posts\/([a-f0-9-]{36})/);
        if (uuidMatch) {
          const postId = uuidMatch[1];
          const { data: postById } = await supabase
            .from('posts')
            .select('id')
            .eq('id', postId)
            .maybeSingle();
          post = postById;
        }
      }
    }

    // Handle message (DM) reaction
    if (message) {
      const isCustomEmoji = !!(emojiUrl && emojiName);
      const reactionData: any = {
        message_id: message.id,
        user_id: user.id,
        metadata: { federated: true, from_domain: new URL(actorUrl).hostname },
      };

      if (isCustomEmoji) {
        // Custom emoji with URL - resolve to an emoji_id in the emojis table
        const emojiId = await this.resolveInboundEmojiId(
          supabase, emoji, emojiName, emojiUrl, user.id,
        );
        if (!emojiId) {
          logger.error('❌ Could not find or create emoji for message reaction');
          return;
        }
        reactionData.emoji_id = emojiId;
      } else {
        // Native/unicode emoji - store as custom_emoji_content with null emoji_id
        // This matches how local reactions are stored and groups correctly
        let normalizedEmoji = emoji || '❤️';
        if (normalizedEmoji === '❤') normalizedEmoji = '❤️';
        reactionData.emoji_id = null;
        reactionData.custom_emoji_content = normalizedEmoji;
      }

      // Deduplicate check
      let dupQuery = supabase
        .from('reactions')
        .select('id')
        .eq('message_id', message.id)
        .eq('user_id', user.id);

      if (reactionData.emoji_id) {
        dupQuery = dupQuery.eq('emoji_id', reactionData.emoji_id);
      } else {
        dupQuery = dupQuery.is('emoji_id', null)
          .eq('custom_emoji_content', reactionData.custom_emoji_content);
      }

      const { data: existing } = await dupQuery.maybeSingle();

      if (existing) {
        logger.info(`🔄 Reaction already exists for user ${user.id} on message ${message.id}`);
        return;
      }

      // Store the AP activity ID for traceability
      reactionData.metadata = { ...reactionData.metadata, ap_id: activity.id };

      const { error: reactionError } = await supabase.from('reactions').insert(reactionData);

      if (reactionError) {
        // Handle unique constraint violation gracefully (concurrent insert race)
        if (reactionError.code === '23505') {
          logger.info(`🔄 Reaction already exists (constraint): ${reactionError.message}`);
        } else {
          logger.error('❌ Failed to insert message reaction:', reactionError);
        }
      } else {
        logger.info(`✅ Added reaction to message ${message.id}: ${emoji || '❤️'}`);
      }
      return;
    }

    // Handle post reaction (existing logic)
    if (post) {
      const emojiId = await this.resolveInboundEmojiId(
        supabase, emoji, emojiName, emojiUrl, user.id,
      );
      
      // Normalize heart variants so Mastodon plain-Likes group consistently
      let normalizedEmoji = emoji || '❤️';
      if (!emoji || normalizedEmoji === '❤' || normalizedEmoji === '❤️') {
        normalizedEmoji = '❤️';
      }
      
      logger.info(`💾 Inserting reaction: emoji_id=${emojiId}, custom_content=${normalizedEmoji}`);
      
      // Duplicate check - match on user + post + specific emoji to allow
      // multiple different reactions from the same user
      const duplicateQuery = supabase
        .from('post_interactions')
        .select('id')
        .eq('post_id', post.id)
        .eq('user_id', user.id)
        .eq('interaction_type', 'emoji_reaction');

      if (emojiId) {
        duplicateQuery.eq('emoji_id', emojiId);
      } else {
        duplicateQuery.eq('custom_emoji_content', normalizedEmoji);
      }

      const { data: existing } = await duplicateQuery.maybeSingle();
      
      if (existing) {
        logger.info(`🔄 Reaction already exists for user ${user.id} on post ${post.id}`);
        return;
      }
      
      const { error: interactionError } = await supabase.from('post_interactions').insert({
        post_id: post.id,
        user_id: user.id,
        interaction_type: 'emoji_reaction',
        emoji_id: emojiId,
        custom_emoji_content: normalizedEmoji,
        is_local: false,
      });

      if (interactionError) {
        logger.error('❌ Failed to insert reaction:', interactionError);
      } else {
        logger.info(`✅ Added reaction to post ${post.id}: ${normalizedEmoji}${emojiUrl ? ` with URL: ${emojiUrl}` : ' (no URL)'}`);
      }
    } else {
      logger.warn(`Post or message not found for like: ${objectUrl}`);
    }
  }

  /**
   * Process Announce activity (reblog/boost)
   */
  private static async processAnnounce(activity: any): Promise<void> {
    const { actorUrl, objectUrl, published } = extractAnnounceData(activity);
    const supabase = getSupabaseClient();

    logger.info(`📢 Processing Announce: ${actorUrl} reblogged ${objectUrl}`);

    // Ensure user exists
    await this.ensureRemoteUser(actorUrl);

    // Get user ID
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!user) {
      logger.error('Failed to find user for announce');
      return;
    }

    // Find original post - try ap_id first (correct column), then by UUID extraction
    let originalPost: any = null;
    
    const originalPostColumns = 'id, content, visibility, author_id, created_at, ap_id, is_sensitive, content_warning, favorites_count, replies_count, reblogs_count, media_attachments, url';

    // Method 1: Try by ap_id (correct column name)
    const { data: postByApId } = await supabase
      .from('posts')
      .select(originalPostColumns)
      .eq('ap_id', objectUrl)
      .maybeSingle();
    
    originalPost = postByApId;
    
    // Method 2: If not found, try extracting UUID from URL
    // Support both /posts/{uuid} and /activities/{uuid} URL formats
    if (!originalPost) {
      const uuidMatch = objectUrl.match(/\/(?:posts|activities)\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const postId = uuidMatch[1];
        logger.info(`🔍 Trying to find post by UUID: ${postId}`);
        const { data: postById } = await supabase
          .from('posts')
          .select(originalPostColumns)
          .eq('id', postId)
          .maybeSingle();
        originalPost = postById;
        if (postById) {
          logger.info(`✅ Found post by UUID: ${postId}`);
        }
      }
    }

    // Method 3: If still not found, try to fetch and create the remote post
    if (!originalPost) {
      logger.info(`Original post not found locally, attempting to fetch: ${objectUrl}`);
      try {
        // BUGS.md H15: objectUrl is from inbox payload (attacker-influenced).
        const response = await safeFetch(objectUrl, {
          headers: {
            'Accept': 'application/activity+json, application/ld+json',
          },
        });
        
        if (response.ok) {
          const remotePost = await response.json();
          if (remotePost.type === 'Note' || remotePost.type === 'Article') {
            // Ensure the remote author exists
            const authorUrl = normalizeActor(remotePost.attributedTo || remotePost.actor);
            await this.ensureRemoteUser(authorUrl);
            
            // Get author ID
            const { data: author } = await supabase
              .from('profiles')
              .select('id')
              .eq('federated_id', authorUrl)
              .single();
            
            if (author) {
              // Create the original post
              const content = noteToContent(remotePost);
              const visibility = this.determineVisibility(remotePost);
              
              const { data: newPost, error: createError } = await supabase
                .from('posts')
                .insert({
                  ap_id: remotePost.id,
                  author_id: author.id,
                  content,
                  visibility,
                  is_local: false,
                  is_sensitive: remotePost.sensitive === true,
                  content_warning: remotePost.summary || null,
                  created_at: remotePost.published || new Date().toISOString(),
                  replies_count: remotePost.replies?.totalItems || remotePost.repliesCount || 0,
                  favorites_count: remotePost.likes?.totalItems || remotePost.favouritesCount || 0,
                  reblogs_count: remotePost.shares?.totalItems || remotePost.sharesCount || 0,
                })
                .select(originalPostColumns)
                .single();
              
              if (!createError && newPost) {
                originalPost = newPost;
                logger.info(`Created remote post ${remotePost.id} for reblog`);
              }
            }
          }
        }
      } catch (fetchError) {
        logger.warn(`Failed to fetch remote post for reblog: ${objectUrl}`, fetchError);
      }
    }

    if (!originalPost) {
      logger.warn(`Original post not found for announce: ${objectUrl}`);
      return;
    }

    // Check if reblog already exists to avoid duplicates
    const { data: existingReblog } = await supabase
      .from('posts')
      .select('id')
      .eq('ap_id', activity.id)
      .maybeSingle();
    
    if (existingReblog) {
      logger.info(`Reblog already exists: ${activity.id}`);
      return;
    }

    // Get original post author for reblog_author field
    const { data: originalAuthor } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain, is_local')
      .eq('id', originalPost.author_id)
      .single();

    // Create reblog post with proper metadata and reblog fields
    // The database constraint requires either content OR reblog to be non-null
    const { error: insertError } = await supabase.from('posts').insert({
      ap_id: activity.id, // Set ap_id for the reblog itself
      author_id: user.id,
      content: [], // Reblogs have no content of their own
      visibility: 'public',
      is_local: false,
      is_federated: true,
      ap_type: 'Announce',
      // The reblog field is required for the posts_content_not_empty constraint
      reblog: {
        id: originalPost.id,
        content: originalPost.content,
        created_at: originalPost.created_at,
        visibility: originalPost.visibility,
        ap_id: originalPost.ap_id || objectUrl,
        url: originalPost.url || null,
        is_sensitive: originalPost.is_sensitive || false,
        content_warning: originalPost.content_warning || null,
        favorites_count: originalPost.favorites_count || 0,
        replies_count: originalPost.replies_count || 0,
        reblogs_count: originalPost.reblogs_count || 0,
        media_attachments: originalPost.media_attachments || [],
      },
      reblog_author: originalAuthor || null,
      metadata: {
        reblog_of: originalPost.id,
        original_ap_id: originalPost.ap_id || objectUrl,
        original_author_id: originalPost.author_id,
      },
      created_at: published || new Date().toISOString(),
    });

    if (insertError) {
      logger.error('Failed to create reblog post:', insertError);
    } else {
      // Also create a post_interaction record for the reblog
      await supabase.from('post_interactions').insert({
        user_id: user.id,
        post_id: originalPost.id,
        interaction_type: 'reblog',
        ap_id: activity.id,
        is_local: false,
      }).catch(err => logger.warn('Failed to create reblog interaction:', err));
      
      // Increment reblogs_count on original post
      await supabase.rpc('increment_post_reblogs', { p_post_id: originalPost.id })
        .catch(err => logger.warn('Failed to increment reblog count:', err));

      logger.info(`✅ Created reblog of ${originalPost.id} by ${user.id}`);
    }
  }

  /**
   * Process Undo activity
   */
  private static async processUndo(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();

    logger.info(`🔄 Processing Undo activity from ${activity.actor}`);
    logger.debug(`Undo object: ${JSON.stringify(object)?.substring(0, 500)}`);

    if (!object) {
      logger.warn('Undo activity has no object, skipping');
      return;
    }

    // Handle string object (just the ID of the original activity)
    const objectType = typeof object === 'string' ? null : object.type;
    
    // If object is a string, we need to look up what type it was
    if (typeof object === 'string') {
      logger.info(`🔍 Undo object is a string ID: ${object}`);
      // Try to find the original activity by its ID
      const { data: originalActivity } = await supabase
        .from('ap_activities')
        .select('ap_type, activity_data')
        .eq('ap_id', object)
        .maybeSingle();
      
      if (originalActivity) {
        logger.info(`Found original activity type: ${originalActivity.ap_type}`);
        // Process based on the original activity type
        await this.processUndoByType(originalActivity.ap_type, originalActivity.activity_data, activity.actor);
        return;
      } else {
        logger.warn(`Could not find original activity: ${object}`);
        return;
      }
    }

    switch (objectType) {
      case 'Follow': {
        // Remove follow
        const { followerUrl, followingUrl } = extractFollowData(object);
        logger.info(`🔄 Undoing follow: ${followerUrl} → ${followingUrl}`);
        
        const { data: follower } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', followerUrl)
          .single();

        const { data: following } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', followingUrl)
          .single();

        if (!follower) {
          logger.warn(`Follower not found: ${followerUrl}`);
        }
        if (!following) {
          logger.warn(`Following not found: ${followingUrl}`);
        }

        if (follower && following) {
          const { error } = await supabase
            .from('follows')
            .delete()
            .eq('follower_id', follower.id)
            .eq('following_id', following.id);

          if (error) {
            logger.error(`Failed to delete follow:`, error);
          } else {
            logger.info(`✅ Undid follow: ${followerUrl} → ${followingUrl}`);
          }
        }
        break;
      }

      case 'Like':
      case 'EmojiReaction': {
        await this.processUndoReaction(object, activity.actor);
        break;
      }

      case 'Announce': {
        // Remove reblog by ap_id (correct column)
        const announceId = typeof object === 'string' ? object : object.id;
        logger.info(`🔄 Undoing announce: ${announceId}`);
        
        // First get the reblog post to find the original
        const { data: reblogPost } = await supabase
          .from('posts')
          .select('id, metadata')
          .eq('ap_id', announceId)
          .maybeSingle();
        
        if (reblogPost) {
          // Delete the reblog post
          const { error: deleteError } = await supabase
            .from('posts')
            .delete()
            .eq('id', reblogPost.id);
          
          if (deleteError) {
            logger.error(`Failed to delete reblog post:`, deleteError);
          }
          
          // Also remove the interaction record if the original post is known
          const originalPostId = reblogPost.metadata?.reblog_of;
          if (originalPostId) {
            const actorUrl = normalizeActor(activity.actor);
        const { data: user } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', actorUrl)
          .single();

            if (user) {
              await supabase
                .from('post_interactions')
                .delete()
                .eq('user_id', user.id)
                .eq('post_id', originalPostId)
                .eq('interaction_type', 'reblog');
            }
          }
          logger.info(`✅ Undid announce: ${announceId}`);
        } else {
          logger.warn(`Reblog post not found for Undo: ${announceId}`);
        }
        break;
      }
      
      default:
        logger.warn(`Unhandled Undo object type: ${objectType}`);
    }
  }

  /**
   * Process Undo for Like/EmojiReaction (supports both posts and messages/DMs)
   */
  private static async processUndoReaction(object: any, _actorUrl: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { actorUrl: likeActorUrl, objectUrl } = extractLikeData(object);
    
    logger.info(`🔄 Undoing reaction from ${likeActorUrl} on ${objectUrl}`);
    
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', likeActorUrl)
      .single();

    if (!user) {
      logger.warn(`User not found for Undo reaction: ${likeActorUrl}`);
      return;
    }

    // Check if this is a message (DM) reaction
    if (objectUrl.includes('/messages/')) {
      const uuidMatch = objectUrl.match(/\/messages\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const messageId = uuidMatch[1];
        logger.info(`🔄 Undoing message reaction on ${messageId}`);
        
        // Delete from reactions table (for messages)
        const { error, count } = await supabase
          .from('reactions')
          .delete()
          .eq('user_id', user.id)
          .eq('message_id', messageId);

        if (error) {
          logger.error(`Failed to delete message reaction:`, error);
        } else {
          logger.info(`✅ Undid message reaction on ${objectUrl} (deleted ${count || 'unknown'} records)`);
        }
      }
      return;
    }

    // Handle post reactions
    let post = null;
    
    // Try by ap_id first
    const { data: postByApId } = await supabase
      .from('posts')
      .select('id')
      .eq('ap_id', objectUrl)
      .maybeSingle();
    
    post = postByApId;
    
    // Fallback: try extracting UUID from URL (for local posts)
    if (!post && objectUrl.includes('/posts/')) {
      const uuidMatch = objectUrl.match(/\/posts\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        logger.info(`🔍 Trying to find local post by UUID: ${uuidMatch[1]}`);
        const { data: postById } = await supabase
          .from('posts')
          .select('id')
          .eq('id', uuidMatch[1])
          .maybeSingle();
        post = postById;
      }
    }

    if (!post) {
      logger.warn(`Post not found for Undo reaction: ${objectUrl}`);
      return;
    }

    // Delete from post_interactions
    const { error, count } = await supabase
      .from('post_interactions')
      .delete()
      .eq('user_id', user.id)
      .eq('post_id', post.id)
      .in('interaction_type', ['favorite', 'emoji_reaction']);

    if (error) {
      logger.error(`Failed to delete reaction:`, error);
    } else {
      logger.info(`✅ Undid reaction on ${objectUrl} (deleted ${count || 'unknown'} records)`);
    }
  }

  /**
   * Process Undo by looking up the original activity type
   */
  private static async processUndoByType(activityType: string, activityData: any, actorUrl: string): Promise<void> {
    logger.info(`🔄 Processing Undo by type: ${activityType}`);
    
    switch (activityType) {
      case 'Like':
      case 'EmojiReaction':
        await this.processUndoReaction(activityData, actorUrl);
        break;
      case 'Follow':
        // Extract follow data from the stored activity
        if (activityData) {
          const supabase = getSupabaseClient();
          const { followerUrl, followingUrl } = extractFollowData(activityData);
          
          const { data: follower } = await supabase
            .from('profiles')
            .select('id')
            .eq('federated_id', followerUrl)
            .single();

          const { data: following } = await supabase
              .from('profiles')
              .select('id')
            .eq('federated_id', followingUrl)
              .single();
            
          if (follower && following) {
              await supabase
              .from('follows')
                .delete()
              .eq('follower_id', follower.id)
              .eq('following_id', following.id);
            logger.info(`✅ Undid follow: ${followerUrl} → ${followingUrl}`);
          }
        }
        break;
      case 'Announce':
        // Handle via ap_id lookup
        if (activityData?.id) {
          const supabase = getSupabaseClient();
          await supabase
            .from('posts')
            .delete()
            .eq('ap_id', activityData.id);
          logger.info(`✅ Undid announce: ${activityData.id}`);
        }
        break;
      default:
        logger.warn(`Unknown activity type for Undo: ${activityType}`);
    }
  }

  /**
   * Process Create activity for polls (Question type)
   * Stores the poll as a post with poll data in metadata
   */
  private static async processCreatePoll(activity: any, object: any): Promise<void> {
    const supabase = getSupabaseClient();

    // Ensure author exists
    await this.ensureRemoteUser(normalizeActor(activity.actor));

    const { data: author } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', normalizeActor(activity.actor))
      .single();

    if (!author) {
      logger.error('Failed to find author for poll');
      return;
    }

    // Extract poll options
    const options = [];
    
    // oneOf = single choice, anyOf = multiple choice
    const pollOptions = object.oneOf || object.anyOf || [];
    const isMultipleChoice = !!object.anyOf;
    
    for (const option of pollOptions) {
      if (option.type === 'Note') {
        options.push({
          name: option.name || '',
          votes: option.replies?.totalItems || 0,
        });
      }
    }

    // Calculate end time
    let endTime = null;
    if (object.endTime) {
      endTime = object.endTime;
    } else if (object.closed) {
      endTime = object.closed;
    }

    // Convert content
    const content = noteToContent(object);
    const visibility = this.determineVisibility(object);

    // Build poll metadata
    const pollMetadata = {
      is_poll: true,
      poll_options: options,
      poll_multiple_choice: isMultipleChoice,
      poll_end_time: endTime,
      poll_voters_count: object.votersCount || 0,
      poll_closed: !!object.closed || (endTime && new Date(endTime) < new Date()),
    };

    // Check if poll already exists (may arrive via Update for vote count changes)
    const { data: existingPoll } = await supabase
      .from('posts')
      .select('id')
      .eq('ap_id', object.id)
      .maybeSingle();

    if (existingPoll) {
      // Update existing poll metadata (vote counts, closed status)
      const { error } = await supabase.from('posts')
        .update({ metadata: pollMetadata })
        .eq('id', existingPoll.id);
      if (error) {
        logger.error('Failed to update poll:', error);
      } else {
        logger.info(`📊 Updated poll: ${object.id}`);
      }
    } else {
      const { error } = await supabase.from('posts').insert({
        ap_id: object.id,
        ap_type: 'Question',
        author_id: author.id,
        content,
        visibility,
        is_local: false,
        created_at: object.published || new Date().toISOString(),
        content_warning: object.summary || null,
        is_sensitive: object.sensitive === true,
        metadata: pollMetadata,
        replies_count: object.replies?.totalItems || object.repliesCount || 0,
        favorites_count: object.likes?.totalItems || object.favouritesCount || 0,
        reblogs_count: object.shares?.totalItems || object.sharesCount || 0,
      });

      if (error) {
        logger.error('Failed to create poll post:', error);
      } else {
        logger.info(`📊 Created poll: ${object.id} with ${options.length} options`);
      }
    }
  }

  /**
   * Extract server ID from a Harmony server URL and find the local (remote-copy) server.
   * Returns the server row or null.
   */
  private static async resolveRemoteServer(serverUrl: string): Promise<any | null> {
    const supabase = getSupabaseClient();
    const serverIdMatch = serverUrl.match(/\/servers\/([a-f0-9-]{36})$/i);
    if (!serverIdMatch) return null;

    const { data: server } = await supabase
      .from('servers')
      .select('id, federation_enabled')
      .eq('id', serverIdMatch[1])
      .eq('is_local_server', false)
      .maybeSingle();

    return server;
  }

  /**
   * Handle Harmony channel/category Add activities received on the shared inbox.
   */
  private static async processHarmonyChannelAdd(activity: any, object: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;

    const server = await this.resolveRemoteServer(actorUrl);
    if (!server) {
      logger.warn(`Remote server not found for Add activity actor: ${actorUrl}`);
      return;
    }
    if (!server.federation_enabled) {
      logger.info(`Federation not enabled for server ${server.id}, ignoring Add`);
      return;
    }

    const serverId = server.id;
    const entityUuidMatch = object.id?.match(/\/channels\/([a-f0-9-]{36})$/i);
    const entityUuid = entityUuidMatch ? entityUuidMatch[1] : undefined;

    if (object.type === 'harmony:Category') {
      const { data: existing } = await supabase
        .from('channel_categories')
        .select('id')
        .eq('server_id', serverId)
        .eq('name', object.name)
        .maybeSingle();

      if (existing) {
        logger.info(`Category already exists: ${object.name}`);
        return;
      }

      const catData: any = {
        server_id: serverId,
        name: object.name,
        order: object.position || object.order || 0,
      };
      if (entityUuid) catData.id = entityUuid;

      const { error } = await supabase.from('channel_categories').insert(catData);
      if (error) {
        logger.error(`Failed to create category ${object.name}:`, error);
      } else {
        logger.info(`📁 Created remote category: ${object.name}`);
      }
    } else {
      const channelType = object.type === 'harmony:VoiceChannel' ? 1 : 0;

      const { data: existing } = await supabase
        .from('channels')
        .select('id')
        .eq('ap_id', object.id)
        .maybeSingle();

      if (existing) {
        logger.info(`Channel already exists: ${object.name}`);
        return;
      }

      let categoryId = null;
      if (object.category) {
        const catMatch = object.category.match(/\/channels\/([a-f0-9-]{36})$/i);
        if (catMatch) {
          const { data: cat } = await supabase
            .from('channel_categories')
            .select('id')
            .eq('id', catMatch[1])
            .eq('server_id', serverId)
            .maybeSingle();
          categoryId = cat?.id || null;
        }
      }

      const insertData: any = {
        server_id: serverId,
        name: object.name,
        description: object.description,
        type: channelType,
        order: object.position || object.order || 0,
        ap_id: object.id,
        is_remote: true,
        category: categoryId,
      };
      if (entityUuid) insertData.id = entityUuid;

      const { error } = await supabase.from('channels').insert(insertData);
      if (error) {
        logger.error(`Failed to create channel ${object.name}:`, error);
      } else {
        logger.info(`📢 Created remote channel: ${object.name} (${object.type})`);
      }
    }
  }

  /**
   * Handle Harmony channel/category Update activities received on the shared inbox.
   * Auto-creates the entity if it doesn't exist (missed Add / source-of-truth sync).
   */
  private static async processHarmonyChannelUpdate(activity: any, object: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    const entityUuidMatch = object.id?.match(/\/channels\/([a-f0-9-]{36})$/i);
    const entityUuid = entityUuidMatch ? entityUuidMatch[1] : undefined;

    if (object.type === 'harmony:Category') {
      if (!entityUuid) {
        logger.warn(`Cannot extract UUID from category ap_id: ${object.id}`);
        return;
      }

      const { data: existing } = await supabase
        .from('channel_categories')
        .select('id')
        .eq('id', entityUuid)
        .maybeSingle();

      if (existing) {
        await supabase
          .from('channel_categories')
          .update({
            name: object.name,
            order: object.position || object.order,
          })
          .eq('id', entityUuid);
        logger.info(`✏️ Updated remote category: ${object.name}`);
      } else {
        const server = await this.resolveRemoteServer(actorUrl);
        if (!server) {
          logger.warn(`Remote server not found, cannot auto-create category: ${object.id}`);
          return;
        }
        const { error } = await supabase.from('channel_categories').insert({
          id: entityUuid,
          server_id: server.id,
          name: object.name,
          order: object.position || object.order || 0,
        });
        if (error) {
          logger.error(`Failed to auto-create category ${object.name}:`, error);
        } else {
          logger.info(`📁 Auto-created remote category on Update: ${object.name}`);
        }
      }
    } else {
      const { data: channel } = await supabase
        .from('channels')
        .select('id, server_id')
        .eq('ap_id', object.id)
        .maybeSingle();

      let categoryId = null;
      if (object.category) {
        const catMatch = object.category.match(/\/channels\/([a-f0-9-]{36})$/i);
        if (catMatch) {
          const { data: cat } = await supabase
            .from('channel_categories')
            .select('id')
            .eq('id', catMatch[1])
            .maybeSingle();
          categoryId = cat?.id || null;
        }
      }

      if (channel) {
        await supabase
          .from('channels')
          .update({
            name: object.name,
            description: object.description,
            order: object.position || object.order,
            category: categoryId,
          })
          .eq('id', channel.id);
        logger.info(`✏️ Updated remote channel: ${object.name}`);
      } else {
        const server = await this.resolveRemoteServer(actorUrl);
        if (!server) {
          logger.warn(`Remote server not found, cannot auto-create channel: ${object.id}`);
          return;
        }
        const channelType = object.type === 'harmony:VoiceChannel' ? 1 : 0;
        const insertData: any = {
          server_id: server.id,
          name: object.name,
          description: object.description,
          type: channelType,
          order: object.position || object.order || 0,
          ap_id: object.id,
          is_remote: true,
          category: categoryId,
        };
        if (entityUuid) insertData.id = entityUuid;

        const { error } = await supabase.from('channels').insert(insertData);
        if (error) {
          logger.error(`Failed to auto-create channel ${object.name}:`, error);
        } else {
          logger.info(`📢 Auto-created remote channel on Update: ${object.name}`);
        }
      }
    }
  }

  /**
   * Handle Harmony channel/category Remove activities received on the shared inbox.
   */
  private static async processHarmonyChannelRemove(activity: any, objectUrl: string): Promise<void> {
    const supabase = getSupabaseClient();
    const uuidMatch = objectUrl.match(/\/channels\/([a-f0-9-]{36})$/i);
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;

    const server = await this.resolveRemoteServer(actorUrl);
    if (!server) {
      logger.warn(`Remote server not found for Remove activity actor: ${actorUrl}`);
      return;
    }

    // Try channels table first
    const { data: deletedChannel } = await supabase
      .from('channels')
      .delete()
      .eq('ap_id', objectUrl)
      .eq('server_id', server.id)
      .select('id')
      .maybeSingle();

    if (deletedChannel) {
      logger.info(`🗑️ Removed remote channel: ${objectUrl}`);
      return;
    }

    // Try channel_categories by UUID
    if (uuidMatch) {
      const { data: deletedCat } = await supabase
        .from('channel_categories')
        .delete()
        .eq('id', uuidMatch[1])
        .eq('server_id', server.id)
        .select('id')
        .maybeSingle();

      if (deletedCat) {
        logger.info(`🗑️ Removed remote category: ${uuidMatch[1]}`);
        return;
      }
    }

    logger.warn(`Channel/category not found for Remove: ${objectUrl}`);
  }

  /**
   * Process Add activity (pinning posts to featured collection)
   */
  private static async processAdd(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    // eslint-disable-next-line unused-imports/no-unused-vars
    const actorUrl = normalizeActor(activity.actor);
    const targetUrl = typeof activity.target === 'string' ? activity.target : activity.target?.id;
    const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    const object = typeof activity.object === 'object' ? activity.object : null;

    // Handle Harmony channel/category additions (sent to shared inbox)
    if (object && ['harmony:TextChannel', 'harmony:VoiceChannel', 'harmony:Category'].includes(object.type)) {
      await this.processHarmonyChannelAdd(activity, object);
      return;
    }

    // Check if this is adding to featured collection
    if (!targetUrl?.includes('/featured') || !objectUrl) {
      logger.info(`Add activity not for featured collection, skipping`);
      return;
    }

    logger.info(`📌 Processing Add to featured: ${objectUrl}`);

    // Find the post by ap_id
    const { data: post, error } = await supabase
      .from('posts')
      .select('id, author_id')
      .eq('ap_id', objectUrl)
      .maybeSingle();

    if (error || !post) {
      logger.warn(`Post not found for pinning: ${objectUrl}`);
      return;
    }

    // Update the post to be pinned
    await supabase
      .from('posts')
      .update({ is_pinned: true })
      .eq('id', post.id);

    logger.info(`📌 Pinned post: ${objectUrl}`);
  }

  /**
   * Process Remove activity (unpinning posts, group participant removal)
   */
  private static async processRemove(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const target = activity.target;
    const targetUrl = typeof target === 'string' ? target : target?.id;
    const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    // Check if this is a group conversation participant removal
    const targetType = typeof target === 'object' ? target?.['harmony:type'] : null;
    if (targetType === 'harmony:GroupConversation') {
      await this.handleGroupConversationParticipantRemove(activity, target);
      return;
    }

    // Handle Harmony channel/category removal (sent to shared inbox)
    if (objectUrl?.includes('/channels/') && targetUrl?.includes('/servers/')) {
      await this.processHarmonyChannelRemove(activity, objectUrl);
      return;
    }

    // Check if this is removing from featured collection
    if (!targetUrl?.includes('/featured') || !objectUrl) {
      logger.info(`Remove activity not for featured collection, skipping`);
      return;
    }

    logger.info(`📌 Processing Remove from featured: ${objectUrl}`);

    // Find and unpin the post
    const { error } = await supabase
      .from('posts')
      .update({ is_pinned: false })
      .eq('ap_id', objectUrl);

    if (!error) {
      logger.info(`📌 Unpinned post: ${objectUrl}`);
    }
  }

  /**
   * Process Flag activity (reports from other instances)
   */
  private static async processFlag(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);
    const objects = Array.isArray(activity.object) ? activity.object : [activity.object];
    const content = activity.content || 'No reason provided';

    logger.info(`🚩 Processing Flag from ${actorUrl}: ${objects.length} objects`);

    // Ensure reporter exists
    await this.ensureRemoteUser(actorUrl);

    const { data: reporter } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!reporter) {
      logger.warn(`Could not find reporter for Flag activity`);
      return;
    }

    // Process each flagged object (can be users or posts)
    for (const obj of objects) {
      const objectUrl = typeof obj === 'string' ? obj : obj?.id;
      if (!objectUrl) continue;

      // Determine if it's a user or post
      const isUserReport = objectUrl.includes('/users/');
      
      if (isUserReport) {
        // User report
        const { data: reportedUser } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', objectUrl)
          .maybeSingle();

        if (reportedUser) {
          await supabase.from('reports').insert({
            reporter_id: reporter.id,
            reported_user_id: reportedUser.id,
            reason: content,
            report_type: 'user',
            source: 'federation',
            source_instance: new URL(actorUrl).hostname,
            status: 'pending',
            ap_id: activity.id,
          });
          logger.info(`🚩 Created user report for ${objectUrl}`);
        }
      } else {
        // Post report
        const { data: reportedPost } = await supabase
          .from('posts')
          .select('id, author_id')
          .eq('ap_id', objectUrl)
          .maybeSingle();

        if (reportedPost) {
          await supabase.from('reports').insert({
            reporter_id: reporter.id,
            reported_user_id: reportedPost.author_id,
            reported_post_id: reportedPost.id,
            reason: content,
            report_type: 'post',
            source: 'federation',
            source_instance: new URL(actorUrl).hostname,
            status: 'pending',
            ap_id: activity.id,
          });
          logger.info(`🚩 Created post report for ${objectUrl}`);
        }
      }
    }
  }

  /**
   * Process Block activity (federated blocks)
   */
  private static async processBlock(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);
    const blockedUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    if (!blockedUrl) {
      logger.warn(`Block activity missing object`);
      return;
    }

    logger.info(`🚫 Processing Block: ${actorUrl} → ${blockedUrl}`);

    // Ensure both users exist
    await this.ensureRemoteUser(actorUrl);

    const { data: blocker } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    const { data: blocked } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', blockedUrl)
      .maybeSingle();

    if (!blocker || !blocked) {
      logger.warn(`Could not find users for Block activity`);
      return;
    }

    // Create or update block relationship
    await supabase.from('user_blocks').upsert({
      blocker_id: blocker.id,
      blocked_user_id: blocked.id,
      block_type: 'full',
      is_federated: true,
      ap_id: activity.id,
    }, {
      onConflict: 'blocker_id,blocked_user_id',
    });

    // Also remove any follow relationships
    await supabase
      .from('follows')
      .delete()
      .or(`and(follower_id.eq.${blocker.id},following_id.eq.${blocked.id}),and(follower_id.eq.${blocked.id},following_id.eq.${blocker.id})`);

    logger.info(`🚫 Blocked: ${actorUrl} → ${blockedUrl}`);
  }

  /**
   * Resolve an inbound emoji into an emoji_id, creating entries as needed.
   * Works for both custom emojis (with URL) and standard unicode emojis.
   */
  private static async resolveInboundEmojiId(
    supabase: any,
    emoji: string | undefined,
    emojiName: string | undefined,
    emojiUrl: string | undefined,
    userId: string,
  ): Promise<string | null> {
    // Custom emoji with URL
    if (emojiUrl && emojiName) {
      const cleanName = emojiName.replace(/:/g, '');
      const emojiDomain = new URL(emojiUrl).hostname;

      try {
        await supabase.rpc('upsert_remote_emoji', {
          p_shortcode: cleanName,
          p_origin_domain: emojiDomain,
          p_full_code: `:${cleanName}@${emojiDomain}:`,
          p_url: emojiUrl,
        });
      } catch (cacheError) {
        logger.debug(`Could not cache emoji: ${cacheError}`);
      }

      const { data: existing } = await supabase
        .from('emojis')
        .select('id')
        .eq('url', emojiUrl)
        .maybeSingle();

      if (existing) return existing.id;

      const { data: created } = await supabase
        .from('emojis')
        .insert({
          name: cleanName,
          url: emojiUrl,
          server_id: null,
          uploader: userId,
          domain: emojiDomain,
        })
        .select('id')
        .single();

      return created?.id ?? null;
    }

    // Standard unicode emoji - find or create a global emoji entry
    let normalizedEmoji = emoji || '❤️';
    if (!emoji || normalizedEmoji === '❤' || normalizedEmoji === '❤️') {
      normalizedEmoji = '❤️';
    }

    const { data: existing } = await supabase
      .from('emojis')
      .select('id')
      .eq('name', normalizedEmoji)
      .is('url', null)
      .is('server_id', null)
      .maybeSingle();

    if (existing) return existing.id;

    const { data: created } = await supabase
      .from('emojis')
      .insert({
        name: normalizedEmoji,
        url: null,
        server_id: null,
        uploader: userId,
      })
      .select('id')
      .single();

    return created?.id ?? null;
  }

  /**
   * Ensure remote user exists in database (fetch if needed)
   * @param actorUrl - The ActivityPub actor URL
   * @param forceRefresh - If true, refresh profile even if user exists (for stale data)
   */
  private static async ensureRemoteUser(actorUrl: string, forceRefresh: boolean = false): Promise<any | null> {
    const supabase = getSupabaseClient();

    // Check if user already exists by federated_id
    const { data: existing } = await supabase
      .from('profiles')
      .select('id, updated_at, federated_id, username, display_name, avatar_url, color, federation_metadata')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    if (existing && !forceRefresh) {
      // Check if profile is stale (older than 24 hours)
      const updatedAt = new Date(existing.updated_at);
      const hoursSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceUpdate < 24) {
        return existing; // User exists and is fresh enough
      }
      // Profile is stale, refresh it
      logger.info(`Profile for ${actorUrl} is stale (${Math.round(hoursSinceUpdate)}h old), refreshing...`);
    } else if (existing && forceRefresh) {
      logger.info(`Force refreshing profile for ${actorUrl}`);
    }

    // Fetch actor from remote server.
    // BUGS.md H15: actorUrl is attacker-influenced (from inbox or Follow
    // activity); safeFetch handles SSRF + redirect re-validation + timeout.
    try {
      let response = await safeFetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      // Retry with HTTP signature for instances requiring authorized fetch.
      if (response.status === 401 || response.status === 403) {
        logger.debug(`Actor fetch got ${response.status}, retrying with HTTP signature: ${actorUrl}`);
        response = await SignatureService.signedApFetch(actorUrl);
      }

      if (!response.ok) {
        logger.error(`Failed to fetch actor ${actorUrl}: ${response.status}`);
        return existing || null;
      }

      const actor = await response.json();
      const profileData = actorToProfile(actor);

      // SECURITY: Check if this actor claims to be from our local domain
      // This could be a spoofing attack from a malicious remote server
      const { config } = await import('../config/index.js');
      if (profileData.domain.toLowerCase() === config.INSTANCE_DOMAIN.toLowerCase()) {
        logger.warn(`🚨 SECURITY: Remote actor ${actorUrl} claims local domain ${profileData.domain}! Refusing to upsert.`);
        return existing || null;
      }

      // SECURITY: Check if there's an existing LOCAL user with this username/domain
      // The federated_id conflict should prevent this, but belt-and-suspenders
      const { data: existingLocalUser } = await supabase
        .from('profiles')
        .select('id, is_local')
        .eq('username', profileData.username)
        .eq('domain', profileData.domain)
        .eq('is_local', true)
        .maybeSingle();
      
      if (existingLocalUser) {
        logger.warn(`🚨 SECURITY: Refusing to overwrite local user ${profileData.username}@${profileData.domain} via ensureRemoteUser`);
        return existing || null;
      }

      // Upsert remote user - map field names to database columns
      // This handles both initial creation and refreshing stale profiles
      const profileRecord: any = {
        username: profileData.username,
        domain: profileData.domain,
        display_name: profileData.display_name,
        bio: profileData.bio,
        avatar_url: profileData.avatar,   // Map avatar -> avatar_url
        banner_url: profileData.banner,   // Map banner -> banner_url
        public_key: profileData.public_key,
        federated_id: profileData.federated_id,
        inbox_url: profileData.inbox_url,
        outbox_url: profileData.outbox_url,
        followers_url: profileData.followers_url,
        following_url: profileData.following_url,
        is_local: false,
        updated_at: new Date().toISOString(), // Track when we last synced
        last_synced_at: new Date().toISOString(), // Also update last_synced_at
      };

      // Include Harmony extension: profile color
      if (profileData.color) {
        profileRecord.color = profileData.color;
      }

      // Persist ActivityPub profile fields (PropertyValue attachments)
      if (profileData.profile_fields) {
        profileRecord.profile_fields = profileData.profile_fields;
      }

      // Persist shared inbox URL for delivery optimization
      if (actor.endpoints?.sharedInbox) {
        profileRecord.shared_inbox_url = actor.endpoints.sharedInbox;
      }

      // Persist custom emoji metadata so the frontend can render shortcodes
      if (profileData.display_name_emojis?.length || profileData.bio_emojis?.length) {
        const existingMeta = (existing as any)?.federation_metadata || {};
        const meta = typeof existingMeta === 'string' ? JSON.parse(existingMeta) : { ...existingMeta };
        if (profileData.display_name_emojis?.length) {
          meta.display_name_emojis = profileData.display_name_emojis;
        }
        if (profileData.bio_emojis?.length) {
          meta.bio_emojis = profileData.bio_emojis;
        }
        profileRecord.federation_metadata = meta;
      }

      // Upsert the profile
      const { error: upsertError } = await supabase
        .from('profiles')
        .upsert(profileRecord, {
          onConflict: 'federated_id',
        });

      if (upsertError) {
        logger.error(`Failed to upsert profile for ${actorUrl}:`, upsertError);
        return existing || null;
      }

      // Query the profile after upsert (upsert().select() doesn't reliably return data)
      const { data: savedProfile, error: queryError } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, federated_id, color')
        .eq('federated_id', profileData.federated_id)
        .maybeSingle();

      if (queryError) {
        logger.error(`Failed to query profile after upsert for ${actorUrl}:`, queryError);
        return existing || null;
      }

      if (!savedProfile) {
        logger.error(`Profile not found after upsert for ${actorUrl} (federated_id: ${profileData.federated_id})`);
        return existing || null;
      }

      const action = existing ? 'Refreshed' : 'Created';
      logger.info(`${action} remote user: ${actorUrl}${profileData.banner ? ' (with banner)' : ''}`);
      
      return savedProfile;
    } catch (error) {
      logger.error(`Error fetching remote actor ${actorUrl}:`, error);
      return existing || null;
    }
  }

  /**
   * Process channel message (Harmony server channel message, not regular post)
   */
  private static async processChannelMessage(activity: any, object: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);
    
    // Get server and channel info from the activity
    const serverId = object['harmony:serverId'];
    const channelName = object['harmony:channelName'];
    
    // Extract channel ID from context URL (format: https://domain/servers/{serverId}/channels/{channelId})
    let channelId: string | null = null;
    if (object.context && typeof object.context === 'string') {
      const channelMatch = object.context.match(/\/channels\/([a-f0-9-]{36})/);
      if (channelMatch) {
        channelId = channelMatch[1];
      }
    }

    if (!channelId) {
      logger.error(`Could not extract channel ID from context: ${object.context}`);
      return;
    }

    // Verify the server exists locally (we should have a local reference)
    const { data: server } = await supabase
      .from('servers')
      .select('id, name, is_local_server')
      .eq('id', serverId)
      .maybeSingle();

    if (!server) {
      logger.warn(`Server ${serverId} not found locally, cannot process channel message`);
      return;
    }

    // Ensure author exists
    const author = await this.ensureRemoteUser(actorUrl);
    if (!author) {
      logger.error(`Could not ensure remote user for channel message: ${actorUrl}`);
      return;
    }

    // Check if author is a member of the server
    const { data: membership } = await supabase
      .from('user_servers')
      .select('id')
      .eq('server_id', serverId)
      .eq('user_id', author.id)
      .maybeSingle();

    if (!membership) {
      logger.warn(`Author ${author.username} is not a member of server ${serverId}`);
      return;
    }

    // Extract message UUID from ap_id if it's a Harmony message URL
    let messageId: string | null = null;
    const messageMatch = object.id?.match(/\/messages\/([a-f0-9-]{36})/);
    if (messageMatch) {
      messageId = messageMatch[1];
    } else {
      // Generate a new UUID
      messageId = randomUUID();
    }

    // Parse content - prefer harmony:rawContent for structured content
    let content: any;
    if (object['harmony:rawContent'] && Array.isArray(object['harmony:rawContent'])) {
      content = object['harmony:rawContent'].map((part: any) => {
        if (part.type === 'mention' && part.domain) {
          return { ...part, isLocal: part.domain === config.INSTANCE_DOMAIN };
        }
        return part;
      });
    } else if (typeof object.content === 'string') {
      content = noteToContent(object);
    } else if (Array.isArray(object.content)) {
      content = object.content;
    } else {
      content = [{ type: 'text', text: String(object.content || '') }];
    }

    // Resolve mention userIds from origin-instance UUIDs to local profile UUIDs
    if (Array.isArray(content)) {
      const { resolveMentionUserIds } = await import('../utils/mentionResolver.js');
      content = await resolveMentionUserIds(content);
    }
    
    // Convert remote emojis to URL-based format (like Discord bridge)
    // Remote emoji UUIDs won't exist locally, so we need their URLs instead
    const instanceDomain = new URL(actorUrl).hostname;
    if (Array.isArray(content)) {
      content = content.map((item: any) => {
        if (item.type === 'emoji' && item.emoji) {
          // Convert to URL-based emoji (like Discord bridge format)
          return {
            type: 'emoji',
            emoji: {
              name: item.emoji.name || 'emoji',
              url: item.emoji.url, // Keep the original URL
              domain: instanceDomain, // Mark as remote
              is_remote: true,
            }
          };
        }
        return item;
      });
    }

    // Check if message already exists
    const { data: existingMessage } = await supabase
      .from('messages')
      .select('id')
      .eq('id', messageId)
      .maybeSingle();

    if (existingMessage) {
      logger.debug(`Channel message ${messageId} already exists, skipping`);
      return;
    }

    // Resolve reply_to: the inReplyTo URL contains the remote AP ID or UUID,
    // which may not exist locally. Look up by ap_id in metadata first, then by UUID.
    let resolvedReplyTo: string | null = null;
    if (object.inReplyTo) {
      const { data: parentByApId } = await supabase
        .from('messages')
        .select('id')
        .eq('metadata->>ap_id', object.inReplyTo)
        .maybeSingle();

      if (parentByApId) {
        resolvedReplyTo = parentByApId.id;
      } else {
        const extractedId = extractMessageId(object.inReplyTo);
        if (extractedId) {
          const { data: parentById } = await supabase
            .from('messages')
            .select('id')
            .eq('id', extractedId)
            .maybeSingle();
          if (parentById) {
            resolvedReplyTo = parentById.id;
          }
        }
      }
    }

    // Resolve thread_id from harmony:threadId AP extension
    let resolvedThreadId: string | null = null;
    const threadApIdValue = object['harmony:threadId'];
    if (threadApIdValue) {
      resolvedThreadId = await this.resolveThreadId(supabase, threadApIdValue);
      if (!resolvedThreadId) {
        logger.warn(`Thread not found for AP ID ${threadApIdValue}, will create stub thread after message insert.`);
      }
    }

    const messageMetadata: Record<string, any> = {
      federated: true,
      ap_id: object.id,
      from_domain: new URL(actorUrl).hostname,
    };
    if (threadApIdValue && !resolvedThreadId) {
      messageMetadata.pending_thread_ap_id = threadApIdValue;
    }
    const voiceFromAp = harmonyVoiceMessageFromObject(object);
    if (voiceFromAp) {
      Object.assign(messageMetadata, voiceFromAp);
    }

    const { data: insertedMsg, error: insertError } = await supabase
      .from('messages')
      .insert({
        id: messageId,
        channel_id: channelId,
        user_id: author.id,
        content: content,
        created_at: object.published || new Date().toISOString(),
        updated_at: object.updated || null,
        reply_to: resolvedReplyTo,
        thread_id: resolvedThreadId,
        is_deleted: false,
        federation_status: 'completed',
        encrypted: object['harmony:encrypted'] === true,
        metadata: messageMetadata,
      })
      .select('id, content, metadata')
      .single();

    if (insertError) {
      logger.error(`Failed to create channel message:`, insertError);
      return;
    }

    logger.info(`✅ Created channel message ${messageId} in #${channelName} from ${author.username}`);

    // If message belongs to a thread that doesn't exist yet, create a stub thread
    if (threadApIdValue && !resolvedThreadId && insertedMsg) {
      try {
        const threadUuidMatch = threadApIdValue.match(/\/threads\/([a-f0-9-]{36})/);
        const stubThreadId = threadUuidMatch ? threadUuidMatch[1] : randomUUID();

        // Resolve the correct parent message if provided by the origin
        let parentMessageId = insertedMsg.id; // fallback: use this message
        const parentMessageApId = object['harmony:parentMessageId'];
        if (parentMessageApId) {
          const { data: parentByApId } = await supabase
            .from('messages')
            .select('id')
            .eq('metadata->>ap_id', parentMessageApId)
            .maybeSingle();
          if (parentByApId) {
            parentMessageId = parentByApId.id;
          } else {
            const parentUuidMatch = parentMessageApId.match(/\/messages\/([a-f0-9-]{36})/);
            if (parentUuidMatch) {
              const { data: parentById } = await supabase
                .from('messages')
                .select('id')
                .eq('id', parentUuidMatch[1])
                .maybeSingle();
              if (parentById) parentMessageId = parentById.id;
            }
          }
        }

        let threadName = 'Thread';
        if (Array.isArray(content)) {
          const textPart = content.find((p: any) => p?.type === 'text' && p?.text);
          if (textPart) {
            threadName = String(textPart.text).substring(0, 100);
          }
        } else if (typeof content === 'string') {
          threadName = content.substring(0, 100);
        }

        const { error: stubError } = await supabase
          .from('threads')
          .insert({
            id: stubThreadId,
            channel_id: channelId,
            parent_message_id: parentMessageId,
            name: threadName,
            created_by: author.id,
            ap_id: threadApIdValue,
            federation_status: 'synced',
            message_count: 1,
            member_count: 1,
          });

        if (stubError) {
          if (stubError.code === '23505') {
            // Thread was just created (race condition) - resolve and assign
            resolvedThreadId = stubThreadId;
            logger.info(`🧵 Stub thread ${stubThreadId} already exists (race condition), assigning message`);
          } else {
            logger.warn(`Failed to create stub thread: ${stubError.message}`);
          }
        } else {
          resolvedThreadId = stubThreadId;
          logger.info(`🧵 Created stub thread ${stubThreadId} for AP ID ${threadApIdValue}`);
        }

        // Assign this message (and any other orphans) to the thread
        if (resolvedThreadId) {
          await supabase
            .from('messages')
            .update({ thread_id: resolvedThreadId })
            .eq('id', insertedMsg.id);

          // Also pick up any other orphaned messages with the same pending_thread_ap_id
          const { data: orphans } = await supabase
            .from('messages')
            .select('id')
            .eq('channel_id', channelId)
            .is('thread_id', null)
            .eq('metadata->>pending_thread_ap_id', threadApIdValue)
            .neq('id', insertedMsg.id);

          if (orphans && orphans.length > 0) {
            await supabase
              .from('messages')
              .update({ thread_id: resolvedThreadId })
              .in('id', orphans.map((m: any) => m.id));
            logger.info(`🧵 Assigned ${orphans.length} additional orphaned messages to stub thread ${resolvedThreadId}`);
          }
        }
      } catch (err) {
        logger.warn('Failed to create stub thread from message:', err);
      }
    }

    if (insertedMsg) {
      const { enrichMessageLinkPreviews } = await import('../listeners/DatabaseListener.js');
      enrichMessageLinkPreviews(insertedMsg).catch(err =>
        logger.warn('Link preview enrichment failed for federated channel message:', err)
      );
    }
  }

  /**
   * Resolve a thread ID from an AP URL. Tries ap_id match first, then UUID extraction.
   */
  private static async resolveThreadId(supabase: any, threadApIdValue: string): Promise<string | null> {
    const { data: threadByApId } = await supabase
      .from('threads')
      .select('id')
      .eq('ap_id', threadApIdValue)
      .maybeSingle();

    if (threadByApId) return threadByApId.id;

    const threadIdMatch = threadApIdValue.match(/\/threads\/([a-f0-9-]{36})/);
    if (threadIdMatch) {
      const { data: threadById } = await supabase
        .from('threads')
        .select('id')
        .eq('id', threadIdMatch[1])
        .maybeSingle();
      if (threadById) return threadById.id;
    }

    return null;
  }

  /**
   * Handle direct message (store in messages table instead of posts)
   */
  private static async handleDirectMessage(
    object: any,
    authorId: string,
    content: any[]
  ): Promise<void> {
    const supabase = getSupabaseClient();
    
    // Extract mentioned users (recipients)
    const to = Array.isArray(object.to) ? object.to : [object.to].filter(Boolean);
    const cc = Array.isArray(object.cc) ? object.cc : [object.cc].filter(Boolean);
    const allRecipients = [...to, ...cc];
    
    const resolveResults = await Promise.allSettled(
      allRecipients
        .filter((url): url is string => typeof url === 'string')
        .map(url => resolveProfileByActorUrl(url))
    );
    const recipientIds = resolveResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value != null)
      .map(r => r.value.id);
    
    if (recipientIds.length === 0) {
      logger.warn(`Direct message ${object.id} has no local recipients`);
      return;
    }

    // Decide group vs 1:1 based on sender metadata or recipient count
    const isGroup = object['harmony:conversationType'] === 'group' || recipientIds.length > 1;
    let conversationId: string | null = null;

    if (isGroup) {
      const remoteConvId = object['harmony:conversationId'] || object.context || null;
      const { data: convId, error: convError } = await supabase
        .rpc('get_or_create_federated_group_conversation', {
          p_actor_id: authorId,
          p_local_recipient_ids: recipientIds,
          p_remote_conversation_id: remoteConvId
        });
      if (convError || !convId) {
        logger.error(`Failed to get/create group conversation:`, convError);
        return;
      }
      conversationId = convId;
      logger.info(`Using group conversation ${conversationId} for DM (${recipientIds.length} local recipient(s))`);
    } else {
      const { data: convId, error: convError } = await supabase
        .rpc('get_or_create_dm_conversation', {
          p_user1_id: authorId,
          p_user2_id: recipientIds[0]
        });
      if (convError || !convId) {
        logger.error(`Failed to get/create DM conversation:`, convError);
        return;
      }
      conversationId = convId;
      logger.info(`Using conversation ${conversationId} for DM`);
    };

    // Deduplicate: skip if we already stored a message with this ap_id
    const { data: existing } = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .contains('metadata', { ap_id: object.id })
      .limit(1);

    if (existing && existing.length > 0) {
      logger.info(`⏭️ DM already exists for ${object.id}, skipping duplicate`);
      return;
    }

    const metadata: Record<string, any> = {
      ap_id: object.id,
      from_domain: new URL(object.attributedTo || object.actor).hostname,
      original_url: object.url || object.id,
      published: object.published,
      federated: true,
    };
    if (object.conversation) metadata.conversation = object.conversation;
    if (object.inReplyTo) metadata.in_reply_to_ap = object.inReplyTo;

    const dmTimestamp = object.published || new Date().toISOString();
    const { data: insertedDM, error: messageError } = await supabase
      .from('messages')
      .insert({
        user_id: authorId,
        conversation_id: conversationId,
        content,
        metadata,
        encrypted: object['harmony:encrypted'] === true,
        created_at: dmTimestamp,
        updated_at: object.updated || dmTimestamp,
      })
      .select('id, content, metadata')
      .single();

    if (messageError) {
      logger.error(`Failed to create DM from activity:`, messageError)
    } else {
      logger.info(`✅ Created DM in conversation ${conversationId} from ${object.id}`)
      if (insertedDM) {
        const { enrichMessageLinkPreviews } = await import('../listeners/DatabaseListener.js');
        enrichMessageLinkPreviews(insertedDM).catch(err =>
          logger.warn('Link preview enrichment failed for federated DM:', err)
        );
      }
    }
  }

  /**
   * Handle group invite (remote user added to group) - create conversation + notification
   */
  private static async handleGroupInvite(object: any, authorId: string): Promise<void> {
    const supabase = getSupabaseClient();

    const to = Array.isArray(object.to) ? object.to : [object.to].filter(Boolean);
    const resolveResults = await Promise.allSettled(
      to.filter((url): url is string => typeof url === 'string')
        .map(url => resolveProfileByActorUrl(url))
    );
    const recipientIds = resolveResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value != null)
      .map(r => r.value.id);

    if (recipientIds.length === 0) {
      logger.warn(`Group invite ${object.id} has no local recipients`);
      return;
    }

    const remoteConversationId = object.metadata?.conversation_id || null;

    const { data: conversationId, error: convError } = await supabase.rpc(
      'get_or_create_federated_group_conversation',
      {
        p_actor_id: authorId,
        p_local_recipient_ids: recipientIds,
        p_remote_conversation_id: remoteConversationId,
      }
    );

    if (convError || !conversationId) {
      logger.error('Failed to get/create group for invite:', convError);
      return;
    }

    const { data: inviter } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .eq('id', authorId)
      .single();

    const conversationName = object.metadata?.conversation_name || 'a group conversation';

    for (const userId of recipientIds) {
      const { error: notifError } = await supabase.rpc('send_notification_to_user', {
        notification_type: 'dm',
        to_user_id: userId,
        notification_data: {
          sender: inviter ? {
            user_id: inviter.id,
            username: inviter.username,
            display_name: inviter.display_name || inviter.username,
            avatar_url: inviter.avatar_url
          } : { user_id: authorId, username: 'unknown', display_name: 'Unknown', avatar_url: null },
          conversation: { id: conversationId, name: conversationName },
          conversation_id: conversationId,
          preview: `You were added to ${conversationName}`,
          is_invite: true
        },
        server_id: null,
        channel_id: null,
        conversation_id: conversationId,
        from_user_id: authorId,
        priority: 'normal'
      });
      if (notifError) logger.warn('Failed to create invite notification:', notifError);
    }
    logger.info(`Group invite processed: conversation ${conversationId}, ${recipientIds.length} recipient(s)`);
  }

  /**
   * Handle group conversation Update (name, icon changes from remote instance)
   */
  /**
   * Resolve a remote conversation ID to the local conversation row.
   * Tries direct UUID match first, then falls back to metadata mapping.
   */
  private static async resolveGroupConversation(
    remoteConversationId: string
  ): Promise<{ id: string; type: string; metadata: any } | null> {
    const supabase = getSupabaseClient();

    // 1. Direct ID match (same-instance or lucky UUID collision)
    const { data: direct } = await supabase
      .from('conversations')
      .select('id, type, metadata')
      .eq('id', remoteConversationId)
      .eq('type', 'group')
      .maybeSingle();

    if (direct) return direct;

    // 2. Look up by remote_conversation_id stored in metadata
    const { data: mapped } = await supabase
      .from('conversations')
      .select('id, type, metadata')
      .eq('type', 'group')
      .filter('metadata->>remote_conversation_id', 'eq', remoteConversationId)
      .maybeSingle();

    return mapped || null;
  }

  private static async handleGroupConversationUpdate(activity: any, object: any): Promise<void> {
    const supabase = getSupabaseClient();
    const remoteConversationId = object['harmony:conversationId'];
    const updateType = activity['harmony:updateType'];

    if (!remoteConversationId) {
      logger.warn('Group conversation update missing conversationId');
      return;
    }

    logger.info(`📝 Processing group conversation update: ${updateType} for ${remoteConversationId}`);

    const conversation = await this.resolveGroupConversation(remoteConversationId);

    if (!conversation) {
      logger.warn(`Group conversation not found for remote ID: ${remoteConversationId}`);
      return;
    }

    const localId = conversation.id;

    if (updateType === 'name') {
      const newName = object.name || null;
      await supabase
        .from('conversations')
        .update({ name: newName, updated_at: new Date().toISOString() })
        .eq('id', localId);
      logger.info(`✅ Updated group conversation name: ${newName}`);
    } else if (updateType === 'icon') {
      const iconUrl = object.icon?.url || null;
      if (iconUrl) {
        const currentMetadata = (conversation.metadata as any) || {};
        await supabase
          .from('conversations')
          .update({
            metadata: { ...currentMetadata, icon_url: iconUrl },
            updated_at: new Date().toISOString(),
          })
          .eq('id', localId);
        logger.info(`✅ Updated group conversation icon: ${iconUrl}`);
      }
    } else if (updateType === 'icon_removed') {
      const currentMetadata = (conversation.metadata as any) || {};
      delete currentMetadata.icon_url;

      await supabase
        .from('conversations')
        .update({ metadata: currentMetadata, updated_at: new Date().toISOString() })
        .eq('id', localId);
      logger.info(`✅ Removed group conversation icon`);
    }
  }

  /**
   * Handle group conversation participant removal (from remote instance)
   */
  private static async handleGroupConversationParticipantRemove(activity: any, target: any): Promise<void> {
    const supabase = getSupabaseClient();
    const remoteConversationId = target['harmony:conversationId'];
    const removedUserUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    if (!remoteConversationId || !removedUserUrl) {
      logger.warn('Group participant remove missing conversationId or user URL');
      return;
    }

    logger.info(`👥 Processing group participant removal: ${removedUserUrl} from ${remoteConversationId}`);

    const conversation = await this.resolveGroupConversation(remoteConversationId);
    if (!conversation) {
      logger.warn(`Group conversation not found for remote ID: ${remoteConversationId}`);
      return;
    }

    const { data: removedUser } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', removedUserUrl)
      .maybeSingle();

    if (!removedUser) {
      logger.warn(`User not found for removal: ${removedUserUrl}`);
      return;
    }

    const { error } = await supabase
      .from('conversation_participants')
      .update({ left_at: new Date().toISOString() })
      .eq('conversation_id', conversation.id)
      .eq('user_id', removedUser.id)
      .is('left_at', null);

    if (error) {
      logger.error('Failed to remove participant from group conversation:', error);
    } else {
      logger.info(`✅ Removed ${removedUserUrl} from group conversation ${conversation.id}`);
    }
  }

  /**
   * Determine post visibility from ActivityPub 'to' and 'cc' fields.
   * Delegates to the module-level exported function.
   */
  private static determineVisibility(object: any): string {
    return determineVisibility(object);
  }
}

