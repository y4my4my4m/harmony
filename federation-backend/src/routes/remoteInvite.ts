/**
 * The server card of an invite link to another Harmony instance, for a signed-in local user
 * (services/remoteInvitePreview.ts). The in-chat card reads its counts and validity here.
 *
 *   GET /remote-invite?url=<https://host/invite/code>
 *        200 { invite }: the card, valid, invalid or closed. 400 invalid_url, 401 unauthorized,
 *        404 not_harmony: not an invite link of another Harmony instance read here,
 *        502 unreachable.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { discoveryLimiter } from '../middleware/rateLimit.js';
import { localProfileIdFromBearer } from '../middleware/auth.js';
import { remoteInviteTarget, resolveRemoteInvite } from '../services/remoteInvitePreview.js';

const router = Router();

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ error, code });
}

router.get(
  '/remote-invite',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!(await localProfileIdFromBearer(req.headers.authorization))) {
      refuse(res, 401, 'unauthorized', 'Sign in to read invites of other instances');
      return;
    }
    const url = req.query.url;
    if (!remoteInviteTarget(url)) {
      refuse(res, 400, 'invalid_url', 'Not an invite link of another instance');
      return;
    }
    const lookup = await resolveRemoteInvite(url);
    if (lookup.status === 'none') {
      refuse(res, 404, 'not_harmony', 'Not an invite link of a Harmony instance');
      return;
    }
    if (lookup.status === 'unavailable') {
      refuse(res, 502, 'unreachable', 'The instance did not answer');
      return;
    }
    res.json({ invite: lookup.card });
  })
);

export default router;
