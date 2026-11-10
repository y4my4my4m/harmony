import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { invitePageLimiter } from '../middleware/rateLimit.js';
import { loadInvitePreview, type InvitePreviewResult } from '../services/invitePreview.js';
import { badgeStyle, renderInviteBadge, renderInviteCard, widgetTheme } from '../services/inviteWidgets.js';

const router = Router();

const CARD_CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors *";
const BADGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/**
 * Headers for a page on another site. helmet's defaults refuse it: X-Frame-Options SAMEORIGIN stops
 * an <iframe> and Cross-Origin-Resource-Policy same-origin stops an <img>. Where a reverse proxy
 * adds its own X-Frame-Options, frame-ancestors takes precedence over it in browsers.
 */
function sendWidget(res: Response, result: InvitePreviewResult, contentType: string, csp: string, body: string): void {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', contentType);
  if (result.status === 'unavailable') {
    res.setHeader('Retry-After', '30');
    res.setHeader('Cache-Control', 'no-store');
    res.status(503);
  } else {
    res.setHeader('Cache-Control', result.status === 'valid' ? 'public, max-age=300' : 'public, max-age=60');
  }
  res.send(body);
}

/**
 * SVG badge of a server invite, for an <img> on any site.
 * GET /widget/invite/:code/badge.svg?theme=dark|light&style=full|join|icon&lang=<locale>
 * Answers an image for a dead invite too: a broken image is the worse outcome on someone's page.
 */
router.get(
  '/widget/invite/:code/badge.svg',
  invitePageLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await loadInvitePreview(req.params.code);
    const svg = renderInviteBadge(result.status === 'valid' ? result.preview : null, {
      theme: widgetTheme(req.query.theme),
      style: badgeStyle(req.query.style),
      lang: req.query.lang,
    });
    sendWidget(res, result, 'image/svg+xml; charset=utf-8', BADGE_CSP, svg);
  })
);

/**
 * Card page of a server invite, for an <iframe> on any site. No script.
 * GET /widget/invite/:code?theme=dark|light&lang=<locale>
 */
router.get(
  '/widget/invite/:code',
  invitePageLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await loadInvitePreview(req.params.code);
    const html = renderInviteCard(result.status === 'valid' ? result.preview : null, {
      theme: widgetTheme(req.query.theme),
      lang: req.query.lang,
    });
    sendWidget(res, result, 'text/html; charset=utf-8', CARD_CSP, html);
  })
);

export default router;
