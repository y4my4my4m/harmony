/**
 * Reblog/Announce + Quote-post unwrap helpers.
 *
 * In ActivityPub, a *pure reblog* (Boost / `Announce`) is a thin wrapper
 * around the original `Note`. Most user actions on a reblog row in a timeline
 * should target the original - not the wrapper:
 *
 *   - Replies should be addressed to the original author and threaded under
 *     the original note (Mastodon, Pleroma, Misskey all do this).
 *   - Thread context (ancestors / descendants) only exists relative to the
 *     original note; the Announce has no replies of its own.
 *   - Background remote fetches (replies / reactions) must use the original
 *     `ap_id`, otherwise we'd hit the Announce's collection (usually empty).
 *
 * A *quote post*, by contrast, is a first-class user post that *references*
 * another note. It carries its own content, its own author, its own replies,
 * and its own reactions. Quote posts are *not* reblogs for action-routing
 * purposes - replying to Alice's quote of Bob mentions Alice, not Bob, and
 * threads under Alice's quote, not Bob's note.
 *
 * Both kinds populate the `reblog` JSONB column (a quote stores the quoted
 * note there for display), so the unwrap rule has to discriminate carefully:
 * unwrap pure reblogs only.
 *
 * `MonyPost.originalPostId` (used for favorite / reblog / bookmark) does
 * NOT discriminate today - that's a pre-existing UX issue (favoriting a
 * quote post favorites the quoted note rather than the quote itself). It
 * is intentionally left untouched by this module to keep this commit
 * scoped to the reply / context bugs the user reported; the same
 * `isQuotePost` exclusion can be applied to that computed in a follow-up
 * if the favorite/reblog/bookmark routing needs to be corrected too.
 */

import type { TimelinePost, ActivityPubPost, FederatedUser } from '@/types';

/**
 * `true` if the post is a quote - a first-class user post that references
 * another note via `reblog`. Mirrors `MonyPost.isQuotePost`'s logic so all
 * code paths agree on classification.
 */
export function isQuotePost(post: TimelinePost | ActivityPubPost | null | undefined): boolean {
  if (!post) return false;
  const p = post as TimelinePost;

  // Explicit metadata signal (set by federation backend for inbound quotes
  // and by the local quote-compose path).
  if (p.metadata?.is_quote || p.metadata?.quote_url) {
    return true;
  }

  // Inferred fallback for older data without metadata: a post is a quote if
  // it has BOTH a `reblog` reference AND its own non-empty user content that
  // differs from the quoted post's content. Pure reblogs duplicate the
  // wrapped note's content (no user authored anything).
  if (!p.reblog) return false;
  const content = p.content;
  if (!Array.isArray(content) || content.length === 0) return false;

  const hasUserContent = content.some(
    (part: any) => part?.type === 'text' && part?.text && part.text.trim().length > 0,
  );
  if (!hasUserContent) return false;

  const reblogContent = p.reblog.content;
  if (Array.isArray(reblogContent)) {
    const join = (parts: any[]) =>
      parts
        .filter((x) => x?.type === 'text' && typeof x.text === 'string')
        .map((x) => x.text.trim())
        .join(' ');
    if (join(content) === join(reblogContent)) return false;
  }

  return true;
}

/**
 * `true` if the post is a *pure* reblog / Announce wrapper.
 *
 * A pure reblog has no user-authored content of its own - the timeline row
 * exists only to surface the reblogged note. Quote posts are NOT pure
 * reblogs (they carry the quoter's commentary), so this returns `false` for
 * them even though they share the same `reblog` column.
 */
export function isReblogPost(post: TimelinePost | ActivityPubPost | null | undefined): boolean {
  if (!post) return false;
  const p = post as TimelinePost;
  const looksLikeReblog = !!(
    (p.reblog && p.reblog_author) ||
    p.metadata?.is_reblog ||
    p.metadata?.reblog_of ||
    p.ap_type === 'Announce'
  );
  if (!looksLikeReblog) return false;
  // Quote posts also satisfy the structural check above; exclude them so
  // reply / reaction routing keeps them as first-class posts.
  return !isQuotePost(p);
}

/**
 * `true` if the post is a reblog wrapper but the wrapped note isn't
 * hydrated (no `post.reblog` / `post.reblog_author`). We can't unwrap in
 * that case, so callers should avoid attributing actions to the booster
 * (e.g. don't prefill an `@booster` mention in a reply composer).
 */
export function isUnhydratedReblog(post: TimelinePost | null | undefined): boolean {
  if (!post) return false;
  return isReblogPost(post) && !post.reblog;
}

/**
 * Returns the post that user actions (replies, reactions, etc.) should
 * target.
 *
 * For pure reblogs, this is `post.reblog` with its `author` slot guaranteed
 * to be populated (falling back to the flat `post.reblog_author` field when
 * `post.reblog.author` is missing - `ActivityPubPost.author` is optional).
 *
 * For quote posts, regular posts, and unhydrated reblogs, returns `post`
 * unchanged. Callers that need to *know* whether unwrapping happened should
 * compose with `isReblogPost(post)` / `isUnhydratedReblog(post)`.
 */
export function getOriginalPost(post: TimelinePost): TimelinePost {
  if (!isReblogPost(post)) return post;
  if (!post.reblog) return post; // unhydrated; can't unwrap

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
 * UUID of the post that user actions should target.
 *
 * Use this for any local-DB operation (reactions, reply threading, RPC
 * calls like `get_post_with_context`). Pure reblogs unwrap to the original
 * id; quote posts and regular posts use their own id.
 */
export function getOriginalPostId(post: TimelinePost): string {
  if (!isReblogPost(post)) return post.id;
  if (post.reblog?.id) return post.reblog.id;
  const fromMeta = post.metadata?.reblog_of;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  return post.id;
}

/**
 * ActivityPub `ap_id` of the post that user actions should target.
 *
 * Use this for federation backend calls (`/fetch-replies`, `/fetch-reactions`,
 * `/resolve-post`) so we hit the right origin instance's `Note`.
 */
export function getOriginalApId(post: TimelinePost): string | undefined {
  if (!isReblogPost(post)) return post.ap_id;
  if (post.reblog?.ap_id) return post.reblog.ap_id;
  const fromMeta = post.metadata?.original_ap_id;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  return post.ap_id;
}

/**
 * Author to mention when prefilling a reply composer.
 *
 * - Regular post: the author.
 * - Pure reblog (hydrated): the original author (so we mention whoever wrote
 *   the boosted note, not the booster).
 * - Quote post: the quoter (we're replying to their commentary, not the
 *   quoted post).
 * - Unhydrated reblog: `undefined` - we don't know the original author and
 *   silently mentioning the booster would mislead the user. Callers should
 *   skip mention prefill in this case.
 */
export function getReplyMentionAuthor(post: TimelinePost): FederatedUser | undefined {
  if (isUnhydratedReblog(post)) return undefined;
  const target = getOriginalPost(post);
  return target.author as unknown as FederatedUser | undefined;
}
