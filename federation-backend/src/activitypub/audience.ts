/**
 * Addressing of incoming ActivityPub objects: `to` and `cc` read once, the same way everywhere.
 *
 * An audience property is one value or an array (AS2 functional vs. non-functional compaction).
 * Each entry is an IRI string or an object read by its `id`, as Mastodon JsonLdHelper#value_or_id,
 * Misskey getApId and Pleroma ObjectValidators.ObjectID read it; none of them reads a Link's
 * `href` there. JSON-LD compaction writes the Public collection as `as:Public` or `Public`; it is
 * expanded to AS_PUBLIC here, as Mastodon TagManager#public_collection? accepts all three.
 *
 * Visibility mirrors Mastodon ActivityPub::Parser::StatusParser#visibility: Public in `to` is
 * public, in `cc` unlisted; the author's followers collection is followers-only; anything else,
 * an object addressed to nobody included, is direct. The followers collection is the one the
 * actor declares, else `<actor>/followers`, and counts in `to` or `cc`: Misskey
 * ApAudienceService#isFollowers. Mastodon and GoToSocial read it in `to` only.
 */

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
  const value = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : entry;
  if (typeof value !== 'string' || value === '') return null;
  return value === 'as:Public' || value === 'Public' ? AS_PUBLIC : value;
}

/**
 * One audience property as a list of IRIs, in order, without duplicates; at most `limit` of
 * them. Linear: Harmony addresses a channel message to every member on the receiving instance.
 */
export function addresses(value: unknown, limit = Infinity): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const out = new Set<string>();
  for (const entry of entries) {
    if (out.size >= limit) break;
    const address = addressOf(entry);
    if (address !== null) out.add(address);
  }
  return [...out];
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

/** WHATWG-normalised http(s) IRI without one trailing slash; the string itself otherwise. */
function addressKey(address: string): string {
  const url = urlOf(address);
  const key = url && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : address;
  return key.endsWith('/') ? key.slice(0, -1) : key;
}

/** Same IRI, ignoring host case, a default port and one trailing slash. */
export function sameAddress(a: string, b: string): boolean {
  return addressKey(a) === addressKey(b);
}

function urlOf(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const isWeb = (url: URL | null): url is URL => url?.protocol === 'https:' || url?.protocol === 'http:';

/**
 * The author's followers collection as a comparison key: the stored `followers` IRI, else
 * `<actor>/followers`; null when neither is an http(s) IRI.
 */
function followersKey(author: AudienceAuthor): string | null {
  const declared = urlOf(author.followersUrl);
  if (isWeb(declared)) return addressKey(declared.href);
  const actor = urlOf(author.actorUrl);
  return isWeb(actor) ? `${addressKey(actor.href)}/followers` : null;
}

/** The author's followers test, with the author parsed once for a whole recipient list. */
function followersTest(author: AudienceAuthor): (address: string) => boolean {
  const key = followersKey(author);
  if (key === null) return () => false;
  // Parsed only when the collection's path occurs in it.
  const path = new URL(key).pathname.toLowerCase();
  return (address) => address.toLowerCase().includes(path) && addressKey(address) === key;
}

/** True when `address` is the author's followers collection (see followersKey). */
export function isFollowersAddress(address: string, author: AudienceAuthor = {}): boolean {
  return followersTest(author)(address);
}

export function visibilityOf(audience: Audience, author: AudienceAuthor = {}): Visibility {
  if (audience.to.includes(AS_PUBLIC)) return 'public';
  if (audience.cc.includes(AS_PUBLIC)) return 'unlisted';
  const recipients = recipientsOf(audience);
  const isFollowers = followersTest(author);
  if (recipients.some(isFollowers)) return 'followers';
  return 'direct';
}

const GROUP_TYPES = new Set(['Group', 'Organization', 'Service']);

/**
 * The author's actor IRI: the first `attributedTo` entry that is not a Group (PeerTube lists the
 * channel after the account), else the first one, else the activity's actor.
 */
export function authorActorUrl(object: any, activity?: any): string | null {
  const idOf = (value: any): string | null => {
    const url = typeof value === 'string' ? value : value?.id;
    return typeof url === 'string' && url !== '' ? url : null;
  };
  const attributed: any[] = Array.isArray(object?.attributedTo) ? object.attributedTo : [object?.attributedTo];
  const person = attributed.find((entry) => idOf(entry) && !(entry && GROUP_TYPES.has(entry.type)));
  return idOf(person) ?? attributed.map(idOf).find(Boolean) ?? idOf(activity?.actor);
}
