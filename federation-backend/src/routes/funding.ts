/**
 * GET /funding/public: this instance's public funding feed (services/projectFunding.ts),
 * readable from any origin. Held in memory for FEED_CACHE_MS.
 *
 * GET /funding/project-feed: the Harmony project's development fund, in the same shape and with
 * the same cache, served by the project's own instance only (404 elsewhere). Other instances
 * read it as PROJECT_FEED_URL.
 *
 * GET /funding/project: the Harmony project's feed for this instance's Support window. On the
 * project's own instance, the project fund read locally (source 'local'); elsewhere the cached
 * project feed with its source, its messages empty while instance_funding.show_project_messages
 * is off or when the switch cannot be read.
 *
 * Both project routes carry PROJECT_LINKS as the fund's links, whatever the database or the
 * project's feed holds.
 */

import { Router, type Request, type Response } from 'express';
import { fundingLimiter } from '../middleware/rateLimit.js';
import { logger } from '../utils/logger.js';
import {
  isProjectInstance,
  PROJECT_FUNDING_FALLBACK,
  ProjectFundingCache,
  readOwnFeed,
  readProjectFeed,
  readShowProjectMessages,
  withProjectLinks,
  type PublicFunding,
} from '../services/projectFunding.js';

export const FEED_CACHE_MS = 60_000;

/** One read at a time, the result kept FEED_CACHE_MS. */
function cachedFeed(read: () => Promise<PublicFunding>, now: () => number) {
  let copy: { body: PublicFunding; at: number } | null = null;
  let reading: Promise<PublicFunding> | null = null;
  return async (): Promise<{ body: PublicFunding; at: number }> => {
    if (!copy || now() - copy.at >= FEED_CACHE_MS) {
      reading ??= read().finally(() => { reading = null; });
      copy = { body: await reading, at: now() };
    }
    return copy;
  };
}

export function createFundingRouter(
  deps: {
    readFeed?: () => Promise<PublicFunding>;
    readProjectFeed?: () => Promise<PublicFunding>;
    project?: ProjectFundingCache;
    projectInstance?: () => boolean;
    showProjectMessages?: () => Promise<boolean>;
    now?: () => number;
  } = {},
): Router {
  const project = deps.project ?? new ProjectFundingCache();
  const projectInstance = deps.projectInstance ?? (() => isProjectInstance());
  const showProjectMessages = deps.showProjectMessages ?? readShowProjectMessages;
  const now = deps.now ?? Date.now;
  const ownFeed = cachedFeed(deps.readFeed ?? readOwnFeed, now);
  const projectFeed = cachedFeed(deps.readProjectFeed ?? readProjectFeed, now);
  const router = Router();

  const json = (res: Response, body: unknown, maxAgeS: number) => {
    res.set('Cache-Control', `public, max-age=${maxAgeS}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('application/json').send(JSON.stringify(body));
  };

  const unavailable = (res: Response, what: string, err: unknown) => {
    logger.error(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    res.status(503).set('Retry-After', '60');
    json(res, { error: 'Funding is unavailable' }, 0);
  };

  router.get('/public', fundingLimiter, async (_req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      json(res, (await ownFeed()).body, 300);
    } catch (err) {
      unavailable(res, 'funding feed', err);
    }
  });

  router.get('/project-feed', fundingLimiter, async (_req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (!projectInstance()) {
      res.status(404);
      json(res, { error: 'This instance does not publish the Harmony project fund' }, 300);
      return;
    }
    try {
      json(res, withProjectLinks((await projectFeed()).body), 300);
    } catch (err) {
      unavailable(res, 'project fund feed', err);
    }
  });

  router.get('/project', fundingLimiter, async (_req: Request, res: Response) => {
    if (projectInstance()) {
      try {
        const { body, at } = await projectFeed();
        json(res, { projectInstance: true, source: 'local', fetchedAt: new Date(at).toISOString(), funding: withProjectLinks(body) }, 60);
      } catch (err) {
        logger.error(`project fund: ${err instanceof Error ? err.message : String(err)}`);
        json(res, { projectInstance: true, source: 'fallback', fetchedAt: null, funding: PROJECT_FUNDING_FALLBACK }, 0);
      }
      return;
    }
    const [result, shown] = await Promise.all([
      project.get(),
      showProjectMessages().catch((err: unknown) => {
        logger.warn(`project funding: show_project_messages unreadable: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }),
    ]);
    const funding = withProjectLinks(shown ? result.funding : { ...result.funding, messages: [] });
    json(res, { projectInstance: false, ...result, funding }, 300);
  });

  return router;
}

export default createFundingRouter();
