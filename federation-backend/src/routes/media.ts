/**
 * GET /media/<path>?to=<audience>&sig=<hmac>: federated chat attachments.
 *
 * Serves a message_media object to the instance named in the URL while that instance
 * still receives the object's room (public.federation_media_access). A valid request is
 * answered with a redirect to a storage URL signed for REDIRECT_TTL_SECONDS; storage
 * serves the bytes, ranges included. The capability format is in utils/privateMedia.ts.
 */

import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { makeUrlPublic } from '../utils/urlUtils.js';
import { BlockedInstancesCache } from '../services/BlockedInstancesCache.js';
import {
  MESSAGE_MEDIA_BUCKET,
  PUBLIC_AUDIENCE,
  REDIRECT_TTL_SECONDS,
  isPrivateMediaPath,
  normalizeAudience,
  verifyMediaUrlSignature,
} from '../utils/privateMedia.js';

const router = Router();

function deny(res: Response, status: number): void {
  res.set('Cache-Control', 'no-store');
  res.status(status).json({ error: status === 404 ? 'Not found' : 'Forbidden' });
}

router.get(/^\/(.+)$/, async (req: Request, res: Response) => {
  // Remote pages embed these URLs; helmet's default CORP of same-origin would block them.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Access-Control-Allow-Origin', '*');

  // Express has percent-decoded the capture.
  const path = (req.params as Record<string, string>)[0];
  const audience = typeof req.query.to === 'string' ? normalizeAudience(req.query.to) : null;
  if (!isPrivateMediaPath(path) || !audience) {
    deny(res, 404);
    return;
  }
  if (!verifyMediaUrlSignature(path, audience, req.query.sig)) {
    deny(res, 403);
    return;
  }
  if (audience !== PUBLIC_AUDIENCE && BlockedInstancesCache.isBlocked(audience.replace(/:\d+$/, ''))) {
    deny(res, 403);
    return;
  }

  const supabase = getSupabaseClient();
  const { data: allowed, error: accessError } = await supabase.rpc('federation_media_access', {
    p_name: path,
    p_domain: audience,
  });
  if (accessError) {
    logger.error(`federation_media_access failed: ${accessError.message}`);
    res.set('Cache-Control', 'no-store');
    res.status(503).json({ error: 'Unavailable' });
    return;
  }
  if (allowed !== true) {
    deny(res, 403);
    return;
  }

  const { data, error } = await supabase.storage
    .from(MESSAGE_MEDIA_BUCKET)
    .createSignedUrl(path, REDIRECT_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    deny(res, 404);
    return;
  }

  // Cached for less than the signed URL lives.
  res.set('Cache-Control', `private, max-age=${Math.floor(REDIRECT_TTL_SECONDS / 2)}`);
  res.redirect(302, makeUrlPublic(data.signedUrl));
});

export default router;
