import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { invitePageLimiter } from '../middleware/rateLimit.js';
import { loadInvitePreview } from '../services/invitePreview.js';
import {
  renderInvalidInvitePage,
  renderInvitePage,
  renderUnavailableInvitePage,
} from '../services/invitePageRenderer.js';

const router = Router();

// No script on these pages; images come from storage and remote hosts.
const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const DISCORDBOT = /discordbot/i;

function sendPage(res: Response, status: number, cacheControl: string, html: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  // The same URL is the SPA for people.
  res.setHeader('Vary', 'User-Agent');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', CSP);
  res.send(html);
}

/**
 * Link-preview page of a server invite.
 * GET /invite/:code
 *
 * Valid: 200 with the server card. Invalid (not found, revoked, expired, used up, malformed):
 * 200 with a card naming no server, so chat apps show the link as a dead invite; a non-2xx
 * answer gets no embed at all. Lookup failure: 503, not cached.
 * No redirect to the SPA: a person sending a crawler User-Agent would loop.
 */
router.get(
  '/invite/:code',
  invitePageLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = req.params;
    const result = await loadInvitePreview(code);

    if (result.status === 'valid') {
      const oembed = DISCORDBOT.test(req.get('user-agent') ?? '');
      return sendPage(res, 200, 'public, max-age=300', renderInvitePage(result.preview, { oembed }));
    }
    if (result.status === 'invalid') {
      return sendPage(res, 200, 'public, max-age=60', renderInvalidInvitePage());
    }
    res.setHeader('Retry-After', '30');
    return sendPage(res, 503, 'no-store', renderUnavailableInvitePage(code));
  })
);

export default router;
