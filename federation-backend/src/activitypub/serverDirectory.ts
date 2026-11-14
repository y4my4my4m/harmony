/**
 * The instance's server directory: the Groups of its servers listed across federation
 * (servers.federation_discoverable, migration 20261105100001), as an ActivityStreams
 * OrderedCollection.
 *
 *   GET /servers/directory          OrderedCollection, totalItems and `first`
 *   GET /servers/directory?page=N   OrderedCollectionPage of PAGE_SIZE Groups, most members first
 *
 * Linked from NodeInfo metadata.serverDirectory and from the instance actor (`streams`,
 * `harmony:directory`). Each item is the Group actor's public summary: id, preferredUsername,
 * name, summary, icon, inbox, discoverable, harmony:memberCount. A server is listed while it is
 * local, public, federated, not suspended, its flag is on and both instance federation switches
 * are on (federation_server_directory); the Group document's `discoverable` follows the same rule
 * (groupDiscoverability).
 *
 * `discoverable` is toot:discoverable: listed in directories. Harmony before 1.9.3 wrote the
 * server's `public` there and its consumers read it back as such. A Group now carries
 * `harmony:public` for that, and leaves `discoverable` out when it is public but not listed, so a
 * consumer before 1.9.3 still reads the server as public; a private Group says `discoverable:
 * false` as before.
 */

import { Router, Request, Response } from 'express';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { getFullServerIconUrl } from '../utils/urlUtils.js';
import { federationSwitches } from '../services/FederationSwitches.js';
import { HARMONY_NS } from './harmonyContext.js';
import { serverActorUrl } from './ServerActor.js';

export const DIRECTORY_PATH = '/servers/directory';

/** Groups per OrderedCollectionPage. */
export const DIRECTORY_PAGE_SIZE = 20;

/** Pages served: 10 000 Groups. A later page is 404. */
const MAX_PAGE = 500;

export const HARMONY_PUBLIC = 'harmony:public';
export const HARMONY_DIRECTORY = 'harmony:directory';

export const DIRECTORY_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  {
    toot: 'http://joinmastodon.org/ns#',
    discoverable: 'toot:discoverable',
    Emoji: 'toot:Emoji',
    harmony: HARMONY_NS,
  },
] as const;

export function directoryUrl(): string {
  return `https://${config.INSTANCE_DOMAIN}${DIRECTORY_PATH}`;
}

/** The server columns the listing rule reads. */
export interface ListingFields {
  is_local_server?: boolean | null;
  public?: boolean | null;
  federation_enabled?: boolean | null;
  federation_discoverable?: boolean | null;
  suspended_at?: string | null;
}

/** Mirrors federation_server_directory's WHERE; `instanceOpen` is both switches on. */
export function isListedAcrossFederation(server: ListingFields, instanceOpen: boolean): boolean {
  return instanceOpen
    && server.is_local_server !== false
    && server.public === true
    && server.federation_enabled === true
    && server.federation_discoverable === true
    && !server.suspended_at;
}

/**
 * `discoverable` and `harmony:public` of a Group document or Update: discoverable true when
 * listed, false when private, absent when public and not listed.
 */
export function groupDiscoverability(server: ListingFields, instanceOpen: boolean): Record<string, boolean> {
  const isPublic = server.public === true;
  return {
    ...(isListedAcrossFederation(server, instanceOpen) ? { discoverable: true } : isPublic ? {} : { discoverable: false }),
    [HARMONY_PUBLIC]: isPublic,
  };
}

/** Whether a remote Group admits anyone: harmony:public, else `discoverable` as hosts before 1.9.3 wrote it. */
export function groupIsPublic(group: any): boolean {
  const flag = group?.[HARMONY_PUBLIC];
  return typeof flag === 'boolean' ? flag : group?.discoverable !== false;
}

export async function instanceFederationOpen(): Promise<boolean> {
  const { inbound, outbound } = await federationSwitches();
  return inbound && outbound;
}

interface DirectoryRow {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  created_at: string;
  updated_at: string | null;
  member_count: number | string;
  total_count: number | string;
}

/** A directory item: the public summary of the server's Group actor. */
export function directoryGroup(row: Omit<DirectoryRow, 'total_count'>): Record<string, unknown> {
  const id = serverActorUrl(row.id);
  const icon = getFullServerIconUrl(row.icon);
  return {
    id,
    type: 'Group',
    ...(row.slug ? { preferredUsername: row.slug } : {}),
    name: row.name,
    summary: row.description ?? '',
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    ...(icon ? { icon: { type: 'Image', url: icon, mediaType: 'image/webp' } } : {}),
    published: row.created_at,
    updated: row.updated_at ?? row.created_at,
    discoverable: true,
    [HARMONY_PUBLIC]: true,
    'harmony:federationEnabled': true,
    'harmony:memberCount': Number(row.member_count) || 0,
    ...(row.category ? { 'harmony:category': row.category } : {}),
  };
}

async function readPage(page: number): Promise<{ rows: DirectoryRow[]; total: number } | null> {
  const { data, error } = await getSupabaseClient().rpc('federation_server_directory', {
    p_limit: DIRECTORY_PAGE_SIZE,
    p_offset: (page - 1) * DIRECTORY_PAGE_SIZE,
  });
  if (error) {
    logger.error(`Server directory page ${page} not read: ${error.message}`);
    return null;
  }
  const rows = (data ?? []) as DirectoryRow[];
  return { rows, total: rows.length ? Number(rows[0].total_count) || 0 : 0 };
}

async function totalItems(): Promise<number | null> {
  const first = await readPage(1);
  return first ? first.total : null;
}

const router = Router();

router.get(
  DIRECTORY_PATH,
  asyncHandler(async (req: Request, res: Response) => {
    const id = directoryUrl();
    res.setHeader('Content-Type', 'application/activity+json');
    // An unlisted server leaves the collection at once.
    res.setHeader('Cache-Control', 'no-cache');

    const rawPage = req.query.page;
    if (rawPage === undefined) {
      const total = await totalItems();
      if (total === null) {
        res.status(503).json({ error: 'Directory unavailable' });
        return;
      }
      res.json({
        '@context': DIRECTORY_CONTEXT,
        id,
        type: 'OrderedCollection',
        totalItems: total,
        first: `${id}?page=1`,
      });
      return;
    }

    const page = typeof rawPage === 'string' && /^[1-9]\d{0,3}$/.test(rawPage) ? Number(rawPage) : NaN;
    if (!Number.isInteger(page)) {
      res.status(400).json({ error: 'page is a positive integer' });
      return;
    }
    if (page > MAX_PAGE) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const read = await readPage(page);
    if (!read) {
      res.status(503).json({ error: 'Directory unavailable' });
      return;
    }
    // An empty page past the first answers with its count read on its own: OFFSET past the end
    // returns no row to carry total_count.
    const total = read.rows.length ? read.total : (page === 1 ? 0 : await totalItems());
    const hasNext = total !== null && page * DIRECTORY_PAGE_SIZE < total;
    res.json({
      '@context': DIRECTORY_CONTEXT,
      id: `${id}?page=${page}`,
      type: 'OrderedCollectionPage',
      partOf: id,
      ...(total !== null ? { totalItems: total } : {}),
      orderedItems: read.rows.map(directoryGroup),
      ...(hasNext ? { next: `${id}?page=${page + 1}` } : {}),
      ...(page > 1 ? { prev: `${id}?page=${page - 1}` } : {}),
    });
  }),
);

export default router;
