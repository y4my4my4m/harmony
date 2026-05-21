/**
 * Reblog/Announce unwrap helpers.
 *
 * In ActivityPub, a reblog (Boost / `Announce`) is a thin wrapper around the
 * original `Note`. Most user actions on a reblog row in a timeline should
 * actually target the *original* post — not the wrapper:
 *
 *   - Replies should be addressed to the original author and threaded under
 *     the original note (Mastodon, Pleroma, Misskey all do this).
 *   - Favorites / reblogs / bookmarks already target the original (see
 *     `MonyPost.originalPostId` and `activityPubService.toggleReblog`).
 *   - Thread context (ancestors / descendants) only exists relative to the
 *     original note; the Announce has no replies of its own.
 *   - Background remote fetches (replies / reactions) must use the original
 *     `ap_id`, otherwise we'd hit the Announce's collection (usually empty).
 *
 * These helpers centralize the "unwrap" logic so every call site uses the
 * same rules, including the awkward shape where `reblog_author` lives at the
 * top level (flattened from the timeline view) instead of on `reblog.author`.
 */

import type { TimelinePost, ActivityPubPost } from '@/types';

/**
 * `true` if the given timeline row is a pure reblog / Announce wrapper.
 *
 * Mirrors `MonyPost.isReblog` but works on a plain post object so it can be
 * used in plain `.ts` modules and outside of the component.
 */
export function isReblogPost(post: TimelinePost | ActivityPubPost | null | undefined): boolean {
  if (!post) return false;
  const p = post as TimelinePost;
  return !!(
    (p.reblog && p.reblog_author) ||
    p.metadata?.is_reblog ||
    p.metadata?.reblog_of ||
    p.ap_type === 'Announce'
  );
}

/**
 * Returns the post that user actions should target.
 *
 * For reblogs, this is `post.reblog` with its `author` slot guaranteed to be
 * populated (falling back to the flat `post.reblog_author` field when
 * `post.reblog.author` is missing — which can happen because
 * `ActivityPubPost.author` is optional).
 *
 * For everything else, returns the post itself.
 */
export function getOriginalPost(post: TimelinePost): TimelinePost {
  if (!post.reblog) return post;

  const original = post.reblog as TimelinePost;
  if (!original.author && post.reblog_author) {
    // `reblog.author` is optional on the wire; rehydrate from the flat field.
    // Cast through `any` because `reblog_author`'s structural shape differs
    // slightly from `EnhancedActivityPubPost.author` in optionality (the flat
    // field's `display_name`/`domain` are non-optional, but the consumers
    // here all already null-check author fields).
    return { ...original, author: post.reblog_author as any };
  }
  return original;
}

/**
 * UUID of the original post.
 *
 * Use this for any local-DB operation (reactions, reply threading, RPC
 * calls like `get_post_with_context`) so we don't query against the
 * Announce wrapper's id (which has no replies attached to it).
 */
export function getOriginalPostId(post: TimelinePost): string {
  if (post.reblog?.id) return post.reblog.id;
  const fromMeta = post.metadata?.reblog_of;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  return post.id;
}

/**
 * ActivityPub `ap_id` of the original post.
 *
 * Use this for federation backend calls (`/fetch-replies`, `/fetch-reactions`,
 * `/resolve-post`) so we hit the origin instance's `Note`, not the boost.
 */
export function getOriginalApId(post: TimelinePost): string | undefined {
  if (post.reblog?.ap_id) return post.reblog.ap_id;
  if (isReblogPost(post)) {
    const fromMeta = post.metadata?.original_ap_id;
    if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  }
  return post.ap_id;
}
