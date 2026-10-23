import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { driveLinkPageLimiter } from '../middleware/rateLimit.js';
import {
  loadDriveLinkPreview,
  renderDriveLinkPage,
  renderDriveLinkUnavailablePage,
} from '../services/driveLinkPage.js';

const router = Router();

// No script; images come from this instance's link route and its storage.
const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendPage(res: Response, status: number, html: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // A revoked link stops unfurling at once; no shared cache holds the file name.
  res.setHeader('Cache-Control', 'no-store');
  // The same URL is the SPA for people.
  res.setHeader('Vary', 'User-Agent');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  res.send(html);
}

/**
 * Link-preview page of a Drive file's address.
 * GET /d/:token
 *
 * Public file: 200 with the file's name, type and, for a raster image, a thumbnail. Restricted,
 * expired, reset, unknown or malformed: 404 with no OpenGraph tags. Lookup failure: 503.
 * No redirect to the SPA: a person sending a crawler User-Agent would loop.
 */
router.get(
  '/d/:token',
  driveLinkPageLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await loadDriveLinkPreview(req.params.token);
    if (result.status === 'valid') return sendPage(res, 200, renderDriveLinkPage(result.preview));
    if (result.status === 'invalid') return sendPage(res, 404, renderDriveLinkUnavailablePage('invalid'));
    res.setHeader('Retry-After', '30');
    return sendPage(res, 503, renderDriveLinkUnavailablePage('unavailable'));
  })
);

export default router;
