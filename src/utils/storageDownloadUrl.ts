/**
 * A storage object URL (object/public, object/sign) that downloads under a name: storage-api
 * answers `download=<name>` with `Content-Disposition: attachment; filename=<pct>;
 * filename*=UTF-8''<pct>`. storage-js 2.84 puts the name through encodeURI, which leaves & # +
 * as they are and cuts the name there; here it is percent-encoded whole.
 */

const STORAGE_OBJECT_PATH = /\/storage\/v1\/object\/(?:public|sign)\//

/** `url` with `download=<name>` when it is a storage object URL; null otherwise. */
export function storageDownloadUrl(url: string, name: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : undefined)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol) || !STORAGE_OBJECT_PATH.test(parsed.pathname)) return null
  const query = parsed.search
    .replace(/^\?/, '')
    .split('&')
    .filter((pair) => pair && !/^download(=|$)/.test(pair))
  query.push(`download=${encodeURIComponent(name || 'download')}`)
  return `${parsed.origin}${parsed.pathname}?${query.join('&')}${parsed.hash}`
}

/** The URL a download of `url` should fetch: the named storage URL, else `url`. */
export function namedDownloadUrl(url: string, name: string): string {
  return storageDownloadUrl(url, name) ?? url
}
