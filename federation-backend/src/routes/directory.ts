/**
 * Other instances' server directories, for a signed-in local user (services/RemoteDirectoryService.ts).
 *
 *   GET /directory/remote?domain=<host>[&page=<url>]
 *        200 { domain, directory, items, totalItems, next }; `page` is a `next` of an earlier
 *        answer. 400 invalid_domain / own_instance / invalid_page, 403 instance_blocked /
 *        INSTANCE_FEDERATION_OFF, 404 no_directory, 502 unreachable.
 *   GET /directory/peers
 *        200 { peers: [{ domain, software, icon }], federationOff }: known instances that publish
 *        a directory. Up to a few peers' NodeInfo is read first, for at most PEER_REFRESH_WAIT_MS.
 *   GET /directory/servers[?q=<text>][&offset=<n>][&limit=<n>]
 *        200 { items, total, nextOffset, instances, pending, failed, federationOff }: the servers
 *        the known instances list, merged (services/AdvertisedDirectoryService.ts). Each item is
 *        a /directory/remote item with `instance` { domain, name, icon }. limit is at most 60.
 *
 * All answer 401 without a local session. Nothing is fetched while either instance federation
 * switch is off: a server found there could not be joined.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { discoveryLimiter } from '../middleware/rateLimit.js';
import { localProfileIdFromBearer } from '../middleware/auth.js';
import { validateExternalHostname } from '../utils/ssrfProtection.js';
import { urlHost } from '../utils/apOrigin.js';
import { federationSwitches } from '../services/FederationSwitches.js';
import {
  domainBlockedHere,
  isOwnDomain,
  listDirectoryPeers,
  lookupDirectory,
  normalizeDirectoryDomain,
  readDirectoryPage,
  refreshPeerDirectories,
} from '../services/RemoteDirectoryService.js';
import { advertisedServers, parseAdvertisedQuery } from '../services/AdvertisedDirectoryService.js';

const PEER_REFRESH_WAIT_MS = 4_000;

const router = Router();

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ error, code });
}

/** Reads the NodeInfo of due peers, for at most PEER_REFRESH_WAIT_MS. */
async function refreshPeers(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    refreshPeerDirectories(),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, PEER_REFRESH_WAIT_MS); }),
  ]);
  clearTimeout(timer);
}

router.get(
  '/directory/remote',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!(await localProfileIdFromBearer(req.headers.authorization))) {
      refuse(res, 401, 'unauthorized', 'Sign in to browse other instances');
      return;
    }
    const { inbound, outbound } = await federationSwitches();
    if (!inbound || !outbound) {
      refuse(res, 403, 'INSTANCE_FEDERATION_OFF', 'Federation is off on this instance');
      return;
    }

    const domain = normalizeDirectoryDomain(req.query.domain);
    if (!domain) {
      refuse(res, 400, 'invalid_domain', 'Enter an instance domain, like example.social');
      return;
    }
    if (isOwnDomain(domain)) {
      refuse(res, 400, 'own_instance', 'This is your own instance');
      return;
    }
    try {
      validateExternalHostname(domain.replace(/:\d+$/, ''));
    } catch {
      refuse(res, 400, 'invalid_domain', 'Enter an instance domain, like example.social');
      return;
    }
    if (await domainBlockedHere(domain)) {
      refuse(res, 403, 'instance_blocked', 'This instance is blocked here');
      return;
    }

    const rawPage = req.query.page;
    if (rawPage !== undefined && (typeof rawPage !== 'string' || urlHost(rawPage) !== domain)) {
      refuse(res, 400, 'invalid_page', 'The page is not on that instance');
      return;
    }

    const lookup = await lookupDirectory(domain);
    if (lookup.status === 'unreachable') {
      refuse(res, 502, 'unreachable', 'That instance did not answer');
      return;
    }
    if (lookup.status === 'none') {
      refuse(res, 404, 'no_directory', 'That instance publishes no server directory');
      return;
    }

    const page = await readDirectoryPage(domain, lookup.url, typeof rawPage === 'string' ? rawPage : lookup.url);
    if (!page) {
      refuse(res, 502, 'unreachable', 'That instance\'s directory could not be read');
      return;
    }
    res.json(page);
  }),
);

router.get(
  '/directory/peers',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!(await localProfileIdFromBearer(req.headers.authorization))) {
      refuse(res, 401, 'unauthorized', 'Sign in to browse other instances');
      return;
    }
    const { inbound, outbound } = await federationSwitches();
    if (!inbound || !outbound) {
      res.json({ peers: [], federationOff: true });
      return;
    }
    await refreshPeers();
    res.json({ peers: await listDirectoryPeers(), federationOff: false });
  }),
);

router.get(
  '/directory/servers',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!(await localProfileIdFromBearer(req.headers.authorization))) {
      refuse(res, 401, 'unauthorized', 'Sign in to browse other instances');
      return;
    }
    const { inbound, outbound } = await federationSwitches();
    if (!inbound || !outbound) {
      res.json({ items: [], total: 0, nextOffset: null, instances: 0, pending: 0, failed: [], federationOff: true });
      return;
    }
    await refreshPeers();
    const page = await advertisedServers(parseAdvertisedQuery(req.query as Record<string, unknown>));
    res.json({ ...page, federationOff: false });
  }),
);

export default router;
