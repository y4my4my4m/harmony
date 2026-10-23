/**
 * FEP-044f consent-respecting quotes (Mastodon 4.5).
 *
 * Quoted side: a QuoteRequest for a local post is answered by its author's instance with an
 * Accept whose `result` is a QuoteAuthorization (stored in quote_authorizations and served
 * at stampUrl), or a Reject. Approval is automatic within the post's canQuote policy
 * (toActivityPub.quotePolicy): anyone for public and unlisted posts, followers for
 * followers-only posts, nobody for direct posts; never an account the author blocks.
 *
 * Quoting side: a local quote of a remote post sends a QuoteRequest to the quoted author
 * after its Create; an Accept stores the stamp in posts.metadata.quote_authorization and
 * the Note is re-sent as an Update carrying quoteAuthorization. A quote of another local
 * user's post is stamped locally when serialized. A self-quote needs no stamp.
 */

import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';
import { normalizeActor } from './converters/fromActivityPub.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const QUOTE_ACTIVITY_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  {
    QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest',
    QuoteAuthorization: 'https://w3id.org/fep/044f#QuoteAuthorization',
    quote: { '@id': 'https://w3id.org/fep/044f#quote', '@type': '@id' },
    gts: 'https://gotosocial.org/ns#',
    interactingObject: { '@id': 'gts:interactingObject', '@type': '@id' },
    interactionTarget: { '@id': 'gts:interactionTarget', '@type': '@id' },
  },
];

/** Id of a local post named by its AP id (`/posts/<uuid>`) or a page (`/@<name>/<uuid>`, `/social/post/<uuid>`). */
export function localPostIdFromUri(uri: unknown): string | null {
  if (typeof uri !== 'string') return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.host.toLowerCase() !== String(config.INSTANCE_DOMAIN).toLowerCase()) return null;
  const m = url.pathname.match(/^\/(?:posts|social\/post|@[A-Za-z0-9_]+)\/([0-9a-f-]{36})\/?$/i);
  return m && UUID_RE.test(m[1]) ? m[1].toLowerCase() : null;
}

export function stampUrl(authorUsername: string, stampId: string): string {
  return `https://${config.INSTANCE_DOMAIN}/users/${authorUsername}/quote_authorizations/${stampId}`;
}

/** QuoteRequest id of a local quote post's Note. */
export function quoteRequestId(noteId: string): string {
  return `${noteId}#quote-request`;
}

export interface QuotedPostRow {
  id: string;
  ap_id: string | null;
  author_id: string;
  visibility: string;
  is_deleted?: boolean | null;
}

/** AP id of a local post. */
function localPostApId(post: { id: string; ap_id: string | null }): string {
  return post.ap_id || `https://${config.INSTANCE_DOMAIN}/posts/${post.id}`;
}

/** QuoteAuthorization document of a stored stamp. */
export function quoteAuthorizationObject(
  stamp: { id: string; quoting_post_uri: string },
  quotedPost: { id: string; ap_id: string | null },
  authorUsername: string,
): any {
  return {
    '@context': QUOTE_ACTIVITY_CONTEXT,
    type: 'QuoteAuthorization',
    id: stampUrl(authorUsername, stamp.id),
    attributedTo: `https://${config.INSTANCE_DOMAIN}/users/${authorUsername}`,
    interactingObject: stamp.quoting_post_uri,
    interactionTarget: localPostApId(quotedPost),
  };
}

/**
 * Whether `quoterId` may quote `post` under its canQuote policy. Public and unlisted: anyone;
 * followers-only: accepted followers; direct: nobody. The author's own quotes always pass.
 * An account the author blocks never does.
 */
export async function quotePermitted(post: QuotedPostRow, quoterId: string | null): Promise<boolean> {
  if (post.is_deleted) return false;
  if (quoterId && quoterId === post.author_id) return true;
  const supabase = getSupabaseClient();
  if (quoterId) {
    const { data: block } = await supabase
      .from('user_blocks')
      .select('id')
      .eq('blocker_id', post.author_id)
      .eq('blocked_user_id', quoterId)
      .maybeSingle();
    if (block) return false;
  }
  if (post.visibility === 'public' || post.visibility === 'unlisted') return true;
  if (post.visibility !== 'followers' || !quoterId) return false;
  const { data: follow } = await supabase
    .from('follows')
    .select('id')
    .eq('follower_id', quoterId)
    .eq('following_id', post.author_id)
    .eq('status', 'accepted')
    .maybeSingle();
  return !!follow;
}

/** The stamp approving `quotingPostUri` as a quote of `quotedPost`, created when absent. Returns its id. */
export async function ensureStamp(
  quotedPost: { id: string },
  quotingPostUri: string,
  quotingActorUri: string,
  requestUri: string | null,
): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data: existing } = await supabase
    .from('quote_authorizations')
    .select('id')
    .eq('quoted_post_id', quotedPost.id)
    .eq('quoting_post_uri', quotingPostUri)
    .maybeSingle();
  if (existing) return existing.id as string;
  const { data, error } = await supabase
    .from('quote_authorizations')
    .upsert(
      { quoted_post_id: quotedPost.id, quoting_post_uri: quotingPostUri, quoting_actor_uri: quotingActorUri, request_uri: requestUri },
      { onConflict: 'quoted_post_id,quoting_post_uri', ignoreDuplicates: false },
    )
    .select('id')
    .single();
  if (error || !data) {
    logger.warn(`Quote stamp for ${quotingPostUri} → ${quotedPost.id} not stored: ${error?.message}`);
    return null;
  }
  return data.id as string;
}

/**
 * QuoteRequest addressed to a local post. Answered from the quoted author with Accept and a
 * stamp, or Reject. The requesting actor must author the quote post (`instrument`), which
 * must name the requested post as its quote when it is embedded.
 */
export async function processQuoteRequest(
  activity: any,
  deps: {
    resolveProfile: (actorUrl: string) => Promise<{ id: string } | null>;
    sendToInbox: (inbox: string, activity: any, senderProfileId: string) => Promise<unknown>;
  },
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = normalizeActor(activity.actor);
  const postId = localPostIdFromUri(typeof activity.object === 'string' ? activity.object : activity.object?.id);
  const instrument = activity.instrument;
  const quotingPostUri = typeof instrument === 'string' ? instrument : instrument?.id;
  if (!actorUrl || !postId || typeof quotingPostUri !== 'string' || !/^https?:\/\//i.test(quotingPostUri)) {
    logger.info(`QuoteRequest ${activity.id} names no local post or quote post; ignored`);
    return;
  }
  if (instrument && typeof instrument === 'object') {
    const author = normalizeActor(instrument.attributedTo);
    if (author && author !== actorUrl) {
      logger.info(`QuoteRequest ${activity.id}: quote post attributed to ${author}, not ${actorUrl}; ignored`);
      return;
    }
  }

  const { data: post } = await supabase
    .from('posts')
    .select('id, ap_id, author_id, visibility, is_deleted, is_local')
    .eq('id', postId)
    .maybeSingle();
  if (!post || post.is_local === false) {
    logger.info(`QuoteRequest ${activity.id}: no local post ${postId}`);
    return;
  }
  const { data: author } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('id', post.author_id)
    .maybeSingle();
  const quoter = await deps.resolveProfile(actorUrl);
  const { data: quoterRow } = quoter
    ? await supabase.from('profiles').select('id, inbox_url, shared_inbox_url').eq('id', quoter.id).maybeSingle()
    : { data: null };
  if (!author || !quoterRow?.inbox_url) {
    logger.info(`QuoteRequest ${activity.id}: author or requester inbox unknown`);
    return;
  }

  const authorUrl = `https://${config.INSTANCE_DOMAIN}/users/${author.username}`;
  const request = {
    type: 'QuoteRequest',
    id: activity.id,
    actor: actorUrl,
    object: localPostApId(post),
    instrument: quotingPostUri,
  };

  const permitted = await quotePermitted(post, quoter?.id ?? null);
  const stampId = permitted ? await ensureStamp(post, quotingPostUri, actorUrl, typeof activity.id === 'string' ? activity.id : null) : null;
  const answer: any = {
    '@context': QUOTE_ACTIVITY_CONTEXT,
    type: stampId ? 'Accept' : 'Reject',
    id: stampId ? `${stampUrl(author.username, stampId)}#accept` : `${authorUrl}/quote_rejects/${randomUUID()}`,
    actor: authorUrl,
    to: actorUrl,
    object: request,
  };
  if (stampId) answer.result = stampUrl(author.username, stampId);

  await deps.sendToInbox(quoterRow.inbox_url, answer, author.id);
  logger.info(`QuoteRequest ${activity.id}: ${answer.type} for ${quotingPostUri} quoting ${post.id}`);
}

/**
 * Accept or Reject of a QuoteRequest sent for a local quote post. The responder must be the
 * quoted post's author, and an Accept's `result` a stamp on the responder's host. The stamp
 * lands in metadata.quote_authorization (Accept) or metadata.quote_state = 'rejected'.
 * Returns the quote post and its author when the Note changed, for the caller to send an Update.
 */
export async function processQuoteAnswer(activity: any, accepted: boolean): Promise<{ postId: string; authorId: string } | null> {
  const supabase = getSupabaseClient();
  const responder = normalizeActor(activity.actor);
  const request = activity.object;
  const instrument = typeof request === 'object' ? request?.instrument : null;
  const quotePostId = localPostIdFromUri(typeof instrument === 'string' ? instrument : instrument?.id)
    ?? localPostIdFromUri(typeof request === 'string' ? request.replace(/#quote-request$/, '') : request?.id?.replace?.(/#quote-request$/, ''));
  if (!quotePostId || !responder) return null;

  const { data: post } = await supabase
    .from('posts')
    .select('id, author_id, metadata, is_local')
    .eq('id', quotePostId)
    .maybeSingle();
  const quotedId = post?.metadata?.reblog_of;
  if (!post || post.is_local === false || !quotedId) return null;

  const { data: quoted } = await supabase
    .from('posts')
    .select('author:profiles!posts_author_id_fkey ( federated_id )')
    .eq('id', quotedId)
    .maybeSingle();
  const quotedAuthor = normalizeActor((quoted as any)?.author?.federated_id);
  if (!quotedAuthor || quotedAuthor !== responder) {
    logger.info(`Quote answer from ${responder} for ${quotePostId}: not the quoted author`);
    return null;
  }

  const metadata = { ...(post.metadata || {}) };
  if (accepted) {
    const result = typeof activity.result === 'string' ? activity.result : activity.result?.id;
    let resultHost: string | null = null;
    try { resultHost = result ? new URL(result).host : null; } catch { resultHost = null; }
    if (!result || resultHost !== new URL(responder).host) {
      logger.info(`Quote Accept for ${quotePostId} carries no stamp on ${new URL(responder).host}`);
      return null;
    }
    if (metadata.quote_authorization === result) return null;
    metadata.quote_authorization = result;
    delete metadata.quote_state;
  } else {
    if (metadata.quote_state === 'rejected') return null;
    metadata.quote_state = 'rejected';
    delete metadata.quote_authorization;
  }
  await supabase.from('posts').update({ metadata }).eq('id', quotePostId);
  logger.info(`Quote ${quotePostId} ${accepted ? 'approved' : 'rejected'} by ${responder}`);
  return { postId: quotePostId, authorId: post.author_id };
}

/**
 * QuoteRequest for a local quote of a remote post, from the quote's author to the quoted
 * author, with the quote post inlined as `instrument`.
 */
export function createQuoteRequestActivity(authorUsername: string, quotedApId: string, note: any): any {
  const { '@context': _context, ...instrument } = note;
  return {
    '@context': QUOTE_ACTIVITY_CONTEXT,
    type: 'QuoteRequest',
    id: quoteRequestId(note.id),
    actor: `https://${config.INSTANCE_DOMAIN}/users/${authorUsername}`,
    object: quotedApId,
    instrument,
  };
}

/** An Accept or Reject answering a QuoteRequest: the request embedded, or named by its id. */
export function answersQuoteRequest(activity: any): boolean {
  const object = activity?.object;
  if (object && typeof object === 'object') return object.type === 'QuoteRequest';
  return typeof object === 'string' && object.endsWith('#quote-request');
}
