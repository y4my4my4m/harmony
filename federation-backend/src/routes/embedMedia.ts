/**
 * Media of X, Instagram and Bluesky link previews that browsers cannot load from the CDN
 * themselves (utils/embedMediaHosts.ts).
 *
 * GET /embed-media?u=<url>, u a relayable URL (isRelayableMediaUrl): a video.twimg.com file,
 * or a blob of a Bluesky-run PDS.
 *   Redirect (default): 302 to u under Referrer-Policy: no-referrer; the browser fetches the
 *   file itself and sends X no Referer.
 *   Relay: streams u. Each redirect hop must be relayable too; every hop passes safeFetch's
 *   address checks. A single `Range: bytes=<first>-[<last>]` is forwarded; an upstream that
 *   answers it with the whole file (a PDS) is cut to the range here. Files whose total size
 *   exceeds EMBED_RELAY_MAX_BYTES are refused (413), and a stream of unknown length is cut
 *   there. Only image, video and audio types are served, never SVG, under a sandbox CSP.
 *   At most MAX_STREAMS upstream streams run at once (503 beyond).
 *   EMBED_RELAY_ENABLED picks: unset or 0, nothing is relayed; 1, video.twimg.com files are
 *   relayed for engines other than WebKit; all, everything is relayed.
 *   Chromium (Chrome 155) and Gecko (Firefox 146) send the later range requests of a
 *   redirected video, a seek or Chromium's read of the index at the file's end, straight to
 *   the redirect target with the page's Referer, which video.twimg.com refuses (403). WebKit
 *   26 asks this route again for every range (measured 2026-10-22). Without the relay, those
 *   engines play X video in X's embedded post (components/embeds/XPostFrame.vue).
 *
 * GET /embed-media/config
 *   { relaysXVideo }: whether this route streams X video to the asking engine.
 *
 * GET /embed-media/instagram/<code>/<n>, .../<n>/poster, .../avatar
 *   302 to the CDN URL of that media of the post now (socialEmbeds.instagramMediaTarget).
 *   Instagram CDN URLs expire; these routes stay. A post not yet resolved costs one lookup
 *   from the caller's lookup budget.
 */

import { Router, type Request, type Response } from 'express';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';
import { safeFetch, validateExternalUrl } from '../utils/ssrfProtection.js';
import { isInstagramCdnUrl, isRelayableMediaUrl, isTwitterVideoUrl } from '../utils/embedMediaHosts.js';
import { instagramMediaTarget, isInstagramPostCached } from '../services/socialEmbeds.js';
import { clientIp, createStrictKeyedLimit } from '../middleware/rateLimit.js';

const router = Router();

/** 200 MiB: a 720p X video at 2.2 Mbit/s runs about 12 minutes. */
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const MAX_STREAMS = 48;
const MAX_REDIRECTS = 3;
const UPSTREAM_TIMEOUT_MS = 10_000;
const RELAY_USER_AGENT = 'Mozilla/5.0 (compatible; HarmonyMediaRelay/1.0)';
const SERVED_TYPE = /^(image\/(?!svg)[a-z0-9.+-]+|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/octet-stream)$/;

let activeStreams = 0;

/** Upstream streams open now. Tests only. */
export function activeRelayStreams(): number {
  return activeStreams;
}

const lookupLimit = createStrictKeyedLimit({
  name: 'embed-media-lookup',
  windowMs: 60 * 1000,
  maxRequests: 30,
  message: 'Too many media lookups, please slow down.',
});

function maxBytes(): number {
  const configured = Number(config.EMBED_RELAY_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
}

/** Headers of every answer: loadable from any origin (Tauri apps are cross-origin). */
function crossOrigin(res: Response): void {
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Referrer-Policy', 'no-referrer');
}

/** EMBED_RELAY_ENABLED: 'off' unset or 0, 'engine' for 1, 'all' for all. */
export function relayMode(): 'off' | 'engine' | 'all' {
  const raw = String(config.EMBED_RELAY_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'all') return 'all';
  if (raw === '1' || raw === 'true') return 'engine';
  return 'off';
}

/**
 * A request of a WebKit engine (Safari, the iOS and macOS apps, every iOS browser): its
 * User-Agent names AppleWebKit and no Chrome/ or Chromium/ version (Chromium also names
 * AppleWebKit; iOS Chrome sends CriOS/), and it sends no Sec-CH-UA client hint, which only
 * Chromium sends. Gecko names no AppleWebKit.
 */
export function isWebKitRequest(req: Request): boolean {
  if (typeof req.headers['sec-ch-ua'] === 'string') return false;
  const ua = req.headers['user-agent'] ?? '';
  return /AppleWebKit\//.test(ua) && !/Chrom(e|ium)\/\d/.test(ua);
}

function relays(req: Request, target: string): boolean {
  const mode = relayMode();
  if (mode === 'all') return true;
  return mode === 'engine' && isTwitterVideoUrl(target) && !isWebKitRequest(req);
}

/** Whether X video is streamed to the engine of `req`. */
function relaysXVideo(req: Request): boolean {
  const mode = relayMode();
  return mode === 'all' || (mode === 'engine' && !isWebKitRequest(req));
}

function deny(res: Response, status: number, error: string): void {
  if (res.headersSent) return;
  res.set('Cache-Control', 'no-store');
  res.status(status).json({ error });
}

/** A single `bytes=<first>-[<last>]` range; anything else is served whole. */
export function parseRange(header: unknown): { start: number; end?: number } | null {
  if (typeof header !== 'string') return null;
  const m = header.trim().match(/^bytes=(\d{1,15})-(\d{0,15})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  if (end !== undefined && end < start) return null;
  return { start, end };
}

/** Total size of the file behind a 200 (Content-Length) or 206 (Content-Range) answer. */
function totalSize(res: globalThis.Response): number | undefined {
  if (res.status === 206) {
    const total = res.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
    return total ? Number(total) : undefined;
  }
  const length = res.headers.get('content-length');
  return length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
}

/** GET of a relayable URL, following at most MAX_REDIRECTS redirects to relayable URLs. */
async function fetchUpstream(target: string, headers: Record<string, string>, signal: AbortSignal): Promise<globalThis.Response | null> {
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await safeFetch(url, {
      headers,
      signal,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      maxBodyBytes: Infinity,
      followRedirects: false,
    });
    if (res.status < 300 || res.status >= 400) return res;
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    if (!location) return null;
    const next = new URL(location, url).href;
    if (!isRelayableMediaUrl(next)) {
      logger.warn(`embed-media: redirect off the relay list refused: ${new URL(next).hostname}`);
      return null;
    }
    url = next;
  }
  return null;
}

/**
 * Writes `body` to `res` with backpressure: `skip` bytes dropped, then at most `length`
 * bytes; ends `res` when done. Fails once more than `limit` bytes were read.
 */
async function pump(
  body: ReadableStream<Uint8Array>,
  res: Response,
  opts: { skip: number; length?: number; limit: number },
): Promise<void> {
  const reader = body.getReader();
  let read = 0;
  let sent = 0;
  try {
    for (;;) {
      if (opts.length !== undefined && sent >= opts.length) break;
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > opts.limit) throw new Error(`embed-media: stream exceeded ${opts.limit} bytes`);
      let part = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const before = read - value.byteLength;
      if (before < opts.skip) part = part.subarray(Math.min(part.length, opts.skip - before));
      if (opts.length !== undefined) part = part.subarray(0, opts.length - sent);
      if (!part.length) continue;
      sent += part.length;
      if (res.destroyed) return;
      if (!res.write(part)) {
        await new Promise<void>((resolve) => {
          const go = () => { res.off('drain', go); res.off('close', go); resolve(); };
          res.on('drain', go);
          res.on('close', go);
        });
        if (res.destroyed) return;
      }
    }
    res.end();
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function relay(req: Request, res: Response): Promise<void> {
  crossOrigin(res);
  const raw = typeof req.query.u === 'string' ? req.query.u : '';
  if (!raw || raw.length > 2048 || !isRelayableMediaUrl(raw)) {
    deny(res, 400, 'Not a relayable media URL');
    return;
  }
  try {
    validateExternalUrl(raw);
  } catch {
    deny(res, 400, 'Not a relayable media URL');
    return;
  }
  res.set('Vary', 'User-Agent, Sec-CH-UA');
  if (!relays(req, raw)) {
    res.set('Cache-Control', 'private, max-age=86400');
    // The parsed URL: a scheme-relative form such as `https:video.twimg.com/../x` parses to the
    // allowed host here but resolves against this instance in a browser's Location.
    res.redirect(302, new URL(raw).href);
    return;
  }
  if (activeStreams >= MAX_STREAMS) {
    res.set('Retry-After', '5');
    deny(res, 503, 'Relay busy');
    return;
  }

  const range = parseRange(req.headers.range);
  const limit = maxBytes();
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on('close', onClose);
  activeStreams++;
  try {
    // identity: byte ranges and lengths are of the file itself.
    const headers: Record<string, string> = { 'User-Agent': RELAY_USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity' };
    if (range) headers.Range = `bytes=${range.start}-${range.end ?? ''}`;

    let upstream: globalThis.Response | null;
    try {
      upstream = await fetchUpstream(raw, headers, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) logger.debug(`embed-media: upstream failed: ${(err as Error).message}`);
      deny(res, 502, 'Upstream unavailable');
      return;
    }
    if (!upstream) {
      deny(res, 502, 'Upstream unavailable');
      return;
    }
    const body = upstream.body;
    const release = () => body?.cancel().catch(() => {});

    if (upstream.status === 416) {
      void release();
      const unsatisfied = upstream.headers.get('content-range');
      if (unsatisfied) res.set('Content-Range', unsatisfied);
      deny(res, 416, 'Range not satisfiable');
      return;
    }
    if (upstream.status !== 200 && upstream.status !== 206) {
      void release();
      deny(res, upstream.status === 404 || upstream.status === 410 ? 404 : 502, 'Upstream refused');
      return;
    }
    const type = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!SERVED_TYPE.test(type)) {
      void release();
      deny(res, 502, 'Not media');
      return;
    }
    const total = totalSize(upstream);
    if (total !== undefined && total > limit) {
      void release();
      deny(res, 413, 'Media too large');
      return;
    }

    res.set('Content-Type', type);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'private, max-age=86400, no-transform');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");

    let skip = 0;
    let length: number | undefined;
    if (upstream.status === 200 && range && total !== undefined) {
      // The upstream ignored the range: cut the whole file to it.
      if (range.start >= total) {
        void release();
        res.set('Content-Range', `bytes */${total}`);
        deny(res, 416, 'Range not satisfiable');
        return;
      }
      const end = Math.min(range.end ?? total - 1, total - 1);
      skip = range.start;
      length = end - range.start + 1;
      res.status(206);
      res.set('Content-Range', `bytes ${range.start}-${end}/${total}`);
      res.set('Content-Length', String(length));
    } else {
      res.status(upstream.status);
      for (const name of ['content-length', 'content-range']) {
        const value = upstream.headers.get(name);
        if (value) res.set(name, value);
      }
    }
    for (const name of ['last-modified', 'etag']) {
      const value = upstream.headers.get(name);
      if (value) res.set(name, value);
    }

    if (req.method === 'HEAD' || !body) {
      void release();
      res.end();
      return;
    }
    try {
      await pump(body, res, { skip, length, limit });
    } catch (err) {
      if (!ac.signal.aborted) logger.debug(`embed-media: stream ended early: ${(err as Error).message}`);
      if (!res.headersSent) deny(res, 502, 'Upstream unavailable');
      else res.destroy();
    }
  } finally {
    activeStreams--;
    res.off('close', onClose);
  }
}

/** Runs a handler; a throw ends the answer instead of escaping as a rejection. */
function guarded(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((err) => {
      logger.warn(`embed-media: ${(err as Error).message}`);
      if (!res.headersSent) deny(res, 500, 'Internal error');
      else res.destroy();
    });
  };
}

router.get('/', guarded(relay));

router.get('/config', (req: Request, res: Response) => {
  crossOrigin(res);
  res.set('Vary', 'User-Agent, Sec-CH-UA');
  res.set('Cache-Control', 'private, max-age=300');
  res.json({ relaysXVideo: relaysXVideo(req) });
});

const CODE = '[A-Za-z0-9_-]{5,40}';

async function instagramRedirect(req: Request, res: Response, slot: string): Promise<void> {
  crossOrigin(res);
  const { code } = req.params;
  if (!isInstagramPostCached(code) && !(await lookupLimit.take(res, clientIp(req)))) return;
  const target = await instagramMediaTarget(code, slot);
  if (!target || !isInstagramCdnUrl(target.url)) {
    res.set('Cache-Control', 'public, max-age=300');
    res.status(404).json({ error: 'Not found' });
    return;
  }
  // The browser may reuse the redirect while the CDN URL lives, at most an hour.
  const seconds = Math.max(0, Math.min(3600, Math.floor((target.expiresAt - Date.now()) / 1000) - 600));
  res.set('Cache-Control', seconds > 0 ? `private, max-age=${seconds}` : 'no-store');
  res.redirect(302, target.url);
}

router.get(`/instagram/:code(${CODE})/avatar`, guarded((req, res) => instagramRedirect(req, res, 'avatar')));
router.get(`/instagram/:code(${CODE})/:index(\\d{1,2})/poster`, guarded((req, res) => instagramRedirect(req, res, `${req.params.index}/poster`)));
router.get(`/instagram/:code(${CODE})/:index(\\d{1,2})`, guarded((req, res) => instagramRedirect(req, res, req.params.index)));

export default router;
