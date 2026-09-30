/**
 * Origin rules for ActivityPub documents.
 *
 * A host is authoritative only for ids on that host. A signed activity is
 * authoritative for objects on the signer's host; a fetched document is
 * authoritative for ids on the host it was fetched from. Mirrors Mastodon
 * JsonLdHelper#fetch_resource and ActivityPub::Activity#non_matching_uri_hosts?.
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

/**
 * Fetch an ActivityPub document and keep it only when its `id` is on the host
 * that served it. A document naming an id on another host is re-fetched from
 * that id; the second document must carry the same id.
 *
 * `fetchJson` returns the parsed body, or null on any failure.
 */
export async function fetchAuthoritativeDocument(
  url: string,
  fetchJson: (url: string) => Promise<any | null>,
): Promise<any | null> {
  const doc = await fetchJson(url);
  if (!doc || typeof doc !== 'object') return null;

  const id = doc.id;
  if (typeof id !== 'string') return null;
  if (sameOrigin(id, url)) return doc;

  const refetched = await fetchJson(id);
  if (!refetched || typeof refetched !== 'object' || refetched.id !== id) return null;
  return refetched;
}
