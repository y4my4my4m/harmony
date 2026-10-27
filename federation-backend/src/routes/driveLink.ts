/**
 * GET|HEAD /drive/link/<token>[?download=1 | ?thumb=1]: the bytes of a Drive file whose general
 * access is "Anyone with the link".
 *
 * public.drive_link_target resolves a file's link token while its link share is live (unexpired,
 * file in Drive, link sharing on) to its object; a restricted file's token resolves to nothing.
 * The bytes are streamed from a storage URL signed for REDIRECT_TTL_SECONDS on the internal
 * origin, Range included. The signed URL is never sent: its object name holds the uploader's
 * auth uid (u/<uid>/...) or the room (c|d/<room>/<uploader>/...), which names the owner a link
 * with Show my name off hides. Only ANSWER_HEADERS, and the Content-Disposition of download=1,
 * pass through.
 * With download=1 storage sends the file as an attachment under its Drive name. With thumb=1
 * storage renders a raster image (LINK_THUMBNAIL_TYPES) at THUMBNAIL_TRANSFORM; any other
 * file is a 404.
 */

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { LINK_THUMBNAIL_TYPES, REDIRECT_TTL_SECONDS } from '../utils/privateMedia.js';

const router = Router();

/** drive_files.link_token: base64url of 18 random bytes. */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** thumb=1: a storage render of a raster image, the size OpenGraph cards draw (1200x630). */
const THUMBNAIL_TRANSFORM = { width: 1200, height: 630, resize: 'contain' as const, quality: 80 };

/** Storage answer headers passed to the client; anything else (object names, ids) stays here. */
const ANSWER_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

function deny(res: Response, status: number): void {
  res.set('Cache-Control', 'no-store');
  res.status(status).json({ error: status === 404 ? 'Not found' : 'Unavailable' });
}

router.get('/link/:token', async (req: Request, res: Response) => {
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Referrer-Policy', 'no-referrer');
  const token = req.params.token;
  if (!TOKEN.test(token)) {
    deny(res, 404);
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('drive_link_target', { p_token: token });
  if (error) {
    logger.error(`drive_link_target failed: ${error.message}`);
    deny(res, 503);
    return;
  }
  const target = Array.isArray(data) ? data[0] : null;
  if (!target?.bucket || !target?.path) {
    deny(res, 404);
    return;
  }

  const thumb = req.query.thumb === '1';
  if (thumb && !LINK_THUMBNAIL_TYPES.has(target.mime_type ?? '')) {
    deny(res, 404);
    return;
  }
  const download = req.query.download === '1' ? (target.name || 'file') : undefined;
  const options = thumb ? { transform: THUMBNAIL_TRANSFORM } : undefined;
  const { data: signed, error: signError } = await supabase.storage
    .from(target.bucket)
    .createSignedUrl(target.path, REDIRECT_TTL_SECONDS, options);
  if (signError || !signed?.signedUrl) {
    deny(res, 404);
    return;
  }
  // storage-js's own `download` option passes the name through encodeURI, which leaves & # +
  // unescaped and cuts the name there.
  const source = download
    ? `${signed.signedUrl}${signed.signedUrl.includes('?') ? '&' : '?'}download=${encodeURIComponent(download)}`
    : signed.signedUrl;

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let upstream: globalThis.Response;
  try {
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    upstream = await fetch(source, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: range ? { Range: range } : {},
      signal: abort.signal,
    });
  } catch (err) {
    if (!abort.signal.aborted) logger.error(`drive link fetch failed: ${(err as Error).message}`);
    if (!res.headersSent) deny(res, 503);
    return;
  }
  if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
    await upstream.body?.cancel().catch(() => {});
    deny(res, upstream.status === 404 || upstream.status === 400 ? 404 : 503);
    return;
  }

  res.status(upstream.status);
  for (const name of ANSWER_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.set(name, value);
  }
  // The Drive name of download=1; storage's own filename otherwise is the object's.
  const disposition = upstream.headers.get('content-disposition');
  if (download && disposition) res.set('Content-Disposition', disposition);
  res.set('Cache-Control', 'private, max-age=60');
  res.set('X-Content-Type-Options', 'nosniff');
  if (!upstream.body || req.method === 'HEAD') {
    await upstream.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as unknown as WebReadableStream).on('error', () => res.destroy()).pipe(res);
});

export default router;
