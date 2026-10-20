/**
 * Link preview images copied to the instance's storage (bucket link-preview-images,
 * migration 20261023100001). A preview names the copy, so readers never fetch the site's
 * image themselves: their address stays with the instance, and images that sites serve to
 * hotlinkers unreliably still show. GitHub's opengraph.githubassets.com renders card images
 * on demand and answers its cache misses with 429 and Retry-After: 900.
 *
 * Mastodon stores preview card images the same way (PreviewCard#image).
 */

import { createHash } from 'node:crypto';
import NodeCache from 'node-cache';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { safeFetch } from '../utils/ssrfProtection.js';
import { logger } from '../utils/logger.js';

export const PREVIEW_IMAGE_BUCKET = 'link-preview-images';
export const PREVIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 1_500;
const HOSTED_TTL_S = 24 * 60 * 60;
const MISS_TTL_S = 10 * 60;

/** Magic bytes of the raster formats the bucket admits. SVG is not among them. */
export function sniffImageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  const at = (i: number) => bytes[i];
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 8 && at(0) === 0x89 && ascii(1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 6 && ascii(0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return { mime: 'image/avif', ext: 'avif' };
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The image bytes, or null for anything but a raster image within the size limit. */
async function download(url: string): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    let response: Response;
    try {
      response = await safeFetch(url, {
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9' },
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBodyBytes: PREVIEW_IMAGE_MAX_BYTES,
      });
    } catch (error) {
      logger.debug('Preview image fetch failed', { url, error: (error as Error).message });
      return null;
    }
    // Rate limits and server errors get one more try; anything else is final.
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > PREVIEW_IMAGE_MAX_BYTES) return null;
    const type = sniffImageType(bytes);
    return type ? { bytes, ...type } : null;
  }
  return null;
}

class PreviewImageStore {
  private hosted = new NodeCache({ stdTTL: HOSTED_TTL_S, checkperiod: 600 });
  private inFlight = new Map<string, Promise<string | null>>();

  /** The public URL of the stored copy of `url`, or null when it cannot be stored. */
  host(url: string): Promise<string | null> {
    const known = this.hosted.get<string | false>(url);
    if (known !== undefined) return Promise.resolve(known || null);
    const pending = this.inFlight.get(url);
    if (pending) return pending;
    const job = this.store(url).finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, job);
    return job;
  }

  private async store(url: string): Promise<string | null> {
    const image = await download(url);
    if (!image) {
      this.hosted.set(url, false, MISS_TTL_S);
      return null;
    }
    // Named by the source URL: the same image is stored once however many previews use it.
    const digest = createHash('sha256').update(url).digest('hex');
    const path = `${digest.slice(0, 2)}/${digest}.${image.ext}`;
    try {
      const { error } = await getSupabaseClient()
        .storage.from(PREVIEW_IMAGE_BUCKET)
        .upload(path, image.bytes, { contentType: image.mime, upsert: true, cacheControl: '604800' });
      if (error) {
        logger.warn('Preview image upload failed', { url, error: error.message });
        this.hosted.set(url, false, MISS_TTL_S);
        return null;
      }
    } catch (error) {
      logger.warn('Preview image upload failed', { url, error: (error as Error).message });
      this.hosted.set(url, false, MISS_TTL_S);
      return null;
    }
    // The externally reachable base; the client's internal SUPABASE_URL is a docker host.
    const base = (config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL || '').replace(/\/+$/, '');
    const hostedUrl = `${base}/storage/v1/object/public/${PREVIEW_IMAGE_BUCKET}/${path}`;
    this.hosted.set(url, hostedUrl);
    return hostedUrl;
  }
}

export const previewImageStore = new PreviewImageStore();
