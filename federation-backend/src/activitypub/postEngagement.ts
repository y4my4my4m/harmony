/**
 * Outbound favourites and emoji reactions on posts.
 *
 * A person holds at most one favourite on a post (a `favorite` row), and each emoji reaction
 * implies it (implied_by_reaction, 20261007200001). What a delivery carries depends on the
 * receiving software (instanceSoftware.ts):
 *
 *   mastodon    Mastodon, glitch-soc, GoToSocial. Every Like is a favourite, one per
 *               account and status, and any Undo Like removes it whatever its id or emoji
 *               (Mastodon ActivityPub::Activity::Undo#undo_like, GoToSocial
 *               federatingdb.undoLike). EmojiReact is ignored (Mastodon) or refused with 400
 *               (GoToSocial). The favourite's Like and its Undo; reactions send nothing.
 *   misskey     Misskey and forks. One reaction per account and note: a Like or EmojiReact
 *               replaces the held one, any Undo deletes it (ReactionService.create/delete,
 *               ApInboxService.like/undoLike). A delivery carries the person's state when
 *               each attempt is sent, retries included (deferredEngagement.ts): the newest
 *               reaction as Like + _misskey_reaction, else a bare Like for the favourite,
 *               else the deleted favourite's Undo, else nothing. An implied favourite's
 *               create sends nothing: its reaction's job does.
 *   emojiReact  everything else, FEP-c0e0: Pleroma and Akkoma (Undo resolved by activity
 *               id), Harmony. A Like for the favourite, an EmojiReact per reaction, and an
 *               Undo of each by its id.
 *
 * Activity ids are likeActivityId(row id). A misskey-family state carries a fragment of the
 * send time: Sharkey deduplicates queued inbox jobs by activity id, and a state is resent.
 */

import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { DeliveryQueue } from './DeliveryQueue.js';
import {
  createEmojiReactActivity,
  createLikeActivity,
  createUndoActivity,
  likeActivityId,
} from './converters/toActivityPub.js';
import { instanceEngagementFamily, type EngagementFamily } from './instanceSoftware.js';
import { DEFERRED_ENGAGEMENT_TYPE, type DeferredEngagement } from './deferredEngagement.js';
import { formatEmojiForFederation } from '../utils/emojiResolvers.js';
import { isHeartReaction } from '../utils/heartReaction.js';
import { logger } from '../utils/logger.js';

/** A post_interactions row event, as trigger_queue_interaction_federation queues it. */
export interface PostEngagementEvent {
  type: 'create' | 'delete';
  interaction_id: string;
  interaction_type: string;
  post_id: string;
  user_id: string;
  emoji_id?: string | null;
  custom_emoji_content?: string | null;
  /** implied_by_reaction of a favourite row. Absent from jobs queued before 20261007200001. */
  implied?: boolean | null;
}

export interface EmojiRow {
  name: string;
  url: string | null;
  domain?: string | null;
}

interface ReactionRef {
  id: string;
  emoji_id: string | null;
  custom_emoji_content: string | null;
  emoji: EmojiRow | null;
}

/** The person's favourite and newest reaction on the post, read when the job runs. */
export interface EngagementState {
  favouriteId: string | null;
  newestReaction: ReactionRef | null;
}

interface StateContext {
  user: { username: string };
  postApId: string;
  /** URL host of the receiving inbox; an emoji native to it is sent as `:name:`. */
  targetHost?: string;
  to?: string[];
  state: EngagementState | null;
  now: number;
}

export interface EncodeContext extends StateContext {
  event: PostEngagementEvent;
  eventEmoji: EmojiRow | null;
}

/** Interaction types federated at all. A reblog is the Announce of its boost post. */
export function isLikeInteraction(interactionType: string | null | undefined): boolean {
  return interactionType === 'favorite' || interactionType === 'emoji_reaction';
}

/**
 * True for the favourite, and for an emoji_reaction carrying a unicode heart or no emoji:
 * the last two exist only in jobs queued before trg_fold_heart_reaction and before the
 * delete payload carried the emoji.
 */
export function isFavouriteInteraction(ref: {
  interaction_type: string;
  emoji_id?: string | null;
  custom_emoji_content?: string | null;
}): boolean {
  if (ref.interaction_type === 'favorite') return true;
  if (ref.emoji_id) return false;
  return !ref.custom_emoji_content || isHeartReaction(ref.custom_emoji_content);
}

function reactionEmoji(
  ref: { custom_emoji_content?: string | null },
  emoji: EmojiRow | null,
  targetHost?: string,
): { content: string; emojiData?: { name: string; url: string } } {
  const { content, emojiData } = formatEmojiForFederation(emoji, ref.custom_emoji_content, targetHost);
  return { content, emojiData: emojiData ?? undefined };
}

function favouriteLike(ctx: StateContext, rowId: string, suffix = ''): any {
  return createLikeActivity(ctx.user, ctx.postApId, undefined, undefined, ctx.to,
    likeActivityId(ctx.user, rowId) + suffix);
}

/**
 * What a misskey-family inbox should hold for the person now: the newest reaction, else a
 * bare Like for the favourite, else the Undo of `undoFavouriteId`, else nothing.
 */
export function misskeyCurrent(ctx: StateContext, undoFavouriteId?: string): any | null {
  const state = ctx.state;
  const stamp = `#${ctx.now}`;
  if (state?.newestReaction) {
    const r = state.newestReaction;
    const { content, emojiData } = reactionEmoji(r, r.emoji, ctx.targetHost);
    return createLikeActivity(ctx.user, ctx.postApId, content, emojiData, ctx.to,
      likeActivityId(ctx.user, r.id) + stamp);
  }
  if (state?.favouriteId) return favouriteLike(ctx, state.favouriteId, stamp);
  if (!undoFavouriteId) return null;
  const like = createLikeActivity(ctx.user, ctx.postApId, undefined, undefined, undefined,
    likeActivityId(ctx.user, undoFavouriteId));
  return createUndoActivity(ctx.user, like);
}

/** The deleted favourite a misskey-family delivery of `event` may have to undo. */
function undoFavouriteIdOf(event: PostEngagementEvent): string | undefined {
  return event.type === 'delete' && isFavouriteInteraction(event) ? event.interaction_id : undefined;
}

function encodeForMisskey(ctx: EncodeContext): any | null {
  const { event } = ctx;
  if (event.type === 'create' && isFavouriteInteraction(event) && event.implied) return null;
  return misskeyCurrent(ctx, undoFavouriteIdOf(event));
}

/** The activity one delivery of `ctx.event` carries to `family`, or null for none. */
export function encodeEngagement(family: EngagementFamily, ctx: EncodeContext): any | null {
  if (family === 'misskey') return encodeForMisskey(ctx);

  const { event } = ctx;
  if (isFavouriteInteraction(event)) {
    const like = favouriteLike(ctx, event.interaction_id);
    return event.type === 'create' ? like : createUndoActivity(ctx.user, like);
  }
  if (family === 'mastodon') return null;

  const { content, emojiData } = reactionEmoji(event, ctx.eventEmoji, ctx.targetHost);
  const react = createEmojiReactActivity(ctx.user, ctx.postApId, content, emojiData, ctx.to,
    likeActivityId(ctx.user, event.interaction_id));
  return event.type === 'create' ? react : createUndoActivity(ctx.user, react);
}

async function loadEmoji(supabase: any, emojiId: string | null | undefined): Promise<EmojiRow | null> {
  if (!emojiId) return null;
  const { data } = await supabase
    .from('emojis')
    .select('name, url, domain')
    .eq('id', emojiId)
    .maybeSingle();
  return data ?? null;
}

/**
 * The activity a deferred misskey-family delivery carries at this attempt, or null when
 * nothing is left to send. Reads the reactor's state for every attempt.
 */
export async function resolveDeferredEngagement(deferred: DeferredEngagement, now = Date.now()): Promise<any | null> {
  const state = await loadEngagementState(getSupabaseClient(), deferred.post_id, deferred.user_id);
  return misskeyCurrent({
    user: { username: deferred.username },
    postApId: deferred.post_ap_id,
    targetHost: deferred.target_host,
    to: deferred.to,
    state,
    now,
  }, deferred.undo_favourite_id);
}

export async function loadEngagementState(supabase: any, postId: string, userId: string): Promise<EngagementState> {
  const { data: rows } = await supabase
    .from('post_interactions')
    .select('id, interaction_type, emoji_id, custom_emoji_content, created_at')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .in('interaction_type', ['favorite', 'emoji_reaction']);

  const all: any[] = rows ?? [];
  const favourite = all.find((r) => r.interaction_type === 'favorite');
  const newest = all
    .filter((r) => r.interaction_type === 'emoji_reaction')
    .sort((a, b) => (String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id))))[0];

  return {
    favouriteId: favourite?.id ?? null,
    newestReaction: newest
      ? {
          id: newest.id,
          emoji_id: newest.emoji_id ?? null,
          custom_emoji_content: newest.custom_emoji_content ?? null,
          emoji: await loadEmoji(supabase, newest.emoji_id),
        }
      : null,
  };
}

function inboxHost(inbox: string): string | null {
  try {
    return new URL(inbox).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Delivers one post_interactions event: to the post author's inbox when the author is
 * remote, and to the shared inboxes of the author's remote followers. Every delivery is
 * signed by the person who reacted.
 */
export async function federatePostEngagement(event: PostEngagementEvent): Promise<'completed' | 'skipped'> {
  if (!isLikeInteraction(event.interaction_type)) return 'skipped';

  const supabase = getSupabaseClient();

  const { data: post } = await supabase
    .from('posts')
    .select('id, author_id, ap_id, is_local')
    .eq('id', event.post_id)
    .maybeSingle();
  if (!post) {
    logger.info(`Engagement on missing post ${event.post_id}, skipping federation`);
    return 'skipped';
  }

  if (!post.ap_id) {
    if (post.is_local === false) {
      logger.info(`Remote post ${post.id} without ap_id, skipping federation`);
      return 'skipped';
    }
    post.ap_id = `https://${config.INSTANCE_DOMAIN}/posts/${post.id}`;
    await supabase.from('posts').update({ ap_id: post.ap_id }).eq('id', post.id);
  }

  const { data: user } = await supabase
    .from('profiles')
    .select('id, username, is_local')
    .eq('id', event.user_id)
    .maybeSingle();
  if (!user || !user.is_local) return 'skipped';

  const { data: author } = await supabase
    .from('profiles')
    .select('inbox_url, is_local, federated_id, username, domain')
    .eq('id', post.author_id)
    .maybeSingle();
  if (!author) {
    logger.info(`Post author ${post.author_id} not found, skipping federation`);
    return 'skipped';
  }

  const targets: Array<{ inbox: string; to?: string[]; priority: number }> = [];
  if (!author.is_local && author.inbox_url) {
    targets.push({
      inbox: author.inbox_url,
      to: [author.federated_id || `https://${author.domain}/users/${author.username}`],
      priority: 1,
    });
  }
  for (const inbox of await DeliveryQueue.followerInboxes(post.author_id)) {
    if (!targets.some((t) => t.inbox === inbox)) targets.push({ inbox, priority: 5 });
  }
  if (targets.length === 0) return 'completed';

  const families = new Map<string, EngagementFamily>();
  for (const t of targets) {
    const host = inboxHost(t.inbox);
    if (host && !families.has(host)) families.set(host, await instanceEngagementFamily(host));
  }

  const eventEmoji = isFavouriteInteraction(event) ? null : await loadEmoji(supabase, event.emoji_id);
  const state = [...families.values()].includes('misskey')
    ? await loadEngagementState(supabase, post.id, user.id)
    : null;

  const now = Date.now();
  const deliveries: Array<{ inbox: string; activity: any; priority: number }> = [];
  for (const t of targets) {
    const host = inboxHost(t.inbox) ?? undefined;
    const family = (host && families.get(host)) || 'emojiReact';
    const activity = encodeEngagement(family, {
      user, postApId: post.ap_id, targetHost: host, to: t.to, event, eventEmoji, state, now,
    });
    if (!activity) continue;
    if (family === 'misskey') {
      const deferred: DeferredEngagement = {
        type: DEFERRED_ENGAGEMENT_TYPE,
        post_id: post.id,
        user_id: user.id,
        username: user.username,
        post_ap_id: post.ap_id,
        target_host: host,
        ...(t.to && { to: t.to }),
        ...(undoFavouriteIdOf(event) && { undo_favourite_id: undoFavouriteIdOf(event) }),
      };
      deliveries.push({ inbox: t.inbox, activity: deferred, priority: t.priority });
    } else {
      deliveries.push({ inbox: t.inbox, activity, priority: t.priority });
    }
  }

  logger.info(`${event.type} ${event.interaction_type} ${event.interaction_id}: ${deliveries.length} of ${targets.length} inbox(es) carry an activity`);
  await DeliveryQueue.deliverEach(deliveries, user.id);
  return 'completed';
}
