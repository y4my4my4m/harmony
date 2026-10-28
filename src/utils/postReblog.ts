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
 *     `ap_id`; the Announce's own collection is usually empty.
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
 * `MonyPost.isPureReblog` applies the same discrimination for interaction
 * routing (favorite / reblog / bookmark target the quote itself).
 */

import type { TimelinePost, ActivityPubPost, FederatedUser } from '@/types';
import { isMassMentionWord } from '@/utils/massMentions';
import { runtimeConfig } from '@/services/runtimeConfig';

/**
 * Content without the lone "@" a text part ends with right before a mention part. Remote
 * posts parsed before 2026-10-02 kept the mention anchor's "@" as text, so they render
 * "@@user". Other content is returned unchanged.
 */
export function withoutStrayMentionAt<T>(content: T): T {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out: any[] = [];
  content.forEach((part: any, i: number) => {
    const next = content[i + 1] as any;
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.endsWith('@') && next?.type === 'mention') {
      changed = true;
      const text = part.text.slice(0, -1);
      if (text) out.push({ ...part, text });
      return;
    }
    out.push(part);
  });
  return (changed ? out : content) as T;
}

/** The quoted post's URL of a quote post, from the federation backend or the local compose path. */
export function quoteTargetUrl(post: TimelinePost | null | undefined): string | null {
  const m = (post as TimelinePost | null | undefined)?.metadata;
  const url = m?.quote_ap_url || m?.quote_url;
  return typeof url === 'string' && url ? url : null;
}

/**
 * Content without the leading "RE: <quoted url>" line that FEP-044f quote posts carry for
 * software that cannot show quotes (Mastodon's span or p of class quote-inline).
 */
export function withoutQuoteFallback<T extends { type?: string; text?: string; url?: string }>(
  content: T[] | null | undefined,
  quoteUrl: string | null,
): T[] {
  const parts = Array.isArray(content) ? content : [];
  if (!quoteUrl || parts.length < 2) return parts;
  const [first, second] = parts;
  if (first?.type !== 'text' || !/^\s*RE:\s*$/i.test(first.text ?? '')) return parts;
  if (second?.type !== 'url' || second.url !== quoteUrl) return parts;
  const rest = parts.slice(2);
  const next = rest[0];
  if (next?.type === 'text' && typeof next.text === 'string') {
    const text = next.text.replace(/^\s+/, '');
    return text ? [{ ...next, text }, ...rest.slice(1)] : rest.slice(1);
  }
  return rest;
}

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
  // it has both a `reblog` reference and its own non-empty user content that
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
 * exists only to surface the reblogged note. Quote posts are not pure
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
 * hydrated (no `post.reblog` / `post.reblog_author`). Unwrapping is
 * impossible; callers must not attribute actions to the booster (e.g. no
 * `@booster` mention prefill in a reply composer).
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
 * `/resolve-post`) to target the origin instance's `Note`.
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
 * - Pure reblog (hydrated): the author of the boosted note, not the booster.
 * - Quote post: the quoter - the reply targets their commentary, not the
 *   quoted post.
 * - Unhydrated reblog: `undefined`. The original author is unknown and
 *   mentioning the booster would misattribute the reply; callers skip
 *   mention prefill.
 */
export function getReplyMentionAuthor(post: TimelinePost): FederatedUser | undefined {
  if (isUnhydratedReblog(post)) return undefined;
  const target = getOriginalPost(post);
  return target.author as unknown as FederatedUser | undefined;
}

/**
 * Composer prefill for a reply, as Mastodon builds it: the replied-to author, then each account
 * the post mentions in order, once each and never the viewer, followed by one space. Empty when
 * nobody remains (a reply to one's own post that mentions no one) or the author is unknown.
 *
 * A remote post names a local account by actor URL, not profile id, so the viewer is also
 * matched as a local account of the same username.
 */
export function replyMentionPrefill(
  post: TimelinePost,
  viewer: { id?: string | null; username?: string | null } | null | undefined,
): string {
  const author = getReplyMentionAuthor(post);
  if (!author) return '';
  const viewerName = viewer?.username?.toLowerCase();
  const isViewer = (id: string | undefined, username: string, isLocal: boolean) =>
    (!!viewer?.id && id === viewer.id) || (isLocal && !!viewerName && username.toLowerCase() === viewerName);
  const handles: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined, username: string | undefined, domain: string | undefined, isLocal: boolean) => {
    if (!username || isViewer(id, username, isLocal)) return;
    // A local account named everyone or here keeps its host: bare, the word is the mass mention.
    const host = domain || (isLocal ? (runtimeConfig.domain as string) : '');
    const handle = (!isLocal || isMassMentionWord(username)) && host ? `@${username}@${host}` : `@${username}`;
    const key = handle.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    handles.push(handle);
  };
  add(author.id, author.username, author.domain, author.is_local !== false);
  for (const part of getOriginalPost(post).content ?? []) {
    if (part.type === 'mention') add(part.userId, part.username, part.domain, part.isLocal);
  }
  return handles.length ? `${handles.join(' ')} ` : '';
}

type Visibility = 'public' | 'unlisted' | 'followers' | 'direct';
const VISIBILITY_RANK: Record<Visibility, number> = { public: 0, unlisted: 1, followers: 2, direct: 3 };

/**
 * Starting visibility of a reply, as Mastodon picks it: the more restrictive of the replier's
 * preferred visibility and the replied-to post's. A reply to an unlisted post is unlisted, a
 * reply in a direct conversation stays direct. The composer still lets the replier change it.
 */
export function replyVisibility(post: TimelinePost, preferred: Visibility | null | undefined): Visibility {
  const mine: Visibility = preferred && preferred in VISIBILITY_RANK ? preferred : 'public';
  const parent = getOriginalPost(post).visibility as Visibility | undefined;
  if (!parent || !(parent in VISIBILITY_RANK)) return mine;
  return VISIBILITY_RANK[parent] > VISIBILITY_RANK[mine] ? parent : mine;
}
