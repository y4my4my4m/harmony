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
import { pgrstOrValue } from '../utils/postgrestFilter.js';
import { stripOwnEmojiDomain } from '../utils/emojiResolvers.js';
import { isFavouriteLike, isHeartReaction, storeFavourite } from '../utils/heartReaction.js';
import { fetchAuthoritativeDocument, sameOrigin } from '../utils/apOrigin.js';
import { BlockedInstancesCache } from '../services/BlockedInstancesCache.js';
import { flagComment, flagObjectUris, parseLocalObjectUri } from './flag.js';
import { evaluateInboundCreate } from '../services/FederationSpamGuard.js';
import {
  authorizeChannelWrite,
  resolveThreadInChannel,
  resolveMessageInChannel,
  notAfterNow,
  actorInConversation,
  logDenied,
} from './channelWriteAuthz.js';

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

  // JSON-LD compaction yields `as:Public` or `Public` for the same IRI.
  const isPublic = (v: unknown) =>
    v === 'https://www.w3.org/ns/activitystreams#Public' || v === 'as:Public' || v === 'Public';

  if (to.some(isPublic)) return 'public';
  if (cc.some(isPublic)) return 'unlisted';

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
 * Tries federated_id first; falls back to extracting the username from the
 * instance domain's URL pattern (covers local users whose federated_id was
 * never set).
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

  // 2) Fallback: if the URL matches the instance domain, extract username
  const localPattern = new RegExp(
    `^https?://${config.INSTANCE_DOMAIN.replace(/\./g, '\\.')}/users/([^/]+)$`,
    'i'
  );
  const match = actorUrl.match(localPattern);
  // The path segment is sender-supplied: only a valid username reaches ILIKE
  // (`%`, `*` and `_` are wildcards there). The backfill writes the stored
  // username, and only when federated_id is unset, so `/users/ALICE` cannot
  // rewrite a local user's actor URLs.
  if (match && /^[A-Za-z0-9_]+$/.test(match[1])) {
    const { data: byUsername } = await supabase
      .from('profiles')
      .select('id, username, federated_id')
      .ilike('username', match[1].replace(/_/g, '\\_'))
      .eq('is_local', true)
      .maybeSingle();
    if (byUsername && byUsername.federated_id) {
      return { id: byUsername.id };
    }
    if (byUsername) {
      const username = byUsername.username;
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
   * GET an ActivityPub document; parsed body or null. Retries signed on
   * 401/403 for remotes running authorized fetch. Blocked hosts are never
   * contacted, so a boost, reply or quote cannot import their content.
   */
  private static async fetchApJson(url: string): Promise<any | null> {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (BlockedInstancesCache.isBlocked(host)) {
      logger.info(`Not fetching ${url}: instance is blocked`);
      return null;
    }

    try {
      const response = await SignatureService.fetchApWithSignatureFallback(url, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      if (!response.ok) {
        logger.warn(`AP fetch failed for ${url}: ${response.status}`);
        return null;
      }
      return await response.json();
    } catch (error) {
      logger.warn(`AP fetch error for ${url}:`, error);
      return null;
    }
  }

  /**
   * @param options.skipSpamGuard - set when an admin released a held activity
   *   (job 'release-held-activity'); the mention/DM spam heuristics are not run.
   */
  static async processIncomingActivity(activity: any, options: { skipSpamGuard?: boolean } = {}): Promise<void> {
    const actorUrl = normalizeActor(activity.actor);
    if (actorUrl && await this.isActorSuspended(actorUrl)) {
      logger.info(`Ignoring activity from suspended user: ${actorUrl}`);
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
        await this.processCreate(activity, options);
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
        if (VoiceActivityHandler.isVoiceActivity(activity)) {
          await VoiceActivityHandler.processVoiceActivity(activity);
        } else {
          logger.info(`Unhandled activity type: ${activity.type}`);
        }
    }
  }

  private static async processFollow(activity: any): Promise<void> {
    const { followerUrl, followingUrl } = extractFollowData(activity);
    const supabase = getSupabaseClient();

    await this.ensureRemoteUser(followerUrl);

    // resolveProfileByActorUrl covers local users without federated_id.
    const follower = await resolveProfileByActorUrl(followerUrl);
    const following = await resolveProfileByActorUrl(followingUrl);

    if (!follower || !following) {
      logger.error(`Failed to find users for follow relationship: follower=${!!follower}, following=${!!following} (${followerUrl} → ${followingUrl})`);
      return;
    }

    // Follow-approval preference of the target. With manual approval the
    // request is stored as `pending` and no Accept is emitted; the Accept is
    // sent when the local user approves.
    const { data: followingUser } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', following.id)
      .single();

    // A duplicate Follow from an already-accepted follower must not downgrade
    // the relationship to pending (Mastodon re-sends Follow after migrations);
    // re-accept and resend the Accept instead.
    const { data: existingFollow } = await supabase
      .from('follows')
      .select('status, accepted_at')
      .eq('follower_id', follower.id)
      .eq('following_id', following.id)
      .maybeSingle();
    const alreadyAccepted = existingFollow?.status === 'accepted';

    const requiresApproval = !alreadyAccepted && followingUser?.manually_approves_followers === true;
    const status = requiresApproval ? 'pending' : 'accepted';

    const { error: followError } = await supabase.from('follows').upsert({
      follower_id: follower.id,
      following_id: following.id,
      status,
      ap_id: activity.id,
      is_local: false,
      accepted_at: requiresApproval
        ? null
        : (alreadyAccepted && existingFollow?.accepted_at) || new Date().toISOString(),
    }, {
      onConflict: 'follower_id,following_id'
    }).select();

    if (followError) {
      logger.error('Failed to create follow relationship:', followError);
      return;
    }

    if (requiresApproval) {
      logger.info(`Follow request pending approval: ${followerUrl} → ${followingUrl}`);
      return;
    }

    logger.info(`Follow created and auto-accepted: ${followerUrl} → ${followingUrl}`);

    if (followingUser && followingUser.is_local) {
      const { createAcceptActivity } = await import('./converters/toActivityPub.js');
      const { DeliveryQueue } = await import('./DeliveryQueue.js');

      const acceptActivity = createAcceptActivity(followingUser, activity);

      const { data: followerUser } = await supabase
        .from('profiles')
        .select('inbox_url')
        .eq('id', follower.id)
        .single();

      if (followerUser?.inbox_url) {
        await DeliveryQueue.sendToInbox(followerUser.inbox_url, acceptActivity, followingUser.id);
        logger.info(`Sent Accept activity to ${followerUrl}`);
      }
    }
  }

  /**
   * The follows row an Accept/Reject refers to. The responder must be the
   * followee. Lookup is by Follow id, then by the (follower, followee) pair:
   * the id on an outbound Follow is not the id the client stores on the row.
   */
  private static async findFollowForResponse(
    followObject: any,
    responderUrl: string,
  ): Promise<{ id: string } | null> {
    const supabase = getSupabaseClient();
    const followee = await resolveProfileByActorUrl(responderUrl);
    if (!followee) return null;

    const followId = typeof followObject === 'string' ? followObject : followObject?.id;
    if (typeof followId === 'string' && followId) {
      const { data: byId } = await supabase
        .from('follows')
        .select('id')
        .eq('ap_id', followId)
        .eq('following_id', followee.id)
        .maybeSingle();
      if (byId) return byId;
    }

    if (typeof followObject !== 'object' || !followObject?.actor) return null;
    const targetUrl = followObject.object ? normalizeActor(followObject.object) : responderUrl;
    if (!targetUrl || !SignatureService.verifyActorMatch(targetUrl, responderUrl)) return null;

    const follower = await resolveProfileByActorUrl(normalizeActor(followObject.actor));
    if (!follower) return null;

    const { data: byPair } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_id', follower.id)
      .eq('following_id', followee.id)
      .maybeSingle();
    return byPair ?? null;
  }

  private static async processAccept(activity: any): Promise<void> {
    const supabase = getSupabaseClient();

    if (!activity.object) return;

    if (typeof activity.object === 'string' || activity.object.type === 'Follow') {
      const responderUrl = normalizeActor(activity.actor);
      const follow = await this.findFollowForResponse(activity.object, responderUrl);
      if (!follow) {
        logger.warn(`Accept(Follow) from ${responderUrl} matches no follow it is the target of`);
        return;
      }

      await supabase
        .from('follows')
        .update({ status: 'accepted', accepted_at: new Date().toISOString() })
        .eq('id', follow.id);

      logger.info(`Follow accepted by ${responderUrl}: ${follow.id}`);
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
        return;
      }
      logger.info(`Join accepted for user ${userProfile.id} in server ${server.id}`);

      // A private Group lists channels and members only to members; the
      // reference was built from the stub a non-member is served.
      void (async () => {
        const { ServerDiscoveryService } = await import('../services/ServerDiscoveryService.js');
        await ServerDiscoveryService.syncRemoteServer(server.id, { asUserId: userProfile.id });
        const { data: synced } = await supabase
          .from('servers')
          .select('ap_id, federation_metadata')
          .eq('id', server.id)
          .maybeSingle();
        const membersUrl = synced?.federation_metadata?.members;
        if (typeof membersUrl === 'string' && synced?.ap_id) {
          await ServerDiscoveryService.syncRemoteServerMembers(server.id, membersUrl, {
            signAs: userProfile.id,
            serverApId: synced.ap_id,
          });
        }
      })().catch(err => logger.warn(`Accept(Join): sync of server ${server.id} failed:`, err));
    }
  }

  private static async processReject(activity: any): Promise<void> {
    const supabase = getSupabaseClient();

    if (!activity.object) return;

    if (typeof activity.object === 'string' || activity.object.type === 'Follow') {
      const responderUrl = normalizeActor(activity.actor);
      const follow = await this.findFollowForResponse(activity.object, responderUrl);
      if (!follow) {
        logger.warn(`Reject(Follow) from ${responderUrl} matches no follow it is the target of`);
        return;
      }

      await supabase
        .from('follows')
        .delete()
        .eq('id', follow.id);

      logger.info(`Follow rejected by ${responderUrl}: ${follow.id}`);
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
        logger.info(`Join rejected for user ${userProfile.id} in server ${server.id}`);
      }
    }
  }

  /**
   * Create activity: post, DM, channel message, or poll.
   */
  private static async processCreate(activity: any, options: { skipSpamGuard?: boolean } = {}): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();

    logger.info(`processCreate: object.type=${object?.type}, id=${object?.id?.substring?.(0, 80)}`);

    // Question is a poll; stored as a post carrying poll metadata.
    if (object.type === 'Question') {
      if (!sameOrigin(object.id, normalizeActor(activity.actor))) {
        logger.warn(`Create rejected: poll ${object.id} is not on the host of actor ${normalizeActor(activity.actor)}`);
        return;
      }
      logger.info(`Processing poll: ${object.id}`);
      await this.processCreatePoll(activity, object);
      return;
    }

    if (object.type === 'ChatThread') {
      logger.info(`Routing Create ChatThread to handler: ${object.id}`);
      const { handleThreadActivity } = await import('./ThreadActivityHandler.js');
      const result = await handleThreadActivity({ ...activity, object });
      if (!result.success) {
        logger.warn(`Thread Create failed: ${result.error}`);
      }
      return;
    }

    if (object.type === 'Note' || object.type === 'Article') {
      // Drop posts originating from this instance echoed back by a peer.
      const ownDomain = config.INSTANCE_DOMAIN;
      if (object.id && typeof object.id === 'string') {
        try {
          const objectHost = new URL(object.id).hostname;
          if (objectHost === ownDomain) {
            logger.info(`Ignoring own post echoed back: ${object.id}`);
            return;
          }
        } catch { /* not a valid URL, continue */ }
      }

      // The actor's host is authoritative only for objects on that host. A
      // foreign id would squat another server's post: its real Create is
      // later dropped as a duplicate.
      if (!sameOrigin(object.id, normalizeActor(activity.actor))) {
        logger.warn(`Create rejected: object ${object.id} is not on the host of actor ${normalizeActor(activity.actor)}`);
        return;
      }

      const harmonyServerId = object['harmony:serverId'];
      const harmonyChannelName = object['harmony:channelName'];
      
      if (harmonyServerId) {
        logger.info(`Detected channel message for server ${harmonyServerId}, channel: ${harmonyChannelName}`);
        await this.processChannelMessage(activity, object);
        return;
      }

      await this.ensureRemoteUser(normalizeActor(activity.actor));

      const author = await resolveProfileByActorUrl(normalizeActor(activity.actor));

      if (!author) {
        logger.error('Failed to find author for post');
        return;
      }

      const rawContent = noteToContent(object);
      
      // Quote target: `quoteUrl` is the Fediverse form, `_misskey_quote` Misskey's.
      const quoteUrl = object.quoteUrl || object._misskey_quote;
      
      logger.info('Processing ActivityPub Note: ' + JSON.stringify({
        id: object.id,
        inReplyTo: object.inReplyTo,
        quoteUrl: quoteUrl,
        contentPreview: object.content?.substring(0, 100)
      }));
      
      const content = rawContent;

      const visibility = this.determineVisibility(object);

      // Group invite notification, sent when a remote user is added to a group.
      if (object.metadata?.type === 'group_invite') {
        await this.handleGroupInvite(object, author.id);
        return;
      }

      // Direct messages go to `messages`; everything else to `posts`.
      if (visibility === 'direct' || visibility === 'private') {
        await this.handleDirectMessage(object, author.id, content, activity, options);
      } else {
        if (!options.skipSpamGuard) {
          const mentionedLocalIds = await this.localMentionTargets(content, author.id);
          if (mentionedLocalIds.length > 0) {
            const verdict = await evaluateInboundCreate({
              activity,
              object,
              authorId: author.id,
              authorUri: normalizeActor(activity.actor),
              kind: 'federation_mention',
              targetIds: mentionedLocalIds,
            });
            if (verdict.action === 'hold' || verdict.action === 'reject') {
              logger.info(`Post ${object.id} ${verdict.action === 'hold' ? 'held' : 'rejected'} as suspected spam`);
              return;
            }
          }
        }

        // Reply threading: fetch missing parents and locate the conversation root.
        let parentPostId: string | null = null;
        let conversationRootId: string | null = null;

        if (object.inReplyTo) {
          const replyResult = await this.resolveReplyChain(object.inReplyTo);
          parentPostId = replyResult.parentPostId;
          conversationRootId = replyResult.conversationRootId;
        }

        let quotedPostData: any = null;
        if (quoteUrl) {
          logger.info(`Processing quote post, quoted URL: ${quoteUrl}`);
          quotedPostData = await this.resolveQuotedPost(quoteUrl);
        }

        const metadata: any = {};
        if (object.inReplyTo) {
          metadata.in_reply_to_ap_url = object.inReplyTo;
        }
        if (quotedPostData) {
          metadata.is_quote = true;
          metadata.reblog_of = quotedPostData.id;
          metadata.quote_ap_url = quoteUrl;
        }

        // `in_reply_to` is a UUID column holding the parent post id.
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

        if (quotedPostData) {
          postData.reblog = {
            id: quotedPostData.id,
            content: quotedPostData.content,
            created_at: quotedPostData.created_at,
            visibility: quotedPostData.visibility,
          };
          
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
          logger.info(`Post already exists for ${object.id}, skipping duplicate`);
          return;
        }

        const { data: insertedPost, error } = await supabase.from('posts').insert(postData).select('id, author_id, content, metadata, conversation_root_id').maybeSingle();

        if (error) {
          if ((error as { code?: string }).code === '23505') {
            logger.info(`Post ${object.id} lost insert race (already exists), skipping duplicate`);
            return;
          }
          logger.error('Failed to create post from activity:', error);
        } else {
          const postType = quotedPostData ? 'quote post' : 'post';
          logger.info(`Created ${postType} from ${object.id}${parentPostId ? ` (reply to ${parentPostId})` : ''}${quotedPostData ? ` (quoting ${quotedPostData.id})` : ''}`);

          if (insertedPost) {
            // Re-link orphan replies that arrived before this parent and were
            // stamped with metadata.in_reply_to_ap_url = object.id. `object.url`
            // is passed too so orphans stamped with the alternate URL form match.
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
   * Resolve a quoted post, fetching from the origin instance if not stored locally.
   */
  private static async resolveQuotedPost(quoteUrl: string): Promise<any | null> {
    const supabase = getSupabaseClient();

    const { data: existingPost } = await supabase
      .from('posts')
      .select('id, content, created_at, visibility, author_id')
      .eq('ap_id', quoteUrl)
      .maybeSingle();

    if (existingPost) {
      logger.info(`Found quoted post locally: ${existingPost.id}`);
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
          logger.info(`Found quoted post by UUID: ${postById.id}`);
          return postById;
        }
      }
    }

    logger.info(`Fetching quoted post from remote: ${quoteUrl}`);
    const fetchedPost = await this.fetchAndCreateRemotePost(quoteUrl);
    
    if (fetchedPost) {
      logger.info(`Created quoted post from remote: ${fetchedPost.id}`);
    }
    
    return fetchedPost;
  }

  /**
   * Walk a reply chain: fetch missing parent posts and locate the conversation root.
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
        logger.info(`Parent post not found locally, fetching: ${inReplyToRef}`);
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
   * A child reply can arrive (via inbox or /resolve-post) before its parent.
   * `metadata.in_reply_to_ap_url` is stamped so the link is not lost, but the
   * child stays orphaned in the thread RPC until the parent exists. Called on
   * every post import and lookup, so the thread heals once the parent lands.
   */
  private static async relinkPendingChildren(
    parentApId: string,
    parentLocalId: string,
    parentConversationRootId: string | null,
    parentApUrl?: string | null,
  ): Promise<void> {
    if (!parentLocalId) return;
    const supabase = getSupabaseClient();

    // Match orphans against every known URL form for this post: Mastodon
    // canonical id (`/users/x/statuses/N`), pretty url (`/@x/N`), GoToSocial
    // (`/users/x/statuses/N` ↔ `/@x/statuses/N`), Pleroma `/objects/UUID`.
    // Each surfaces in different `inReplyTo` payloads, so an orphan may hold
    // any of them. PostgREST `.or()` ORs several jsonb-arrow comparisons in
    // one query.
    const candidateUrls = Array.from(
      new Set(
        [parentApId, parentApUrl ?? undefined].filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        ),
      ),
    );
    if (candidateUrls.length === 0) return;

    const orFilter = candidateUrls
      .map((u) => `metadata->>in_reply_to_ap_url.eq.${pgrstOrValue(u)}`)
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

    // Conversation root: the parent's root if known, else the parent itself
    // (matches `resolveReplyChain`'s convention).
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
    logger.info(`Re-linked ${orphans.length} orphan reply(s) → parent ${parentLocalId} (${parentApId})`);
  }

  /**
   * Fetch a remote post and create it locally.
   *
   * If the post is a reply, the parent chain is walked recursively (sharing
   * the depth budget with `resolveReplyChain`) so the imported post lands
   * with `in_reply_to` and `conversation_root_id` populated, and any missing
   * ancestors are imported alongside it. Without the walk, /resolve-post on a
   * federated reply leaves a floating post and the local thread RPC has
   * nothing to traverse.
   *
   * Whether freshly imported or already cached, orphaned local replies whose
   * `metadata.in_reply_to_ap_url` points at this post's ap_id are re-linked.
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
        .or(`ap_id.eq.${pgrstOrValue(postUrl)},url.eq.${pgrstOrValue(postUrl)}`)
        .eq('is_deleted', false)
        .limit(1)
        .maybeSingle();

      if (existing) {
        logger.info(`Post already exists for ${postUrl} → ${existing.id}, skipping fetch`);
        // Re-link orphan replies that arrived before this post was stored.
        // Both the canonical ap_id and the alternate url are passed so an
        // orphan stamped with either form matches.
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
      // influenced); fetchApJson goes through safeFetch.
      const remoteObject = await fetchAuthoritativeDocument(postUrl, (u) => this.fetchApJson(u));
      if (!remoteObject) {
        logger.warn(`Failed to fetch remote post ${postUrl}`);
        return null;
      }

      // Only handle Note/Article types
      if (remoteObject.type !== 'Note' && remoteObject.type !== 'Article') {
        logger.warn(`Remote object is not a Note/Article: ${remoteObject.type}`);
        return null;
      }

      // Deduplicate by the canonical AP id; it may differ from the fetched URL.
      const apId = remoteObject.id;
      const apUrl = remoteObject.url || apId;
      if (apId !== postUrl || apUrl !== postUrl) {
        const { data: existingByApId } = await supabase
          .from('posts')
          .select('id, in_reply_to, conversation_root_id')
          .or(`ap_id.eq.${pgrstOrValue(apId)},url.eq.${pgrstOrValue(apUrl)}`)
          .eq('is_deleted', false)
          .limit(1)
          .maybeSingle();

        if (existingByApId) {
          logger.info(`Post already exists for AP id ${apId} → ${existingByApId.id}, skipping create`);
          await this.relinkPendingChildren(
            apId,
            existingByApId.id,
            existingByApId.conversation_root_id,
            apUrl,
          );
          return existingByApId;
        }
      }

      const authorUrl = normalizeActor(remoteObject.attributedTo || remoteObject.actor);
      if (!sameOrigin(authorUrl, apId)) {
        logger.warn(`Remote post ${apId} attributed to ${authorUrl} on another host, skipping`);
        return null;
      }
      await this.ensureRemoteUser(authorUrl);

      const { data: author } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', authorUrl)
        .single();

      if (!author) {
        logger.warn(`Could not find/create author for remote post`);
        return null;
      }

      const content = noteToContent(remoteObject);
      const visibility = this.determineVisibility(remoteObject);

      // Walk the reply chain so the imported post lands with `in_reply_to`
      // and `conversation_root_id` set, and missing ancestors are imported
      // alongside it. `depth` is shared with the caller so the mutually
      // recursive walk stops at MAX_DEPTH overall, not per frame.
      let resolvedInReplyTo: string | null = null;
      let conversationRootId: string | null = null;
      if (remoteObject.inReplyTo) {
        const replyResult = await this.resolveReplyChain(remoteObject.inReplyTo, depth);
        resolvedInReplyTo = replyResult.parentPostId;
        conversationRootId = replyResult.conversationRootId;
      }

      // The parent AP url is always stamped in metadata, even when resolution
      // failed (parent server unreachable). The client-side ancestor walker
      // retries from this hint.
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
        // 23505: unique violation from a concurrent insert of the same ap_id.
        if (error.code === '23505') {
          const { data: raced } = await supabase
            .from('posts')
            .select('id, in_reply_to, conversation_root_id')
            .eq('ap_id', apId)
            .maybeSingle();
          if (raced) {
            logger.info(`Concurrent insert resolved for ${apId} → ${raced.id}`);
            await this.relinkPendingChildren(apId, raced.id, raced.conversation_root_id, apUrl);
            return raced;
          }
        }
        logger.error('Failed to create remote post:', error);
        return null;
      }

      logger.info(`Fetched and created remote post: ${apId}`);

      // Re-link orphan replies that were waiting for this post.
      if (newPost) {
        await this.relinkPendingChildren(apId, newPost.id, newPost.conversation_root_id, apUrl);
      }

      // Link previews are enriched out of band; failures do not block import.
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
   * Update activity: profile update or post edit.
   *
   * Every branch verifies `activity.actor` owns the object being modified
   * before writing. Without the guard a remote signer can Update another
   * actor's profile or edit any post by URL (BUGS.md C2).
   */
  private static async processUpdate(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);

    // Bot accounts are `Service` (Mastodon) or `Application`; Group is a
    // Harmony server and handled below.
    if (['Person', 'Service', 'Application', 'Organization'].includes(object.type)) {
      // The object is the actor being updated; the signer must equal it.
      if (!SignatureService.verifyActorMatch(actorUrl, object.id || '')) {
        logger.warn(
          `🚫 Update Person rejected: actor ${actorUrl} cannot update ${object.id}`,
        );
        return;
      }

      const profileData = actorToProfile(object);

      const updateData: any = {
        display_name: profileData.display_name,
        bio: profileData.bio,
        avatar_url: profileData.avatar,
        banner_url: profileData.banner,
        public_key: profileData.public_key,
      };

      if (profileData.custom_status) {
        updateData.custom_status = profileData.custom_status;
      }

      if (profileData.profile_fields) {
        updateData.profile_fields = profileData.profile_fields;
      }

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
      logger.info(`Processing post edit: ${object.id}`);
      
      // Existing post plus author actor URL (joined via profiles.federated_id),
      // needed to verify the editor owns the post.
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

      const content = noteToContent(object);
      
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
        logger.info(`Updated post: ${object.id}`);
      }
    } else if (object.type === 'ChatThread') {
      logger.info(`Routing Update ChatThread to handler: ${object.id}`);
      const { handleThreadActivity } = await import('./ThreadActivityHandler.js');
      const result = await handleThreadActivity({ ...activity, object });
      if (!result.success) {
        logger.warn(`Thread Update failed: ${result.error}`);
      }
    } else if (object['harmony:type'] === 'harmony:GroupConversation') {
      await this.handleGroupConversationUpdate(activity, object);
    } else if (['harmony:TextChannel', 'harmony:VoiceChannel', 'harmony:Category'].includes(object.type)) {
      await this.processHarmonyChannelUpdate(activity, object);
    } else if (object.type === 'Group' || object['harmony:ChatServer']) {
      logger.info(`Processing server update: ${object.id}`);
      
      const serverIdMatch = object.id?.match(/\/servers\/([a-f0-9-]{36})$/i);
      if (!serverIdMatch) {
        logger.warn(`Cannot extract server ID from ap_id: ${object.id}`);
        return;
      }
      
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
      
      const updateData: any = {
        updated_at: new Date().toISOString(),
      };
      
      if (object.name) {
        updateData.name = object.name;
      }
      if (object.summary !== undefined) {
        updateData.description = object.summary;
      }
      if (object.icon?.url) {
        updateData.icon = object.icon.url;
      }
      
      const { error: updateError } = await supabase
        .from('servers')
        .update(updateData)
        .eq('id', existingServer.id);
      
      if (updateError) {
        logger.error(`Failed to update server ${existingServer.id}:`, updateError);
      } else {
        logger.info(`Updated remote server: ${object.name || existingServer.id}`);
      }
    }
  }

  /**
   * Delete activity.
   *
   * Verifies `activity.actor` owns the object before soft-deleting. Without
   * the guard any signed remote actor can delete any post or message by URL
   * (BUGS.md C2).
   */
  private static async processDelete(activity: any): Promise<void> {
    const object = activity.object;
    if (object && typeof object === 'object' && object.type === 'ChatThread') {
      logger.info(`Routing Delete ChatThread to handler: ${object.id}`);
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

    // Look up the post and check the deleting actor is the author. Post and
    // message are handled independently so a Delete targeting one does not
    // fail open on the other.
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
   * Like activity, including emoji reactions.
   */
  private static async processLike(activity: any): Promise<void> {
    const { actorUrl, objectUrl, emoji, emojiUrl, emojiName } = extractLikeData(activity);
    const supabase = getSupabaseClient();
    
    logger.info(`Extracted Like data: emoji="${emoji}", emojiUrl="${emojiUrl}", emojiName="${emojiName}"`);

    await this.ensureRemoteUser(actorUrl);

    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!user) {
      logger.error('Failed to find user for like');
      return;
    }

    let post = null;
    let message = null;
    
    // Message (DM) reaction lookup, method 1: local message URL with UUID.
    if (objectUrl.includes('/messages/')) {
      const uuidMatch = objectUrl.match(/\/messages\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const messageId = uuidMatch[1];
        const { data: messageById } = await supabase
          .from('messages')
          .select('id, conversation_id, channel_id')
          .eq('id', messageId)
          .maybeSingle();
        message = messageById;
        
        if (message) {
          logger.info(`Found message for reaction by local ID: ${messageId}`);
        }
      }
    }
    
    // Method 2: by ap_id in metadata, for remote DMs. Covers a remote user
    // reacting to a message they themselves sent to this instance.
    if (!message) {
      const { data: messageByApId } = await supabase
        .from('messages')
        .select('id, conversation_id, channel_id')
        .eq('metadata->>ap_id', objectUrl)
        .maybeSingle();
      
      if (messageByApId) {
        message = messageByApId;
        logger.info(`Found message for reaction by ap_id: ${objectUrl}`);
      }
    }
    
    // Not a message: resolve as a post instead.
    if (!message) {
      // Method 1: by ap_id.
      const { data: postByApId } = await supabase
        .from('posts')
        .select('id')
        .eq('ap_id', objectUrl)
        .maybeSingle();
      
      post = postByApId;
      
      // Method 2: UUID extracted from the URL.
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

    if (message) {
      // A channel reaction carries the channel's write rules; a DM reaction
      // comes from a participant.
      if (message.channel_id) {
        const { data: channel } = await supabase
          .from('channels')
          .select('server_id')
          .eq('id', message.channel_id)
          .maybeSingle();
        const authz = channel
          ? await authorizeChannelWrite(supabase, {
              actorUrl, serverId: channel.server_id, channelId: message.channel_id, kind: 'reaction',
            })
          : { ok: false as const, reason: 'channel not found' };
        if (!authz.ok) {
          logDenied('reaction', actorUrl, authz.reason);
          return;
        }
      } else if (!message.conversation_id || !(await actorInConversation(supabase, message.conversation_id, user.id))) {
        logDenied('reaction', actorUrl, 'not a participant of the conversation');
        return;
      }

      const isCustomEmoji = !!(emojiUrl && emojiName);
      const reactionData: any = {
        message_id: message.id,
        user_id: user.id,
        metadata: { federated: true, from_domain: new URL(actorUrl).hostname },
      };

      if (isCustomEmoji) {
        // Image-backed custom emoji resolve to a row in `emojis`.
        const emojiId = await this.resolveInboundEmojiId(
          supabase, emojiName, emojiUrl, user.id,
        );
        if (!emojiId) {
          logger.error('Could not find or create emoji for message reaction');
          return;
        }
        reactionData.emoji_id = emojiId;
      } else {
        // Unicode emoji: stored as custom_emoji_content with a null emoji_id,
        // matching local reactions so grouping is consistent.
        let normalizedEmoji = emoji || '❤️';
        if (normalizedEmoji === '❤') normalizedEmoji = '❤️';
        reactionData.emoji_id = null;
        reactionData.custom_emoji_content = normalizedEmoji;
      }

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
        logger.info(`Reaction already exists for user ${user.id} on message ${message.id}`);
        return;
      }

      // Store the AP activity ID for traceability
      reactionData.metadata = { ...reactionData.metadata, ap_id: activity.id };

      const { error: reactionError } = await supabase.from('reactions').insert(reactionData);

      if (reactionError) {
        // 23505: unique violation from a concurrent insert.
        if (reactionError.code === '23505') {
          logger.info(`Reaction already exists (constraint): ${reactionError.message}`);
        } else {
          logger.error('Failed to insert message reaction:', reactionError);
        }
      } else {
        logger.info(`Added reaction to message ${message.id}: ${emoji || ''}`);
      }
      return;
    }

    if (post) {
      // Mastodon Like, Misskey default like, heart EmojiReact: one favourite per actor.
      if (isFavouriteLike({ emoji, emojiUrl, emojiName })) {
        const outcome = await storeFavourite(supabase, post.id, user.id);
        if (outcome === 'failed') {
          logger.error(`Failed to insert favourite on post ${post.id} from ${actorUrl}`);
        } else {
          logger.info(`Favourite on post ${post.id} from ${actorUrl}: ${outcome}`);
        }
        return;
      }

      // Only image-backed custom emoji resolve to an emoji_id; unicode reactions
      // are grouped purely by custom_emoji_content (matches local behavior and
      // avoids creating url-less rows in the emojis table).
      const isCustomEmoji = !!(emojiUrl && emojiName);
      const emojiId = isCustomEmoji
        ? await this.resolveInboundEmojiId(supabase, emojiName, emojiUrl, user.id)
        : null;

      // Not a favourite, so either a unicode emoji or an Emoji tag is present.
      const reactionContent = emoji ?? `:${emojiName!.replace(/:/g, '')}:`;
      // A reaction emitted here returns qualified with our own domain, which the duplicate
      // check below compares literally against the `:name:` already stored.
      const normalizedEmoji = stripOwnEmojiDomain(reactionContent) ?? reactionContent;
      
      logger.info(`Inserting reaction: emoji_id=${emojiId}, custom_content=${normalizedEmoji}`);
      
      // Duplicate check matches user + post + specific emoji, so one user can
      // hold several distinct reactions on a post.
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
        logger.info(`Reaction already exists for user ${user.id} on post ${post.id}`);
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
        logger.error('Failed to insert reaction:', interactionError);
      } else {
        logger.info(`Added reaction to post ${post.id}: ${normalizedEmoji}${emojiUrl ? ` with URL: ${emojiUrl}` : ' (no URL)'}`);
      }
    } else {
      logger.warn(`Post or message not found for like: ${objectUrl}`);
    }
  }

  /**
   * Announce activity: reblog/boost.
   */
  private static async processAnnounce(activity: any): Promise<void> {
    const { actorUrl, objectUrl, published } = extractAnnounceData(activity);
    const supabase = getSupabaseClient();

    logger.info(`Processing Announce: ${actorUrl} reblogged ${objectUrl}`);

    await this.ensureRemoteUser(actorUrl);

    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!user) {
      logger.error('Failed to find user for announce');
      return;
    }

    let originalPost: any = null;
    
    const originalPostColumns = 'id, content, visibility, author_id, created_at, ap_id, is_sensitive, content_warning, favorites_count, replies_count, reblogs_count, media_attachments, url';

    // Original post lookup, method 1: by ap_id.
    const { data: postByApId } = await supabase
      .from('posts')
      .select(originalPostColumns)
      .eq('ap_id', objectUrl)
      .maybeSingle();
    
    originalPost = postByApId;
    
    // Method 2: UUID extracted from the URL. Both /posts/{uuid} and
    // /activities/{uuid} forms are accepted.
    if (!originalPost) {
      const uuidMatch = objectUrl.match(/\/(?:posts|activities)\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const postId = uuidMatch[1];
        logger.info(`Trying to find post by UUID: ${postId}`);
        const { data: postById } = await supabase
          .from('posts')
          .select(originalPostColumns)
          .eq('id', postId)
          .maybeSingle();
        originalPost = postById;
        if (postById) {
          logger.info(`Found post by UUID: ${postId}`);
        }
      }
    }

    // Method 3: fetch the post from its origin instance and import it.
    if (!originalPost) {
      logger.info(`Original post not found locally, attempting to fetch: ${objectUrl}`);
      try {
        // BUGS.md H15: objectUrl is from inbox payload (attacker-influenced).
        const remotePost = await fetchAuthoritativeDocument(objectUrl, (u) => this.fetchApJson(u));

        if (remotePost) {
          const authorUrl = normalizeActor(remotePost.attributedTo || remotePost.actor);
          if ((remotePost.type === 'Note' || remotePost.type === 'Article') && sameOrigin(authorUrl, remotePost.id)) {
            await this.ensureRemoteUser(authorUrl);
            
            const { data: author } = await supabase
              .from('profiles')
              .select('id')
              .eq('federated_id', authorUrl)
              .single();
            
            if (author) {
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

    // Deduplicate by the Announce activity id.
    const { data: existingReblog } = await supabase
      .from('posts')
      .select('id')
      .eq('ap_id', activity.id)
      .maybeSingle();
    
    if (existingReblog) {
      logger.info(`Reblog already exists: ${activity.id}`);
      return;
    }

    const { data: originalAuthor } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain, is_local')
      .eq('id', originalPost.author_id)
      .single();

    const { error: insertError } = await supabase.from('posts').insert({
      ap_id: activity.id,
      author_id: user.id,
      content: [], // Reblogs carry no content of their own
      visibility: 'public',
      is_local: false,
      is_federated: true,
      ap_type: 'Announce',
      // posts_content_not_empty requires content or reblog to be non-null.
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
      const { error: interactionError } = await supabase.from('post_interactions').insert({
        user_id: user.id,
        post_id: originalPost.id,
        interaction_type: 'reblog',
        ap_id: activity.id,
        is_local: false,
      });
      if (interactionError) {
        logger.warn('Failed to create reblog interaction:', interactionError);
      }

      // reblogs_count follows from the post_interactions row above, through
      // update_post_reaction_counts. An increment_post_reblogs RPC was also
      // called here; it exists in no schema, so the call always fell into its
      // catch, and adding the function would have double-counted.

      logger.info(`Created reblog of ${originalPost.id} by ${user.id}`);
    }
  }

  /**
   * Undo of Follow, Like/EmojiReaction or Announce.
   *
   * The undone activity's actor must be the signer. InboxHandler binds
   * `activity.actor` to the signing key; the embedded or stored inner
   * activity carries its own `actor`, which is sender-chosen.
   */
  private static async processUndo(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();
    const signerUrl = normalizeActor(activity.actor);

    logger.info(`Processing Undo activity from ${signerUrl}`);
    logger.debug(`Undo object: ${JSON.stringify(object)?.substring(0, 500)}`);

    if (!object) {
      logger.warn('Undo activity has no object, skipping');
      return;
    }

    // A bare id refers to an activity stored by the inbox; type and actor
    // come from that row.
    if (typeof object === 'string') {
      logger.info(`Undo object is a string ID: ${object}`);
      const { data: originalActivity } = await supabase
        .from('ap_activities')
        .select('ap_type, activity_data, actor_ap_id')
        .eq('ap_id', object)
        .maybeSingle();

      if (!originalActivity) {
        logger.warn(`Could not find original activity: ${object}`);
        return;
      }

      const storedActor = originalActivity.activity_data?.actor;
      const originalActor = originalActivity.actor_ap_id
        || (storedActor ? normalizeActor(storedActor) : null);
      if (!originalActor || !SignatureService.verifyActorMatch(signerUrl, originalActor)) {
        logger.warn(`Undo rejected: ${signerUrl} is not the actor of ${object} (${originalActor ?? 'unknown'})`);
        return;
      }

      logger.info(`Found original activity type: ${originalActivity.ap_type}`);
      await this.processUndoByType(originalActivity.ap_type, originalActivity.activity_data, signerUrl);
      return;
    }

    const innerActor = object.actor ? normalizeActor(object.actor) : signerUrl;
    if (!innerActor || !SignatureService.verifyActorMatch(signerUrl, innerActor)) {
      logger.warn(`Undo rejected: ${signerUrl} cannot undo an activity by ${innerActor ?? 'unknown'}`);
      return;
    }

    await this.processUndoByType(object.type, object, signerUrl);
  }

  /**
   * Undo of Like/EmojiReaction. Handles both posts and messages/DMs.
   * `actorUrl` is the verified signer; the reaction removed is theirs.
   */
  private static async processUndoReaction(object: any, actorUrl: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { objectUrl, emoji, emojiUrl, emojiName } = extractLikeData({ ...object, actor: actorUrl });
    const likeActorUrl = actorUrl;

    logger.info(`Undoing reaction from ${likeActorUrl} on ${objectUrl}`);

    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', likeActorUrl)
      .single();

    if (!user) {
      logger.warn(`User not found for Undo reaction: ${likeActorUrl}`);
      return;
    }

    // An actor holds one row per distinct emoji, so the Undo removes only the
    // rows carrying the emoji it names.
    const matchesUndo = await this.buildReactionUndoMatcher(supabase, emoji, emojiUrl, emojiName);

    if (objectUrl.includes('/messages/')) {
      const uuidMatch = objectUrl.match(/\/messages\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const messageId = uuidMatch[1];
        logger.info(`Undoing message reaction on ${messageId}`);

        const { data: rows, error: readError } = await supabase
          .from('reactions')
          .select('id, emoji_id, custom_emoji_content')
          .eq('user_id', user.id)
          .eq('message_id', messageId);

        if (readError) {
          logger.error(`Failed to read message reactions for Undo:`, readError);
          return;
        }

        const doomed = (rows ?? []).filter(matchesUndo).map((row: any) => row.id);
        if (doomed.length === 0) {
          logger.info(`No matching message reaction to undo on ${objectUrl}`);
          return;
        }

        const { error } = await supabase
          .from('reactions')
          .delete()
          .in('id', doomed);

        if (error) {
          logger.error(`Failed to delete message reaction:`, error);
        } else {
          logger.info(`Undid message reaction on ${objectUrl} (deleted ${doomed.length} records)`);
        }
      }
      return;
    }

    let post = null;
    
    // Try by ap_id first
    const { data: postByApId } = await supabase
      .from('posts')
      .select('id')
      .eq('ap_id', objectUrl)
      .maybeSingle();
    
    post = postByApId;
    
    // Fallback: UUID extracted from the URL, for local posts.
    if (!post && objectUrl.includes('/posts/')) {
      const uuidMatch = objectUrl.match(/\/posts\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        logger.info(`Trying to find local post by UUID: ${uuidMatch[1]}`);
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

    const { data: rows, error: readError } = await supabase
      .from('post_interactions')
      .select('id, interaction_type, emoji_id, custom_emoji_content')
      .eq('user_id', user.id)
      .eq('post_id', post.id)
      .in('interaction_type', ['favorite', 'emoji_reaction']);

    if (readError) {
      logger.error(`Failed to read reactions for Undo:`, readError);
      return;
    }

    const doomed = (rows ?? []).filter(matchesUndo).map((row: any) => row.id);
    if (doomed.length === 0) {
      logger.info(`No matching reaction to undo on ${objectUrl}`);
      return;
    }

    const { error } = await supabase
      .from('post_interactions')
      .delete()
      .in('id', doomed);

    if (error) {
      logger.error(`Failed to delete reaction:`, error);
    } else {
      logger.info(`Undid reaction on ${objectUrl} (deleted ${doomed.length} records)`);
    }
  }

  /**
   * Predicate selecting the rows an Undo of Like/EmojiReaction removes: the
   * actor's rows carrying the emoji the Undo names. A Like naming no emoji or a
   * unicode heart is the favourite (isFavouriteLike); on a message, which has no
   * favourite, it is the heart reaction.
   *
   * One custom emoji has two stored representations, (emoji_id, ':name:') from
   * a local reaction and (NULL, ':name:') from an inbound one; either column
   * matching is enough. Rows are filtered in process because the predicate is a
   * disjunction over two columns and the emoji string is remote input.
   */
  private static async buildReactionUndoMatcher(
    supabase: any,
    emoji: string | undefined,
    emojiUrl: string | undefined,
    emojiName: string | undefined,
  ): Promise<(row: any) => boolean> {
    const isCustomEmoji = !!(emojiUrl && emojiName);
    const undoesFavourite = isFavouriteLike({ emoji, emojiUrl, emojiName });

    // Lookup only: an Undo naming an unknown emoji matches nothing rather than
    // creating a row.
    let emojiId: string | null = null;
    if (isCustomEmoji) {
      const { data: emojiRow } = await supabase
        .from('emojis')
        .select('id')
        .eq('url', emojiUrl)
        .maybeSingle();
      emojiId = emojiRow?.id ?? null;
    }

    // Content strings processLike writes for this emoji.
    const contents = new Set<string>();
    if (emoji && !undoesFavourite) {
      contents.add(emoji);
      const unqualified = stripOwnEmojiDomain(emoji);
      if (unqualified) contents.add(unqualified);
    }
    if (isCustomEmoji) {
      contents.add(`:${emojiName!.replace(/:/g, '')}:`);
    }

    return (row: any) => {
      if (row.interaction_type === 'favorite') return undoesFavourite;
      if (undoesFavourite) return isHeartReaction(row.custom_emoji_content);
      if (emojiId !== null && row.emoji_id === emojiId) return true;
      return typeof row.custom_emoji_content === 'string' && contents.has(row.custom_emoji_content);
    };
  }

  /**
   * Undo dispatch. `actorUrl` is the verified signer and has already been
   * matched against the undone activity's actor.
   */
  private static async processUndoByType(activityType: string, activityData: any, actorUrl: string): Promise<void> {
    logger.info(`Processing Undo by type: ${activityType}`);

    switch (activityType) {
      case 'Like':
      case 'EmojiReaction':
      case 'EmojiReact':
        if (activityData) {
          await this.processUndoReaction(activityData, actorUrl);
        }
        break;
      case 'Follow':
        if (activityData) {
          await this.processUndoFollow(activityData, actorUrl);
        }
        break;
      case 'Announce':
        if (typeof activityData?.id === 'string') {
          await this.processUndoAnnounce(activityData.id, actorUrl);
        }
        break;
      default:
        logger.warn(`Unhandled Undo object type: ${activityType}`);
    }
  }

  /** Undo Follow: removes the signer's follow of the target. */
  private static async processUndoFollow(followActivity: any, actorUrl: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { followingUrl } = extractFollowData({ ...followActivity, actor: actorUrl });
    logger.info(`Undoing follow: ${actorUrl} → ${followingUrl}`);

    const { data: follower } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    const { data: following } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', followingUrl)
      .maybeSingle();

    if (!follower || !following) {
      logger.warn(`Undo follow: unknown profile (follower=${!!follower}, following=${!!following})`);
      return;
    }

    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', follower.id)
      .eq('following_id', following.id);

    if (error) {
      logger.error(`Failed to delete follow:`, error);
    } else {
      logger.info(`Undid follow: ${actorUrl} → ${followingUrl}`);
    }
  }

  /**
   * Undo Announce: removes the signer's reblog row. Only a row authored by
   * the signer and carrying reblog markers qualifies; a quote post or an
   * ordinary post sharing the id is left alone.
   */
  private static async processUndoAnnounce(announceId: string, actorUrl: string): Promise<void> {
    const supabase = getSupabaseClient();
    logger.info(`Undoing announce: ${announceId}`);

    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    if (!user) {
      logger.warn(`Undo announce: unknown actor ${actorUrl}`);
      return;
    }

    const { data: reblogPost } = await supabase
      .from('posts')
      .select('id, ap_type, metadata')
      .eq('ap_id', announceId)
      .eq('author_id', user.id)
      .maybeSingle();

    const originalPostId = reblogPost?.metadata?.reblog_of;
    const isReblog = !!reblogPost
      && (reblogPost.ap_type === 'Announce' || !!originalPostId)
      && !reblogPost.metadata?.is_quote;
    if (!isReblog) {
      logger.warn(`Reblog post not found for Undo: ${announceId} by ${actorUrl}`);
      return;
    }

    const { error: deleteError } = await supabase
      .from('posts')
      .delete()
      .eq('id', reblogPost.id);

    if (deleteError) {
      logger.error(`Failed to delete reblog post:`, deleteError);
      return;
    }

    if (originalPostId) {
      await supabase
        .from('post_interactions')
        .delete()
        .eq('user_id', user.id)
        .eq('post_id', originalPostId)
        .eq('interaction_type', 'reblog');
    }
    logger.info(`Undid announce: ${announceId}`);
  }

  /**
   * Create of a Question. The poll is stored as a post with poll data in metadata.
   */
  private static async processCreatePoll(activity: any, object: any): Promise<void> {
    const supabase = getSupabaseClient();

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

    let endTime = null;
    if (object.endTime) {
      endTime = object.endTime;
    } else if (object.closed) {
      endTime = object.closed;
    }

    const content = noteToContent(object);
    const visibility = this.determineVisibility(object);

    const pollMetadata = {
      is_poll: true,
      poll_options: options,
      poll_multiple_choice: isMultipleChoice,
      poll_end_time: endTime,
      poll_voters_count: object.votersCount || 0,
      poll_closed: !!object.closed || (endTime && new Date(endTime) < new Date()),
    };

    const { data: existingPoll } = await supabase
      .from('posts')
      .select('id')
      .eq('ap_id', object.id)
      .maybeSingle();

    if (existingPoll) {
      const { error } = await supabase.from('posts')
        .update({ metadata: pollMetadata })
        .eq('id', existingPoll.id);
      if (error) {
        logger.error('Failed to update poll:', error);
      } else {
        logger.info(`Updated poll: ${object.id}`);
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
        logger.info(`Created poll: ${object.id} with ${options.length} options`);
      }
    }
  }

  /**
   * The local copy of the remote server whose Group actor is `serverUrl`. The
   * UUID in the URL selects the row; the row's ap_id must equal the URL, so an
   * actor on another host naming the same UUID resolves to nothing.
   */
  private static async resolveRemoteServer(serverUrl: string): Promise<any | null> {
    const supabase = getSupabaseClient();
    const serverIdMatch = serverUrl?.match(/\/servers\/([a-f0-9-]{36})$/i);
    if (!serverIdMatch) return null;

    const { data: server } = await supabase
      .from('servers')
      .select('id, federation_enabled, ap_id')
      .eq('id', serverIdMatch[1])
      .eq('is_local_server', false)
      .maybeSingle();

    if (!server?.ap_id || !SignatureService.verifyActorMatch(serverUrl, server.ap_id)) return null;
    return server;
  }

  /**
   * Harmony channel/category Add activities received on the shared inbox.
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
        logger.info(`Created remote category: ${object.name}`);
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
        logger.info(`Created remote channel: ${object.name} (${object.type})`);
      }
    }
  }

  /**
   * Harmony channel/category Update activities received on the shared inbox.
   * Creates the entity when absent, covering a missed Add.
   */
  private static async processHarmonyChannelUpdate(activity: any, object: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    const entityUuidMatch = object.id?.match(/\/channels\/([a-f0-9-]{36})$/i);
    const entityUuid = entityUuidMatch ? entityUuidMatch[1] : undefined;

    // Only the Group actor of a remote server updates that server's copy.
    const server = await this.resolveRemoteServer(actorUrl);
    if (!server) {
      logger.warn(`Rejecting channel Update: ${actorUrl} is not a known remote server actor`);
      return;
    }

    if (object.type === 'harmony:Category') {
      if (!entityUuid) {
        logger.warn(`Cannot extract UUID from category ap_id: ${object.id}`);
        return;
      }

      const { data: existing } = await supabase
        .from('channel_categories')
        .select('id')
        .eq('id', entityUuid)
        .eq('server_id', server.id)
        .maybeSingle();

      if (existing) {
        await supabase
          .from('channel_categories')
          .update({
            name: object.name,
            order: object.position || object.order,
          })
          .eq('id', entityUuid);
        logger.info(`Updated remote category: ${object.name}`);
      } else {
        const { error } = await supabase.from('channel_categories').insert({
          id: entityUuid,
          server_id: server.id,
          name: object.name,
          order: object.position || object.order || 0,
        });
        if (error) {
          logger.error(`Failed to auto-create category ${object.name}:`, error);
        } else {
          logger.info(`Auto-created remote category on Update: ${object.name}`);
        }
      }
    } else {
      const { data: channel } = await supabase
        .from('channels')
        .select('id, server_id')
        .eq('ap_id', object.id)
        .eq('server_id', server.id)
        .maybeSingle();

      let categoryId = null;
      if (object.category) {
        const catMatch = object.category.match(/\/channels\/([a-f0-9-]{36})$/i);
        if (catMatch) {
          const { data: cat } = await supabase
            .from('channel_categories')
            .select('id')
            .eq('id', catMatch[1])
            .eq('server_id', server.id)
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
        logger.info(`Updated remote channel: ${object.name}`);
      } else {
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
          logger.info(`Auto-created remote channel on Update: ${object.name}`);
        }
      }
    }
  }

  /**
   * Harmony channel/category Remove activities received on the shared inbox.
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

    const { data: deletedChannel } = await supabase
      .from('channels')
      .delete()
      .eq('ap_id', objectUrl)
      .eq('server_id', server.id)
      .select('id')
      .maybeSingle();

    if (deletedChannel) {
      logger.info(`Removed remote channel: ${objectUrl}`);
      return;
    }

    // Not a channel; the same URL may name a category, keyed by UUID.
    if (uuidMatch) {
      const { data: deletedCat } = await supabase
        .from('channel_categories')
        .delete()
        .eq('id', uuidMatch[1])
        .eq('server_id', server.id)
        .select('id')
        .maybeSingle();

      if (deletedCat) {
        logger.info(`Removed remote category: ${uuidMatch[1]}`);
        return;
      }
    }

    logger.warn(`Channel/category not found for Remove: ${objectUrl}`);
  }

  /**
   * Add activity: pins a post to the featured collection, or adds a Harmony
   * channel/category.
   */
  private static async processAdd(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const targetUrl = typeof activity.target === 'string' ? activity.target : activity.target?.id;
    const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    const object = typeof activity.object === 'object' ? activity.object : null;

    if (object && ['harmony:TextChannel', 'harmony:VoiceChannel', 'harmony:Category'].includes(object.type)) {
      await this.processHarmonyChannelAdd(activity, object);
      return;
    }

    if (!targetUrl?.includes('/featured') || !objectUrl) {
      logger.info(`Add activity not for featured collection, skipping`);
      return;
    }

    logger.info(`Processing Add to featured: ${objectUrl}`);

    const { data: post, error } = await supabase
      .from('posts')
      .select('id, author_id, profiles:author_id(federated_id)')
      .eq('ap_id', objectUrl)
      .maybeSingle();

    if (error || !post) {
      logger.warn(`Post not found for pinning: ${objectUrl}`);
      return;
    }

    const authorUrl = (post as any).profiles?.federated_id as string | null | undefined;
    if (!authorUrl || !SignatureService.verifyActorMatch(normalizeActor(activity.actor), authorUrl)) {
      logger.warn(`Rejecting featured Add: ${normalizeActor(activity.actor)} does not own ${objectUrl}`);
      return;
    }

    await supabase
      .from('posts')
      .update({ is_pinned: true })
      .eq('id', post.id);

    logger.info(`Pinned post: ${objectUrl}`);
  }

  /**
   * Remove activity: unpins a post, removes a Harmony channel/category, or
   * drops a group conversation participant.
   */
  private static async processRemove(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const target = activity.target;
    const targetUrl = typeof target === 'string' ? target : target?.id;
    const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    const targetType = typeof target === 'object' ? target?.['harmony:type'] : null;
    if (targetType === 'harmony:GroupConversation') {
      await this.handleGroupConversationParticipantRemove(activity, target);
      return;
    }

    if (objectUrl?.includes('/channels/') && targetUrl?.includes('/servers/')) {
      await this.processHarmonyChannelRemove(activity, objectUrl);
      return;
    }

    if (!targetUrl?.includes('/featured') || !objectUrl) {
      logger.info(`Remove activity not for featured collection, skipping`);
      return;
    }

    logger.info(`Processing Remove from featured: ${objectUrl}`);

    const { data: post } = await supabase
      .from('posts')
      .select('id, profiles:author_id(federated_id)')
      .eq('ap_id', objectUrl)
      .maybeSingle();
    const authorUrl = (post as any)?.profiles?.federated_id as string | null | undefined;
    if (!post || !authorUrl || !SignatureService.verifyActorMatch(normalizeActor(activity.actor), authorUrl)) {
      logger.warn(`Rejecting featured Remove: ${normalizeActor(activity.actor)} does not own ${objectUrl}`);
      return;
    }

    const { error } = await supabase
      .from('posts')
      .update({ is_pinned: false })
      .eq('id', (post as any).id);

    if (!error) {
      logger.info(`Unpinned post: ${objectUrl}`);
    }
  }

  /**
   * Flag: a report from another instance about local accounts or posts.
   *
   * Mirrors Mastodon ActivityPub::Activity::Flag: one report per local account
   * named, each carrying the named local posts that account wrote; posts by
   * anyone else and every non-local object are ignored. The report belongs to
   * the sending domain, not to a profile (create_federated_report). Redelivery
   * of the same Flag id is a no-op, and a domain is held to 30 reports an hour.
   */
  static async processFlag(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);
    let sourceDomain: string;
    try {
      sourceDomain = new URL(actorUrl).hostname.toLowerCase();
    } catch {
      logger.warn('Flag with an unparseable actor ignored');
      return;
    }
    if (typeof activity.id !== 'string' || !activity.id) {
      logger.warn(`Flag from ${actorUrl} without an id ignored`);
      return;
    }

    const uris = flagObjectUris(activity.object);
    const accountIds = new Set<string>();
    const postAuthors = new Map<string, string>();

    for (const uri of uris) {
      const ref = parseLocalObjectUri(uri, config.INSTANCE_DOMAIN);
      if (ref?.kind === 'account') {
        const { data } = await supabase
          .from('profiles')
          .select('id')
          .ilike('username', ref.username.replace(/_/g, '\\_'))
          .eq('is_local', true)
          .maybeSingle();
        if (data) accountIds.add(data.id);
        continue;
      }
      if (ref?.kind === 'post') {
        const { data } = await supabase
          .from('posts')
          .select('id, author_id')
          .eq('id', ref.id)
          .eq('is_local', true)
          .maybeSingle();
        if (data) postAuthors.set(data.id, data.author_id);
        continue;
      }
      if (!sameOrigin(uri, `https://${config.INSTANCE_DOMAIN}/`)) continue;

      // Local URIs in another form: stored actor or post ids.
      const { data: account } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', uri)
        .eq('is_local', true)
        .maybeSingle();
      if (account) {
        accountIds.add(account.id);
        continue;
      }
      const { data: post } = await supabase
        .from('posts')
        .select('id, author_id')
        .eq('ap_id', uri)
        .eq('is_local', true)
        .maybeSingle();
      if (post) postAuthors.set(post.id, post.author_id);
    }

    if (accountIds.size === 0) {
      for (const author of postAuthors.values()) accountIds.add(author);
    }
    if (accountIds.size === 0) {
      logger.info(`Flag ${activity.id} from ${sourceDomain} names nothing local; ignored`);
      return;
    }

    const comment = flagComment(activity.content);
    for (const accountId of accountIds) {
      const postIds = [...postAuthors.entries()]
        .filter(([, author]) => author === accountId)
        .map(([postId]) => postId);
      const { data, error } = await supabase.rpc('create_federated_report', {
        p_ap_id: activity.id,
        p_actor: actorUrl,
        p_source_domain: sourceDomain,
        p_reported_user_id: accountId,
        p_post_ids: postIds,
        p_comment: comment,
        p_object_uris: uris,
      });
      if (error) {
        throw new Error(`Flag ${activity.id}: report not stored: ${error.message}`);
      }
      logger.info(`Flag ${activity.id} from ${sourceDomain} on ${accountId}: ${data?.status ?? 'unknown'}`);
    }
  }

  /**
   * Block activity: a federated block.
   */
  private static async processBlock(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);
    const blockedUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    if (!blockedUrl) {
      logger.warn(`Block activity missing object`);
      return;
    }

    logger.info(`Processing Block: ${actorUrl} → ${blockedUrl}`);

    // Only the blocker is fetched; the blocked profile must already be known.
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

    await supabase.from('user_blocks').upsert({
      blocker_id: blocker.id,
      blocked_user_id: blocked.id,
      block_type: 'full',
      is_federated: true,
      ap_id: activity.id,
    }, {
      onConflict: 'blocker_id,blocked_user_id',
    });

    // Follow relationships are dropped in both directions.
    await supabase
      .from('follows')
      .delete()
      .or(`and(follower_id.eq.${blocker.id},following_id.eq.${blocked.id}),and(follower_id.eq.${blocked.id},following_id.eq.${blocker.id})`);

    logger.info(`Blocked: ${actorUrl} → ${blockedUrl}`);
  }

  /**
   * Resolve an inbound emoji into an emoji_id, creating the row when absent.
   * Returns null for anything without both a name and a URL.
   */
  private static async resolveInboundEmojiId(
    supabase: any,
    emojiName: string | undefined,
    emojiUrl: string | undefined,
    userId: string,
  ): Promise<string | null> {
    // Only image-backed custom emoji get an `emojis` row. Unicode reactions are
    // stored via `custom_emoji_content` by the caller; creating a row for them
    // pollutes the instance emoji picker with url-less entries.
    if (!emojiUrl || !emojiName) return null;

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

  /**
   * Ensure a remote user row exists, fetching the actor when missing or stale.
   * `forceRefresh` re-fetches even when the profile is present and fresh.
   */
  // Dedup concurrent fetches per actor: a burst of activities from a new or
  // stale sender otherwise triggers N identical remote actor fetches.
  private static inflightActorFetches = new Map<string, Promise<any | null>>();

  private static async ensureRemoteUser(actorUrl: string, forceRefresh: boolean = false): Promise<any | null> {
    if (!forceRefresh) {
      const inflight = this.inflightActorFetches.get(actorUrl);
      if (inflight) return inflight;
    }
    const fetchPromise = this.ensureRemoteUserUncached(actorUrl, forceRefresh).finally(() => {
      if (this.inflightActorFetches.get(actorUrl) === fetchPromise) {
        this.inflightActorFetches.delete(actorUrl);
      }
    });
    this.inflightActorFetches.set(actorUrl, fetchPromise);
    return fetchPromise;
  }

  private static async ensureRemoteUserUncached(actorUrl: string, forceRefresh: boolean): Promise<any | null> {
    const supabase = getSupabaseClient();

    const { data: existing } = await supabase
      .from('profiles')
      .select('id, updated_at, federated_id, username, display_name, avatar_url, color, federation_metadata')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    if (existing && !forceRefresh) {
      const updatedAt = new Date(existing.updated_at);
      const hoursSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
      
      // Profiles are considered fresh for 24h.
      if (hoursSinceUpdate < 24) {
        return existing;
      }
      logger.info(`Profile for ${actorUrl} is stale (${Math.round(hoursSinceUpdate)}h old), refreshing...`);
    } else if (existing && forceRefresh) {
      logger.info(`Force refreshing profile for ${actorUrl}`);
    }

    // BUGS.md H15: actorUrl is attacker-influenced (from inbox or Follow
    // activity); safeFetch handles SSRF, redirect re-validation, and timeout.
    try {
      // The stored profile is keyed by the document's own id; a document
      // claiming an id on another host would overwrite that host's actor,
      // public key included.
      const actor = await fetchAuthoritativeDocument(actorUrl, (u) => this.fetchApJson(u));
      if (!actor) {
        logger.error(`Failed to fetch actor ${actorUrl}`);
        return existing || null;
      }

      const profileData = actorToProfile(actor);

      // SECURITY: a remote actor claiming the instance domain is a spoofing
      // attempt; refuse the upsert.
      const { config } = await import('../config/index.js');
      if (profileData.domain.toLowerCase() === config.INSTANCE_DOMAIN.toLowerCase()) {
        logger.warn(`SECURITY: Remote actor ${actorUrl} claims local domain ${profileData.domain}! Refusing to upsert.`);
        return existing || null;
      }

      // SECURITY: second guard against overwriting a local user with the same
      // username/domain. The federated_id conflict normally prevents this.
      const { data: existingLocalUser } = await supabase
        .from('profiles')
        .select('id, is_local')
        .eq('username', profileData.username)
        .eq('domain', profileData.domain)
        .eq('is_local', true)
        .maybeSingle();
      
      if (existingLocalUser) {
        logger.warn(`SECURITY: Refusing to overwrite local user ${profileData.username}@${profileData.domain} via ensureRemoteUser`);
        return existing || null;
      }

      // Maps actor field names onto database columns. Serves both initial
      // creation and stale-profile refresh.
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
        updated_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
      };

      // Harmony extension: profile color.
      if (profileData.color) {
        profileRecord.color = profileData.color;
      }

      // Persist ActivityPub profile fields (PropertyValue attachments)
      if (profileData.profile_fields) {
        profileRecord.profile_fields = profileData.profile_fields;
      }

      // Shared inbox URL, used to batch delivery.
      if (actor.endpoints?.sharedInbox) {
        profileRecord.shared_inbox_url = actor.endpoints.sharedInbox;
      }

      // Persist custom emoji metadata so the frontend can render shortcodes, and
      // the actor's creation date, which the spam heuristics read as account age.
      const apPublished = typeof actor.published === 'string' && Number.isFinite(Date.parse(actor.published))
        ? new Date(actor.published).toISOString()
        : null;
      if (profileData.display_name_emojis?.length || profileData.bio_emojis?.length || apPublished) {
        const existingMeta = (existing as any)?.federation_metadata || {};
        const meta = typeof existingMeta === 'string' ? JSON.parse(existingMeta) : { ...existingMeta };
        if (profileData.display_name_emojis?.length) {
          meta.display_name_emojis = profileData.display_name_emojis;
        }
        if (profileData.bio_emojis?.length) {
          meta.bio_emojis = profileData.bio_emojis;
        }
        if (apPublished) {
          meta.ap_published = apPublished;
        }
        profileRecord.federation_metadata = meta;
      }

      const { error: upsertError } = await supabase
        .from('profiles')
        .upsert(profileRecord, {
          onConflict: 'federated_id',
        });

      if (upsertError) {
        logger.error(`Failed to upsert profile for ${actorUrl}:`, upsertError);
        return existing || null;
      }

      // Re-query after upsert; upsert().select() does not reliably return rows.
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
   * Harmony server channel message, distinct from a regular post.
   */
  private static async processChannelMessage(activity: any, object: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);
    
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

    if (typeof serverId !== 'string') {
      logger.warn(`Channel message without a server id: ${object.id}`);
      return;
    }

    const author = await this.ensureRemoteUser(actorUrl);
    if (!author) {
      logger.error(`Could not ensure remote user for channel message: ${actorUrl}`);
      return;
    }

    // The thread is resolved before authorization: a thread message needs
    // SEND_MESSAGES_IN_THREADS rather than SEND_MESSAGES.
    let resolvedThreadId: string | null = null;
    const threadApIdValue = typeof object['harmony:threadId'] === 'string' ? object['harmony:threadId'] : null;
    if (threadApIdValue) {
      const thread = await resolveThreadInChannel(supabase, threadApIdValue, channelId);
      if (thread.status === 'foreign') {
        logDenied('channel message', actorUrl, `thread ${threadApIdValue} is not in channel ${channelId}`);
        return;
      }
      if (thread.status === 'found') {
        resolvedThreadId = thread.id;
      } else {
        logger.warn(`Thread not found for AP ID ${threadApIdValue}, will create stub thread after message insert.`);
      }
    }

    const authz = await authorizeChannelWrite(supabase, {
      actorUrl,
      serverId,
      channelId,
      kind: threadApIdValue ? 'thread_message' : 'message',
    });
    if (!authz.ok) {
      logDenied('channel message', actorUrl, authz.reason);
      return;
    }
    // A stub thread stands in for an unknown one; creating it is creating a thread.
    if (threadApIdValue && !resolvedThreadId) {
      const stubAuthz = await authorizeChannelWrite(supabase, { actorUrl, serverId, channelId, kind: 'thread_create' });
      if (!stubAuthz.ok) {
        logDenied('channel message opening a thread', actorUrl, stubAuthz.reason);
        return;
      }
    }

    let messageId: string | null = null;
    const messageMatch = object.id?.match(/\/messages\/([a-f0-9-]{36})/);
    if (messageMatch) {
      messageId = messageMatch[1];
    } else {
      messageId = randomUUID();
    }

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

    // Mention userIds arrive as origin-instance UUIDs; map to local profile UUIDs.
    if (Array.isArray(content)) {
      const { resolveMentionUserIds } = await import('../utils/mentionResolver.js');
      content = await resolveMentionUserIds(content);
    }
    
    // Remote emoji UUIDs do not exist locally, so emojis are rewritten to the
    // URL-based form used by the Discord bridge.
    const instanceDomain = new URL(actorUrl).hostname;
    if (Array.isArray(content)) {
      content = content.map((item: any) => {
        if (item.type === 'emoji' && item.emoji) {
          return {
            type: 'emoji',
            emoji: {
              name: item.emoji.name || 'emoji',
              url: item.emoji.url,
              domain: instanceDomain,
              is_remote: true,
            }
          };
        }
        return item;
      });
    }

    const { data: existingMessage } = await supabase
      .from('messages')
      .select('id')
      .eq('id', messageId)
      .maybeSingle();

    if (existingMessage) {
      logger.debug(`Channel message ${messageId} already exists, skipping`);
      return;
    }

    // inReplyTo holds a remote AP id or UUID that may not exist locally; only a
    // message in the same channel is a valid parent.
    const resolvedReplyTo = typeof object.inReplyTo === 'string'
      ? await resolveMessageInChannel(supabase, object.inReplyTo, channelId)
      : null;

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

    const { data: insertedRows, error: insertError } = await supabase
      .from('messages')
      .insert({
        id: messageId,
        channel_id: channelId,
        user_id: author.id,
        content: content,
        created_at: notAfterNow(object.published),
        updated_at: object.updated ? notAfterNow(object.updated) : null,
        reply_to: resolvedReplyTo,
        thread_id: resolvedThreadId,
        is_deleted: false,
        federation_status: 'completed',
        encrypted: object['harmony:encrypted'] === true,
        metadata: messageMetadata,
      })
      // Array response: the server's AutoMod drops a blocked row (zero rows), and
      // PostgREST rolls a zero-row .single() request back with the AutoMod event in it.
      .select('id, content, metadata');

    if (insertError) {
      logger.error(`Failed to create channel message:`, insertError);
      return;
    }
    const insertedMsg = insertedRows?.[0];
    if (!insertedMsg) {
      logger.info(`Channel message ${object.id} from ${author.username} dropped by the server's AutoMod`);
      return;
    }

    logger.info(`Created channel message ${messageId} in #${channelName} from ${author.username}`);

    // Message names a thread that does not exist yet; create a stub.
    if (threadApIdValue && !resolvedThreadId && insertedMsg) {
      try {
        const threadUuidMatch = threadApIdValue.match(/\/threads\/([a-f0-9-]{36})/);
        const stubThreadId = threadUuidMatch ? threadUuidMatch[1] : randomUUID();

        // Parent message named by the origin, if any, in the same channel.
        let parentMessageId = insertedMsg.id; // fallback: this message
        const parentMessageApId = object['harmony:parentMessageId'];
        if (typeof parentMessageApId === 'string') {
          parentMessageId = (await resolveMessageInChannel(supabase, parentMessageApId, channelId)) ?? parentMessageId;
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
          // 23505: the thread was created concurrently; adopt that row when it is in this channel.
          if (stubError.code === '23505'
              && (await resolveThreadInChannel(supabase, threadApIdValue, channelId)).status === 'found') {
            resolvedThreadId = stubThreadId;
            logger.info(`Stub thread ${stubThreadId} already exists (race condition), assigning message`);
          } else {
            logger.warn(`Failed to create stub thread: ${stubError.message}`);
          }
        } else {
          resolvedThreadId = stubThreadId;
          logger.info(`Created stub thread ${stubThreadId} for AP ID ${threadApIdValue}`);
        }

        if (resolvedThreadId) {
          await supabase
            .from('messages')
            .update({ thread_id: resolvedThreadId })
            .eq('id', insertedMsg.id);

          // Adopt other orphaned messages carrying the same pending_thread_ap_id.
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
            logger.info(`Assigned ${orphans.length} additional orphaned messages to stub thread ${resolvedThreadId}`);
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
   * Direct message. Stored in `messages`, not `posts`.
   */
  /** Local profile ids named by the mention parts of converted content. */
  private static async localMentionTargets(content: any[], authorId: string): Promise<string[]> {
    const usernames = [...new Set(
      (Array.isArray(content) ? content : [])
        .filter((p: any) => p?.type === 'mention' && p.isLocal && typeof p.username === 'string')
        .map((p: any) => p.username.toLowerCase()),
    )].slice(0, 100);
    if (usernames.length === 0) return [];
    const { data } = await getSupabaseClient()
      .from('profiles')
      .select('id, username')
      .eq('is_local', true)
      .in('username', usernames);
    return (data ?? []).map((p: any) => p.id).filter((id: string) => id !== authorId);
  }

  private static async handleDirectMessage(
    object: any,
    authorId: string,
    content: any[],
    activity: any = null,
    options: { skipSpamGuard?: boolean } = {},
  ): Promise<void> {
    const supabase = getSupabaseClient();
    
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

    // Checked before the conversation exists: a held or rejected DM leaves nothing behind.
    if (!options.skipSpamGuard) {
      const { data: localRecipients } = await supabase
        .from('profiles')
        .select('id')
        .in('id', recipientIds)
        .eq('is_local', true);
      const verdict = await evaluateInboundCreate({
        activity: activity ?? { id: object.id, type: 'Create', actor: object.attributedTo, object },
        object,
        authorId,
        authorUri: typeof object.attributedTo === 'string' ? object.attributedTo : normalizeActor(activity?.actor),
        kind: 'federation_dm',
        targetIds: (localRecipients ?? []).map((r: any) => r.id).filter((id: string) => id !== authorId),
      });
      if (verdict.action === 'hold' || verdict.action === 'reject') {
        logger.info(`DM ${object.id} ${verdict.action === 'hold' ? 'held' : 'rejected'} as suspected spam`);
        return;
      }
    }

    // Group vs 1:1 is decided by sender metadata or recipient count.
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

    // Deduplicate by ap_id within the conversation.
    const { data: existing } = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .contains('metadata', { ap_id: object.id })
      .limit(1);

    if (existing && existing.length > 0) {
      logger.info(`DM already exists for ${object.id}, skipping duplicate`);
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
      logger.info(`Created DM in conversation ${conversationId} from ${object.id}`)
      if (insertedDM) {
        const { enrichMessageLinkPreviews } = await import('../listeners/DatabaseListener.js');
        enrichMessageLinkPreviews(insertedDM).catch(err =>
          logger.warn('Link preview enrichment failed for federated DM:', err)
        );
      }
    }
  }

  /**
   * Group invite: creates the conversation and notifies local recipients.
   */
  private static async handleGroupInvite(object: any, authorId: string): Promise<void> {
    const supabase = getSupabaseClient();

    const to: unknown[] = Array.isArray(object.to) ? object.to : [object.to].filter(Boolean);
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
        p_notification_type: 'dm',
        p_to_user_id: userId,
        p_notification_data: {
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
        p_server_id: null,
        p_channel_id: null,
        p_conversation_id: conversationId,
        p_from_user_id: authorId,
        p_priority: 'normal'
      });
      if (notifError) logger.warn('Failed to create invite notification:', notifError);
    }
    logger.info(`Group invite processed: conversation ${conversationId}, ${recipientIds.length} recipient(s)`);
  }

  /**
   * Resolve a remote conversation ID to the local conversation row.
   * Direct UUID match first, then the metadata mapping.
   */
  private static async resolveGroupConversation(
    remoteConversationId: string
  ): Promise<{ id: string; type: string; metadata: any } | null> {
    const supabase = getSupabaseClient();

    // 1. Direct ID match; holds when the conversation is same-instance.
    const { data: direct } = await supabase
      .from('conversations')
      .select('id, type, metadata')
      .eq('id', remoteConversationId)
      .eq('type', 'group')
      .maybeSingle();

    if (direct) return direct;

    // 2. Fall back to metadata.remote_conversation_id.
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

    logger.info(`Processing group conversation update: ${updateType} for ${remoteConversationId}`);

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
      logger.info(`Updated group conversation name: ${newName}`);
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
        logger.info(`Updated group conversation icon: ${iconUrl}`);
      }
    } else if (updateType === 'icon_removed') {
      const currentMetadata = (conversation.metadata as any) || {};
      delete currentMetadata.icon_url;

      await supabase
        .from('conversations')
        .update({ metadata: currentMetadata, updated_at: new Date().toISOString() })
        .eq('id', localId);
      logger.info(`Removed group conversation icon`);
    }
  }

  /**
   * Group conversation participant removal driven by a remote instance.
   */
  private static async handleGroupConversationParticipantRemove(activity: any, target: any): Promise<void> {
    const supabase = getSupabaseClient();
    const remoteConversationId = target['harmony:conversationId'];
    const removedUserUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    if (!remoteConversationId || !removedUserUrl) {
      logger.warn('Group participant remove missing conversationId or user URL');
      return;
    }

    logger.info(`Processing group participant removal: ${removedUserUrl} from ${remoteConversationId}`);

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
      logger.info(`Removed ${removedUserUrl} from group conversation ${conversation.id}`);
    }
  }

  /**
   * Delegates to the module-level `determineVisibility`.
   */
  private static determineVisibility(object: any): string {
    return determineVisibility(object);
  }
}

