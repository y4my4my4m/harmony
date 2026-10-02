/**
 * Flag (report) activities.
 *
 * Outbound shape mirrors Mastodon's ActivityPub::FlagSerializer: actor is the
 * instance actor, object is [account URI, status URIs...], content is the
 * reporter's comment. Nothing in it names the reporter.
 *
 * Inbound handling mirrors ActivityPub::Activity::Flag: only local accounts and
 * local statuses are considered, and a status counts only toward a report on
 * its own author. One deviation: a Flag naming statuses but no account (Lemmy
 * reports a post or comment alone) is attributed to the statuses' authors.
 */

import crypto from 'crypto';

export const FLAG_COMMENT_MAX = 1000;
export const FLAG_OBJECTS_MAX = 100;

export interface FlagActivity {
  '@context': string;
  id: string;
  type: 'Flag';
  actor: string;
  object: string[];
  content: string;
}

export function flagActivityId(baseUrl: string, reportId: string): string {
  return `${baseUrl}/flags/${reportId}`;
}

export function buildFlagActivity(params: {
  baseUrl: string;
  reportId: string;
  actor: string;
  targetActorUri: string;
  statusUris: string[];
  comment: string | null | undefined;
}): FlagActivity {
  const statuses = [...new Set(params.statusUris.filter((u) => typeof u === 'string' && u.length > 0))]
    .filter((u) => u !== params.targetActorUri);
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: flagActivityId(params.baseUrl, params.reportId),
    type: 'Flag',
    actor: params.actor,
    object: [params.targetActorUri, ...statuses],
    content: params.comment ?? '',
  };
}

/** Object URIs of a Flag: strings or objects with an id, deduplicated, capped. */
export function flagObjectUris(object: unknown): string[] {
  const items = Array.isArray(object) ? object : object == null ? [] : [object];
  const uris: string[] = [];
  for (const item of items) {
    const uri = typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id;
    if (typeof uri === 'string' && uri.length > 0 && uri.length <= 2048 && !uris.includes(uri)) {
      uris.push(uri);
      if (uris.length >= FLAG_OBJECTS_MAX) break;
    }
  }
  return uris;
}

export type LocalObjectRef =
  | { kind: 'account'; username: string }
  | { kind: 'post'; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * The local account or post an object URI names by path, or null. Forms:
 * /users/<name>, /@<name>, /posts/<uuid>. URIs on other hosts are null.
 */
export function parseLocalObjectUri(uri: string, instanceDomain: string): LocalObjectRef | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.host.toLowerCase() !== instanceDomain.toLowerCase()) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'users' && USERNAME_RE.test(parts[1])) {
    return { kind: 'account', username: parts[1] };
  }
  if (parts.length === 1 && parts[0].startsWith('@') && USERNAME_RE.test(parts[0].slice(1))) {
    return { kind: 'account', username: parts[0].slice(1) };
  }
  if (parts.length === 2 && parts[0] === 'posts' && UUID_RE.test(parts[1])) {
    return { kind: 'post', id: parts[1].toLowerCase() };
  }
  return null;
}

/** Report comment from Flag content: plain text, at most FLAG_COMMENT_MAX characters. */
export function flagComment(content: unknown): string {
  if (typeof content !== 'string') return '';
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
    .slice(0, FLAG_COMMENT_MAX);
}

/**
 * Stable id for a Flag delivered without one, so redeliveries deduplicate:
 * the actor URI plus a SHA-256 of the raw body.
 */
export function syntheticFlagId(actorUrl: string, rawBody: Buffer | string): string {
  const hash = crypto.createHash('sha256').update(rawBody).digest('hex');
  return `${actorUrl}#flag-${hash}`;
}
