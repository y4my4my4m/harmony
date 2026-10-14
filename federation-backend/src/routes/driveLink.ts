/**
 * GET /drive/link/<token>[?download=1]: a Drive file shared by link.
 *
 * public.drive_link_target resolves a live link (unexpired, file in Drive, link sharing on)
 * to its object; the answer is a redirect to a storage URL signed for REDIRECT_TTL_SECONDS.
 * With download=1 storage sends the file as an attachment under its Drive name.
 */

import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { makeUrlPublic } from '../utils/urlUtils.js';
import { REDIRECT_TTL_SECONDS } from '../utils/privateMedia.js';

const router = Router();

/** Link tokens: base64url of 18 random bytes. */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

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

  const download = req.query.download === '1' ? (target.name || 'file') : undefined;
  const { data: signed, error: signError } = await supabase.storage
    .from(target.bucket)
    .createSignedUrl(target.path, REDIRECT_TTL_SECONDS, download ? { download } : undefined);
  if (signError || !signed?.signedUrl) {
    deny(res, 404);
    return;
  }

  res.set('Cache-Control', `private, max-age=${Math.floor(REDIRECT_TTL_SECONDS / 2)}`);
  res.redirect(302, makeUrlPublic(signed.signedUrl));
});

export default router;
