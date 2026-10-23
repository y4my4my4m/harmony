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
 *
 * A report about a message in a server hosted elsewhere also goes to that
 * server's Group inbox (buildServerFlagActivity), as Lemmy sends a Flag to the
 * community: actor the instance actor, object [author, message], to [Group],
 * content the reporter's comment, harmony:reason the report reason. Its id is
 * <base>/flags/<report id>/server, distinct from the account Flag of the same
 * report. The host answers with the Group's Resolve (buildResolveActivity),
 * Lemmy's type for a resolved report since 1.0, object the Flag,
 * harmony:outcome 'resolved' (action taken) or 'dismissed'.
 */

import crypto from 'crypto';
import { HARMONY_CONTEXT } from './harmonyContext.js';

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

export function serverFlagActivityId(baseUrl: string, reportId: string): string {
  return `${baseUrl}/flags/${reportId}/server`;
}

/** Report id of a server Flag this instance sent, from its id; null for any other URI. */
export function serverFlagReportId(flagId: unknown, baseUrl: string): string | null {
  if (typeof flagId !== 'string') return null;
  const prefix = `${baseUrl}/flags/`;
  if (!flagId.startsWith(prefix)) return null;
  const m = flagId.slice(prefix.length).match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/server$/i);
  return m ? m[1].toLowerCase() : null;
}

export const REPORT_REASONS = ['spam', 'harassment', 'illegal_content', 'impersonation', 'nsfw', 'other'] as const;

export interface ServerFlagActivity {
  '@context': [string, typeof HARMONY_CONTEXT];
  id: string;
  type: 'Flag';
  actor: string;
  object: string[];
  to: string[];
  content: string;
  'harmony:reason'?: string;
}

export function buildServerFlagActivity(params: {
  baseUrl: string;
  reportId: string;
  actor: string;
  groupUri: string;
  authorUri: string | null;
  messageUri: string;
  comment: string | null | undefined;
  reason: string | null | undefined;
}): ServerFlagActivity {
  const reason = (REPORT_REASONS as readonly string[]).includes(params.reason ?? '') ? params.reason! : null;
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', HARMONY_CONTEXT],
    id: serverFlagActivityId(params.baseUrl, params.reportId),
    type: 'Flag',
    actor: params.actor,
    object: params.authorUri ? [params.authorUri, params.messageUri] : [params.messageUri],
    to: [params.groupUri],
    content: params.comment ?? '',
    ...(reason ? { 'harmony:reason': reason } : {}),
  };
}

export const REPORT_OUTCOMES = ['resolved', 'dismissed'] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

/** The outcome a Resolve carries; null when it names none Harmony knows. */
export function resolveOutcome(activity: any): ReportOutcome | null {
  const outcome = activity?.['harmony:outcome'];
  return (REPORT_OUTCOMES as readonly string[]).includes(outcome) ? outcome as ReportOutcome : null;
}

/**
 * The Group's Resolve of a Flag. The id is fixed per resolution (report id and resolved_at,
 * in ms), so a resend is deduplicated and a resolution after a reopen is not.
 */
export function buildResolveActivity(params: {
  groupUri: string;
  reportId: string;
  resolvedAt: string;
  flagId: string;
  flagActor: string;
  outcome: ReportOutcome;
}): Record<string, unknown> {
  const at = new Date(params.resolvedAt);
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', HARMONY_CONTEXT],
    id: `${params.groupUri}/activities/report-${params.reportId}-${at.getTime()}`,
    type: 'Resolve',
    actor: params.groupUri,
    object: { id: params.flagId, type: 'Flag', actor: params.flagActor },
    to: [params.flagActor],
    published: at.toISOString(),
    'harmony:outcome': params.outcome,
  };
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
  | { kind: 'post'; id: string }
  | { kind: 'message'; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * The local account, post or message an object URI names by path, or null. Forms:
 * /users/<name>, /@<name>, /posts/<uuid>, /messages/<uuid>. URIs on other hosts are null.
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
  if (parts.length === 2 && parts[0] === 'messages' && UUID_RE.test(parts[1])) {
    return { kind: 'message', id: parts[1].toLowerCase() };
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
