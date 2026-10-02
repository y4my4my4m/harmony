/**
 * Origin rules for ActivityPub documents.
 *
 * A host is authoritative only for ids on that host. A signed activity is
 * authoritative for objects on the signer's host. A fetched document is
 * authoritative only for its own id, and only when it was served from exactly
 * that id after redirects with an ActivityPub media type: any other URL on the
 * same host (an upload, a redirect target, a profile page) can carry a forged
 * document. Mirrors Mastodon JsonLdHelper#fetch_resource and
 * #valid_activitypub_content_type?.
 */

/** Lowercased `host[:port]` of an absolute http(s) URL; null for anything else. */
export function urlHost(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/** True when both values are http(s) URLs on the same host. */
export function sameOrigin(a: unknown, b: unknown): boolean {
  const hostA = urlHost(a);
  return hostA !== null && hostA === urlHost(b);
}

/** Both values are the same http(s) URL after WHATWG normalisation. */
export function sameUrl(a: unknown, b: unknown): boolean {
  if (urlHost(a) === null || urlHost(b) === null) return false;
  return new URL(a as string).href === new URL(b as string).href;
}

const AS_PROFILE = 'https://www.w3.org/ns/activitystreams';

/**
 * `application/activity+json`, or `application/ld+json` with the
 * ActivityStreams profile.
 */
export function isActivityPubContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const [mime, ...params] = contentType.split(';').map((p) => p.trim());
  const type = mime.toLowerCase();
  if (type === 'application/activity+json') return true;
  if (type !== 'application/ld+json') return false;
  return params.some((param) => {
    const m = param.match(/^profile\s*=\s*"?([^"]*)"?$/i);
    return !!m && m[1].split(/\s+/).includes(AS_PROFILE);
  });
}

/** A parsed document and the URL it was finally served from. */
export interface FetchedDocument {
  doc: any;
  finalUrl: string;
}

/**
 * Parsed body of a successful ActivityPub response; null for a failed status,
 * another media type or unparseable JSON. `requestedUrl` stands in when the
 * response carries no URL.
 */
export async function readApDocument(response: Response, requestedUrl: string): Promise<FetchedDocument | null> {
  if (!response.ok) return null;
  if (!isActivityPubContentType(response.headers.get('content-type'))) {
    try { await response.body?.cancel(); } catch { /* noop */ }
    return null;
  }
  try {
    const doc = await response.json();
    if (!doc || typeof doc !== 'object') return null;
    return { doc, finalUrl: response.url || requestedUrl };
  } catch {
    return null;
  }
}

function servedAtOwnId(fetched: FetchedDocument | null, id: string): boolean {
  return !!fetched && sameUrl(fetched.doc?.id, id) && sameUrl(fetched.finalUrl, id);
}

/**
 * Fetch a document whose id is not known in advance (a post URL, a WebFinger
 * link). A document served from its own id is kept; otherwise its id is
 * fetched once and that document must be served from that id.
 */
export async function fetchAuthoritativeDocument(
  url: string,
  fetchDoc: (url: string) => Promise<FetchedDocument | null>,
): Promise<any | null> {
  const first = await fetchDoc(url);
  const id = first?.doc?.id;
  if (typeof id !== 'string' || urlHost(id) === null) return null;
  if (servedAtOwnId(first, id)) return first!.doc;

  const refetched = await fetchDoc(id);
  return servedAtOwnId(refetched, id) ? refetched!.doc : null;
}

/**
 * Every publicKey object names the actor as owner and has an id on the
 * actor's host. An actor without keys passes; string references are skipped.
 */
export function actorOwnsKeys(actor: any): boolean {
  if (!actor || typeof actor.id !== 'string') return false;
  const keys = Array.isArray(actor.publicKey) ? actor.publicKey : actor.publicKey ? [actor.publicKey] : [];
  return keys.every((key: any) =>
    typeof key !== 'object' || key === null
    || (key.owner === actor.id && sameOrigin(key.id, actor.id)));
}

/**
 * Fetch an actor by its known id: served from exactly that id, keys owned by
 * it. No re-fetch, so a URL never resolves to another actor.
 */
export async function fetchActorById(
  actorUrl: string,
  fetchDoc: (url: string) => Promise<FetchedDocument | null>,
): Promise<any | null> {
  const fetched = await fetchDoc(actorUrl);
  if (!servedAtOwnId(fetched, actorUrl) || !actorOwnsKeys(fetched!.doc)) return null;
  return fetched!.doc;
}
