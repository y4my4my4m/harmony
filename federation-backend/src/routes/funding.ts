/**
 * GET /funding/public: this instance's public funding feed (services/projectFunding.ts),
 * readable from any origin. Held in memory for FEED_CACHE_MS.
 *
 * GET /funding/project: the Harmony project's feed for this instance's Support window:
 * `{ projectInstance: true }` on the project's own instance, else the cached project feed with
 * its source.
 */

import { Router, type Request, type Response } from 'express';
import config from '../config/index.js';
import { fundingLimiter } from '../middleware/rateLimit.js';
import { logger } from '../utils/logger.js';
import {
  isProjectInstance,
  ProjectFundingCache,
  readOwnFeed,
  type PublicFunding,
} from '../services/projectFunding.js';

export const FEED_CACHE_MS = 60_000;

export function createFundingRouter(
  deps: {
    readFeed?: () => Promise<PublicFunding>;
    project?: ProjectFundingCache;
    projectInstance?: () => boolean;
    now?: () => number;
  } = {},
): Router {
  const readFeed = deps.readFeed ?? readOwnFeed;
  const project = deps.project ?? new ProjectFundingCache();
  const projectInstance = deps.projectInstance ?? (() => isProjectInstance(config));
  const now = deps.now ?? Date.now;
  const router = Router();

  let feed: { body: PublicFunding; at: number } | null = null;
  let reading: Promise<PublicFunding> | null = null;

  const json = (res: Response, body: unknown, maxAgeS: number) => {
    res.set('Cache-Control', `public, max-age=${maxAgeS}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('application/json').send(JSON.stringify(body));
  };

  router.get('/public', fundingLimiter, async (_req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      if (!feed || now() - feed.at >= FEED_CACHE_MS) {
        reading ??= readFeed().finally(() => { reading = null; });
        feed = { body: await reading, at: now() };
      }
      json(res, feed.body, 300);
    } catch (err) {
      logger.error(`funding feed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(503).set('Retry-After', '60');
      json(res, { error: 'Funding is unavailable' }, 0);
    }
  });

  router.get('/project', fundingLimiter, async (_req: Request, res: Response) => {
    if (projectInstance()) {
      json(res, { projectInstance: true }, 300);
      return;
    }
    const result = await project.get();
    json(res, { projectInstance: false, ...result }, 300);
  });

  return router;
}

export default createFundingRouter();
