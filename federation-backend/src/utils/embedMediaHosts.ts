/**
 * Media hosts of social-post previews (services/socialEmbeds.ts) and of the media relay
 * (routes/embedMedia.ts).
 *
 * /embed-media?u= (a no-referrer redirect, or the relay) carries only files a browser on
 * another origin cannot play straight from the CDN (probed 2026-10-22):
 *   video.twimg.com        403 to any Referer but x.com, twitter.com or none. Harmony pages
 *                          send their origin (Referrer-Policy strict-origin-when-cross-origin).
 *   bsky.social, *.host.bsky.network, path /xrpc/com.atproto.sync.getBlob
 *                          200 with the whole blob to a Range request; WebKit plays no video
 *                          without byte ranges and takes the post's HLS playlist instead.
 * pbs.twimg.com, cdn.bsky.app and video.bsky.app answer any origin and are loaded directly.
 * Instagram CDN URLs (*.cdninstagram.com, *.fbcdn.net) answer any origin but carry a signed
 * expiry; the browser reaches them through /embed-media/instagram/..., a redirect to the
 * current URL, never through the relay.
 */

import config from '../config/index.js';

const INSTAGRAM_CDN = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;
const BLUESKY_PDS = /^[a-z0-9-]+\.[a-z0-9-]+\.host\.bsky\.network$/;
const BLUESKY_CDN = new Set(['cdn.bsky.app', 'video.bsky.app', 'video.cdn.bsky.app']);
const BLOB_PATH = '/xrpc/com.atproto.sync.getBlob';
/** A did:plc or did:web identifier, and a blob CID (base32 CIDv1). */
const DID = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/;
const CID = /^b[a-z2-7]{20,100}$/;

/** `raw` as an https URL with no credentials and the default port, else null. */
export function httpsUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

export function isInstagramCdnUrl(raw: unknown): boolean {
  const url = httpsUrl(raw);
  return !!url && INSTAGRAM_CDN.test(url.hostname);
}

export function isTwitterImageUrl(raw: unknown): boolean {
  return httpsUrl(raw)?.hostname === 'pbs.twimg.com';
}

export function isTwitterVideoUrl(raw: unknown): boolean {
  return httpsUrl(raw)?.hostname === 'video.twimg.com';
}

export function isBlueskyCdnUrl(raw: unknown): boolean {
  const url = httpsUrl(raw);
  return !!url && BLUESKY_CDN.has(url.hostname);
}

/** A PDS run by Bluesky: the bsky.social entryway, or one of its *.host.bsky.network hosts. */
export function isBlueskyPdsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'bsky.social' || BLUESKY_PDS.test(host);
}

/** com.atproto.sync.getBlob of one did and cid on a Bluesky-run PDS, and nothing else. */
export function isPdsBlobUrl(raw: unknown): boolean {
  const url = httpsUrl(raw);
  if (!url || !isBlueskyPdsHost(url.hostname) || url.pathname !== BLOB_PATH) return false;
  const keys = [...url.searchParams.keys()].sort();
  if (keys.length !== 2 || keys[0] !== 'cid' || keys[1] !== 'did') return false;
  return DID.test(url.searchParams.get('did') ?? '') && CID.test(url.searchParams.get('cid') ?? '');
}

/** A URL the relay streams: a video.twimg.com file or a Bluesky PDS blob. */
export function isRelayableMediaUrl(raw: unknown): boolean {
  return isTwitterVideoUrl(raw) || isPdsBlobUrl(raw);
}

/**
 * Expiry of a signed Meta CDN URL in epoch ms: `oe` is the hex epoch second the signature
 * stops verifying (the CDN then answers 403). Undefined without one.
 */
export function cdnUrlExpiresAt(raw: string | undefined): number | undefined {
  const oe = httpsUrl(raw)?.searchParams.get('oe');
  if (!oe || !/^[0-9a-f]{1,12}$/i.test(oe)) return undefined;
  return parseInt(oe, 16) * 1000;
}

/** Public base of the embed media routes; the media route's prefix (MEDIA_PUBLIC_BASE_URL). */
export function embedMediaBase(): string {
  const base = (config.MEDIA_PUBLIC_BASE_URL || `https://${config.INSTANCE_DOMAIN}/api/federation`).replace(/\/+$/, '');
  return `${base}/embed-media`;
}

/** The relay URL of a relayable file. */
export function relayMediaUrl(target: string): string {
  return `${embedMediaBase()}?u=${encodeURIComponent(target)}`;
}

/** Slot of an Instagram post's media: item index, item index + `/poster`, or `avatar`. */
export type InstagramSlot = `${number}` | `${number}/poster` | 'avatar';

/** Stable URL of one media of an Instagram post; it redirects to the CDN URL current then. */
export function instagramMediaUrl(code: string, slot: InstagramSlot): string {
  return `${embedMediaBase()}/instagram/${encodeURIComponent(code)}/${slot}`;
}
