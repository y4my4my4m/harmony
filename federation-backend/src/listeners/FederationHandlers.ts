/**
 * Federation Handlers - Create ActivityPub activities from database events
 */

import { 
  postToNote, 
  createFollowActivity as createFollow,
  followActivityId,
  createAnnounceActivity as createAnnounce,
  createUpdateActivity,
  createDeleteActivity as createDelete,
  createUndoActivity,
} from '../activitypub/converters/toActivityPub.js';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { createQuoteRequestActivity, ensureStamp, quotePermitted, stampUrl } from '../activitypub/quoteAuthorization.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stored actor ids of the profiles a post mentions, keyed by profile id.
 * Composer mention parts carry the profile id in `userId`.
 */
export async function resolveMentionActorUrls(content: any): Promise<Map<string, string>> {
  const actorUrls = new Map<string, string>();
  if (!Array.isArray(content)) return actorUrls;

  const ids = Array.from(new Set<string>(
    content
      .filter((part: any) => part?.type === 'mention' && typeof part.userId === 'string' && UUID_RE.test(part.userId))
      .map((part: any) => part.userId),
  ));
  if (ids.length === 0) return actorUrls;

  const { data } = await getSupabaseClient()
    .from('profiles')
    .select('id, federated_id')
    .in('id', ids);
  for (const row of data || []) {
    if (row.federated_id) actorUrls.set(row.id, row.federated_id);
  }
  return actorUrls;
}

/** `posts.in_reply_to` is a UUID; the Note carries the parent's AP id. */
async function resolveInReplyTo(note: any, post: any): Promise<void> {
  if (!post.in_reply_to) return;
  const { data: parentPost } = await getSupabaseClient()
    .from('posts')
    .select('ap_id')
    .eq('id', post.in_reply_to)
    .single();
  note.inReplyTo = parentPost?.ap_id || `https://${config.INSTANCE_DOMAIN}/posts/${post.in_reply_to}`;
}

/** The quoted post of a local quote, and its author's actor and inbox when remote. */
export interface QuoteTarget {
  id: string;
  apId: string;
  authorId: string;
  /** Null for a local author. */
  authorActorUrl: string | null;
  authorInbox: string | null;
  authorUsername: string | null;
  visibility: string;
  isLocal: boolean;
  isDeleted: boolean;
}

export async function loadQuoteTarget(post: any): Promise<QuoteTarget | null> {
  const quotedId = post.metadata?.is_quote ? post.metadata?.reblog_of : null;
  if (!quotedId) return null;
  const { data: quoted } = await getSupabaseClient()
    .from('posts')
    .select('id, ap_id, author_id, visibility, is_local, is_deleted, author:profiles!posts_author_id_fkey ( username, federated_id, inbox_url, shared_inbox_url, is_local )')
    .eq('id', quotedId)
    .maybeSingle();
  if (!quoted) return null;
  const author: any = (quoted as any).author;
  const remote = author?.is_local === false;
  return {
    id: quoted.id,
    apId: quoted.ap_id || `https://${config.INSTANCE_DOMAIN}/posts/${quoted.id}`,
    authorId: quoted.author_id,
    authorActorUrl: remote ? author.federated_id || null : null,
    authorInbox: remote ? author.shared_inbox_url || author.inbox_url || null : null,
    authorUsername: author?.username ?? null,
    visibility: quoted.visibility,
    isLocal: quoted.is_local !== false,
    isDeleted: quoted.is_deleted === true,
  };
}

/**
 * The FEP-044f stamp of a local quote: issued here when the quoted post is local and by
 * someone else (within its policy), recorded from the quoted author's Accept when remote.
 * A self-quote carries none.
 */
async function quoteAuthorizationFor(post: any, author: any, target: QuoteTarget, noteId: string): Promise<string | null> {
  if (target.authorId === post.author_id) return null;
  if (!target.isLocal) {
    return typeof post.metadata?.quote_authorization === 'string' ? post.metadata.quote_authorization : null;
  }
  if (!target.authorUsername) return null;
  const quoted = { id: target.id, ap_id: target.apId, author_id: target.authorId, visibility: target.visibility, is_deleted: target.isDeleted };
  if (!(await quotePermitted(quoted, post.author_id))) return null;
  const stampId = await ensureStamp(quoted, noteId, `https://${config.INSTANCE_DOMAIN}/users/${author.username}`, null);
  return stampId ? stampUrl(target.authorUsername, stampId) : null;
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The Note of a local post, as every outbound path serves it: Create, Update, outbox,
 * GET /posts/:id and featured. Mentions name the stored actor ids, inReplyTo the parent's
 * AP id, a quote its target and stamp; likes and shares carry their counts. `updated` marks
 * an edited post.
 */
export async function buildLocalNote(post: any, author: any): Promise<any> {
  const noteId = post.ap_id || `https://${config.INSTANCE_DOMAIN}/posts/${post.id}`;
  const target = await loadQuoteTarget(post);
  const quoteAuthorization = target ? await quoteAuthorizationFor(post, author, target, noteId) : null;
  const note = postToNote(post, author, target?.apId, await resolveMentionActorUrls(post.content), {
    quoteAuthorization,
    likesCount: countOrNull(post.favorites_count),
    sharesCount: countOrNull(post.reblogs_count),
  });
  await resolveInReplyTo(note, post);
  if (Array.isArray(post.edit_history) && post.edit_history.length > 0) {
    const updatedAt = Date.parse(post.updated_at);
    if (Number.isFinite(updatedAt)) note.updated = new Date(updatedAt).toISOString();
  }
  return note;
}

/**
 * QuoteRequest for a local quote of another account's remote post, to that author's inbox.
 * Null when the quote needs none (local or self quote) or was already approved.
 */
export async function quoteRequestFor(post: any, author: any, note: any): Promise<{ inbox: string; activity: any } | null> {
  const target = await loadQuoteTarget(post);
  if (!target || target.isLocal || target.authorId === post.author_id || !target.authorInbox) return null;
  if (post.metadata?.quote_authorization) return null;
  return { inbox: target.authorInbox, activity: createQuoteRequestActivity(author.username, target.apId, note) };
}

/**
 * Create a Create activity for a new post
 */
export async function createPostActivity(post: any, author: any): Promise<any> {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const activityId = `${authorUrl}/activities/${post.id}`;

  const note = await buildLocalNote(post, author);

  return {
    '@context': note['@context'] || 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Create',
    actor: authorUrl,
    published: post.created_at,
    to: note.to || ['https://www.w3.org/ns/activitystreams#Public'],
    cc: note.cc || [`${authorUrl}/followers`],
    object: note,
  };
}

/**
 * Create a Follow activity for the follows row `followId`.
 */
export function createFollowActivity(follower: any, following: any, followId: string): any {
  return createFollow(follower, following, followId);
}

/**
 * Re-export for backward compatibility. Prefer importing from toActivityPub directly.
 */
export { createLikeActivity } from '../activitypub/converters/toActivityPub.js';

/** The boosted post as the Announce names it, and where its author receives it. */
export interface ReblogTarget {
  objectUrl: string;
  /** Actor id of the original's author; null for a local author. */
  authorActorUrl: string | null;
  /** Shared inbox, else personal inbox, of a remote author. */
  authorInbox: string | null;
}

/** Null when the original row is gone. */
export async function loadReblogTarget(reblogPost: any): Promise<ReblogTarget | null> {
  const domain = config.INSTANCE_DOMAIN;
  const supabase = getSupabaseClient();
  const originalPostId = reblogPost.metadata?.reblog_of;
  if (!originalPostId) return null;

  const { data: original } = await supabase
    .from('posts')
    .select('id, ap_id, author_id')
    .eq('id', originalPostId)
    .maybeSingle();
  if (!original) return null;

  const { data: author } = await supabase
    .from('profiles')
    .select('federated_id, inbox_url, shared_inbox_url, is_local')
    .eq('id', original.author_id)
    .maybeSingle();
  const remote = author && author.is_local === false;

  return {
    objectUrl: original.ap_id || `https://${domain}/posts/${original.id}`,
    authorActorUrl: remote ? author.federated_id || null : null,
    authorInbox: remote ? author.shared_inbox_url || author.inbox_url || null : null,
  };
}

/** Id of the Announce a boost row federates as; the outbox serves the same id. */
export function announceActivityId(reblogPost: any): string {
  return reblogPost.ap_id || `https://${config.INSTANCE_DOMAIN}/activities/${reblogPost.id}`;
}

/**
 * Announce of a boost row. Addressing mirrors Mastodon's reblog: public is to
 * Public, cc followers; unlisted is to followers, cc Public. The original's
 * author is cc'd either way.
 */
export function createReblogActivity(user: any, reblogPost: any, target: ReblogTarget): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const followers = `${userUrl}/followers`;
  const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
  const unlisted = reblogPost.visibility === 'unlisted';
  const cc = unlisted ? [PUBLIC] : [followers];
  if (target.authorActorUrl) cc.push(target.authorActorUrl);

  return {
    ...createAnnounce(user, target.objectUrl),
    id: announceActivityId(reblogPost),
    published: reblogPost.created_at || new Date().toISOString(),
    to: unlisted ? [followers] : [PUBLIC],
    cc,
  };
}

/**
 * Create an Update activity (profile updates)
 */
export function createProfileUpdateActivity(profile: any): any {
  return createUpdateActivity(profile);
}

/**
 * Create a Delete activity for a post
 */
export function createDeleteActivity(author: any, post: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const objectUrl = post.ap_id || `https://${domain}/posts/${post.id}`;
  return createDelete(author, objectUrl);
}

/**
 * Undo of the Announce createReblogActivity built for the same row. Mastodon
 * and Misskey find the boost to retract by the embedded Announce id.
 */
export function createUndoAnnounceActivity(user: any, reblogPost: any, target: ReblogTarget): any {
  const { '@context': context, ...announce } = createReblogActivity(user, reblogPost, target);
  return {
    '@context': context,
    id: `${announce.id}/undo`,
    type: 'Undo',
    actor: announce.actor,
    to: announce.to,
    cc: announce.cc,
    object: announce,
  };
}

/**
 * Create an Undo Follow activity
 */
export function createUndoFollowActivity(follower: any, following: any, followRecord: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const followerUrl = `https://${domain}/users/${follower.username}`;
  
  const followActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: followRecord.ap_id || followActivityId(followRecord.id),
    type: 'Follow',
    actor: followerUrl,
    object: following.federated_id || following.id,
  };

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `https://${domain}/activities/undo-follow/${followRecord.id}`,
    type: 'Undo',
    actor: followerUrl,
    object: followActivity,
  };
}

/**
 * Create an Undo Like activity (remove reaction).
 *
 * `like` is the Like being undone, as createLikeActivity built it: same id, same
 * `_misskey_reaction` and tag, so a receiver holding several reactions from one actor
 * removes the one named. Without it the Undo carries a bare Like under a fresh id.
 */
export function createUndoLikeActivity(user: any, objectUrl: string, like?: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;

  if (like) {
    return createUndoActivity(user, like);
  }

  const likeActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${userUrl}/likes/${Date.now()}`,
    type: 'Like',
    actor: userUrl,
    object: objectUrl,
  };
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${userUrl}/undo/${Date.now()}`,
    type: 'Undo',
    actor: userUrl,
    object: likeActivity,
  };
}

/**
 * Create an Add activity (pin post to featured collection)
 */
export function createAddToFeaturedActivity(user: any, post: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const postUrl = post.ap_id || `https://${domain}/posts/${post.id}`;
  const featuredUrl = `${userUrl}/featured`;
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${userUrl}/add/${Date.now()}`,
    type: 'Add',
    actor: userUrl,
    object: postUrl,
    target: featuredUrl,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`],
  };
}

/**
 * Create a Remove activity (unpin post from featured collection)
 */
export function createRemoveFromFeaturedActivity(user: any, post: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const postUrl = post.ap_id || `https://${domain}/posts/${post.id}`;
  const featuredUrl = `${userUrl}/featured`;
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${userUrl}/remove/${Date.now()}`,
    type: 'Remove',
    actor: userUrl,
    object: postUrl,
    target: featuredUrl,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`],
  };
}

/**
 * Create a Block activity
 */
export function createBlockActivity(blocker: any, blocked: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const blockerUrl = `https://${domain}/users/${blocker.username}`;
  const blockedUrl = blocked.federated_id || `https://${blocked.domain}/users/${blocked.username}`;
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${blockerUrl}/blocks/${Date.now()}`,
    type: 'Block',
    actor: blockerUrl,
    object: blockedUrl,
  };
}

/**
 * Create an Undo Block activity (unblock)
 */
export function createUndoBlockActivity(blocker: any, blocked: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const blockerUrl = `https://${domain}/users/${blocker.username}`;
  const blockedUrl = blocked.federated_id || `https://${blocked.domain}/users/${blocked.username}`;
  
  const blockActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${blockerUrl}/blocks/${blocked.id}`,
    type: 'Block',
    actor: blockerUrl,
    object: blockedUrl,
  };
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${blockerUrl}/undo/${Date.now()}`,
    type: 'Undo',
    actor: blockerUrl,
    object: blockActivity,
  };
}

/**
 * Create an Update activity for an edited post
 */
export async function createPostUpdateActivity(post: any, author: any): Promise<any> {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const activityId = `${authorUrl}/activities/update-${post.id}-${Date.now()}`;

  const note = await buildLocalNote(post, author);

  // Mastodon applies an edit only when `updated` is later than the stored
  // edit time (ProcessStatusUpdateService#handle_explicit_update!); without
  // it the Update is treated as a poll refresh and the content is ignored.
  const updatedAt = Date.parse(post.updated_at);
  note.updated = Number.isFinite(updatedAt) && updatedAt > Date.parse(post.created_at)
    ? new Date(updatedAt).toISOString()
    : new Date().toISOString();

  return {
    '@context': note['@context'] || 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Update',
    actor: authorUrl,
    published: new Date().toISOString(),
    to: note.to || ['https://www.w3.org/ns/activitystreams#Public'],
    cc: note.cc || [`${authorUrl}/followers`],
    object: note,
  };
}

