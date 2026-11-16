/**
 * Addressing of incoming ActivityPub objects: `to` and `cc` read once, the same way everywhere.
 *
 * An audience property is one value or an array (AS2 functional vs. non-functional compaction).
 * Each entry is an IRI string, or an Object or Link carrying `id` or `href`. JSON-LD compaction
 * writes the Public collection as `as:Public` or `Public`; it is expanded to AS_PUBLIC here.
 *
 * Visibility mirrors Mastodon ActivityPub::Activity::Create#visibility_from_audience: Public in
 * `to` is public, in `cc` unlisted; the author's followers collection is followers-only; any
 * other recipient is direct. Deviations: the followers collection may sit in `cc` as well as
 * `to`; an object addressed to nobody is unlisted (Mastodon: direct), since a direct message
 * without recipients has no conversation to land in.
 */

import { sameOrigin } from '../utils/apOrigin.js';

export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

export type Visibility = 'public' | 'unlisted' | 'followers' | 'direct';

export interface Audience {
  to: string[];
  cc: string[];
}

/** What is known of the object's author. */
export interface AudienceAuthor {
  /** Actor IRI. */
  actorUrl?: string | null;
  /** The actor document's `followers`, as stored in profiles.followers_url. */
  followersUrl?: string | null;
}

function addressOf(entry: unknown): string | null {
  const value = typeof entry === 'string'
    ? entry
    : entry && typeof entry === 'object'
      ? ((entry as { id?: unknown }).id ?? (entry as { href?: unknown }).href)
      : null;
  if (typeof value !== 'string' || value === '') return null;
  return value === 'as:Public' || value === 'Public' ? AS_PUBLIC : value;
}

/** One audience property as a list of IRIs, in order, without duplicates. */
export function addresses(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of entries) {
    const address = addressOf(entry);
    if (address !== null && !out.includes(address)) out.push(address);
  }
  return out;
}

/**
 * `to` and `cc` of `object`, each taken from the wrapping `activity` when the object does not
 * state it: Mastodon Create#audience_to reads `@object['to'] || @json['to']`.
 */
export function audienceOf(object: any, activity?: any): Audience {
  const field = (name: 'to' | 'cc') =>
    addresses(object?.[name] != null ? object[name] : activity?.[name]);
  return { to: field('to'), cc: field('cc') };
}

/** Every recipient of `to` and `cc`. */
export function recipientsOf(audience: Audience): string[] {
  return [...new Set([...audience.to, ...audience.cc])];
}

/** Same IRI, ignoring one trailing slash. */
export function sameAddress(a: string, b: string): boolean {
  const strip = (s: string) => (s.endsWith('/') ? s.slice(0, -1) : s);
  return strip(a) === strip(b);
}

function hasFollowersSegment(address: string): boolean {
  try {
    return new URL(address).pathname.split('/').includes('followers');
  } catch {
    return false;
  }
}

/**
 * True when `address` is the author's followers collection. The stored `followers` IRI decides
 * when known. Otherwise an http(s) IRI with a path segment `followers`, on the author's host when
 * the author is known: `/users/a/followers` (Mastodon, Misskey), `/followers/a` (Friendica),
 * `.../users/1/followers` (WordPress), not `/users/followers_club`.
 */
export function isFollowersAddress(address: string, author: AudienceAuthor = {}): boolean {
  if (author.followersUrl) return sameAddress(address, author.followersUrl);
  if (!hasFollowersSegment(address)) return false;
  return !author.actorUrl || sameOrigin(address, author.actorUrl);
}

export function visibilityOf(audience: Audience, author: AudienceAuthor = {}): Visibility {
  if (audience.to.includes(AS_PUBLIC)) return 'public';
  if (audience.cc.includes(AS_PUBLIC)) return 'unlisted';
  const recipients = recipientsOf(audience);
  if (recipients.some((address) => isFollowersAddress(address, author))) return 'followers';
  return recipients.length > 0 ? 'direct' : 'unlisted';
}

/** The author's actor IRI as the object or activity names it. */
export function authorActorUrl(object: any, activity?: any): string | null {
  const attributed = Array.isArray(object?.attributedTo) ? object.attributedTo[0] : object?.attributedTo;
  const candidate = attributed ?? activity?.actor;
  const url = typeof candidate === 'string' ? candidate : candidate?.id;
  return typeof url === 'string' && url !== '' ? url : null;
}
