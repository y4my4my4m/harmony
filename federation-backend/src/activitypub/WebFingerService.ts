import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import config from '../config/index.js';
import { INSTANCE_ACTOR_USERNAME, instanceActorUrl, isInstanceActorUsername } from './InstanceActor.js';
import { deletedActorByUsername } from './deletedActors.js';
import { profilePageUrl } from './converters/toActivityPub.js';

const router = Router();

/** OStatus remote follow: where a remote page sends this account's user to act on `{uri}`. */
export const SUBSCRIBE_REL = 'http://ostatus.org/schema/1.0/subscribe';

/** The SPA route that resolves `{uri}` (an actor or a post) and offers Follow or Open. */
export function subscribeTemplate(): string {
  return `https://${config.INSTANCE_DOMAIN}/authorize_interaction?uri={uri}`;
}

/** What a WebFinger `resource` names on this instance. */
type Resource =
  | { kind: 'handle'; name: string }
  | { kind: 'account'; name: string }
  | { kind: 'server'; id: string };

/**
 * `acct:<name>@<domain>`, or a URL on this domain naming an account (its actor id
 * `/users/<name>` or its page `/social/profile/<name>`) or a chat server
 * (`/servers/<uuid>`), as Mastodon's WebfingerController accepts an account's URI or URL.
 * `invalid` for a malformed resource, `elsewhere` for another domain or path.
 */
function parseResource(resource: string): Resource | 'invalid' | 'elsewhere' {
  const acct = resource.match(/^acct:([^@]+)@(.+)$/);
  if (acct) {
    return acct[2].toLowerCase() === config.INSTANCE_DOMAIN.toLowerCase()
      ? { kind: 'handle', name: acct[1] }
      : 'elsewhere';
  }
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return 'invalid';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'invalid';
  if (url.host.toLowerCase() !== config.INSTANCE_DOMAIN.toLowerCase()) return 'elsewhere';
  const path = url.pathname.replace(/\/+$/, '');
  const account = path.match(/^\/(?:users|social\/profile)\/([^/]+)$/);
  if (account) return { kind: 'account', name: account[1] };
  const server = path.match(/^\/servers\/([0-9a-f-]{36})$/i);
  if (server) return { kind: 'server', id: server[1].toLowerCase() };
  return 'elsewhere';
}

/**
 * WebFinger endpoint
 * /.well-known/webfinger?resource=acct:username@domain
 */
router.get(
  '/.well-known/webfinger',
  asyncHandler(async (req: Request, res: Response) => {
    const resource = req.query.resource as string;

    if (!resource || typeof resource !== 'string') {
      return res.status(400).json({
        error: 'Missing resource parameter',
      });
    }

    const parsed = parseResource(resource);
    if (parsed === 'invalid') {
      return res.status(400).json({
        error: 'Invalid resource format',
      });
    }
    if (parsed === 'elsewhere') {
      return res.status(404).json({
        error: 'User not found on this instance',
      });
    }

    // Mastodon resolves a signer's preferredUsername through WebFinger and
    // requires the self link to be the actor id.
    if (parsed.kind !== 'server' && isInstanceActorUsername(parsed.name)) {
      const actorUrl = instanceActorUrl();
      res.setHeader('Content-Type', 'application/jrd+json');
      return res.json({
        subject: `acct:${INSTANCE_ACTOR_USERNAME}@${config.INSTANCE_DOMAIN}`,
        aliases: [actorUrl],
        links: [
          {
            rel: 'self',
            type: 'application/activity+json',
            href: actorUrl,
            properties: { 'https://www.w3.org/ns/activitystreams#type': 'Application' },
          },
        ],
      });
    }

    // Usernames are [a-zA-Z0-9_], slugs [a-z0-9_-]. Anything else cannot
    // match and must not reach ILIKE, where `%` and `*` are wildcards.
    if (parsed.kind !== 'server' && !/^[a-zA-Z0-9_-]+$/.test(parsed.name)) {
      return res.status(404).json({ error: 'Account not found' });
    }
    // `_` is the ILIKE single-character wildcard: `a_b` would also match `axb`.
    const pattern = parsed.kind === 'server' ? '' : parsed.name.replace(/_/g, '\\_');

    // A handle can name a user (Person) AND/OR a chat server (Group). They are
    // distinct actor types that may share a localpart, exactly like Lemmy's
    // users vs communities. WebFinger has no type field in the acct: URI, so
    // the response carries one rel="self" link PER matching actor, each tagged
    // with its ActivityStreams type in `properties`. The requester filters by
    // the type it wants; Mastodon-style consumers that ignore properties take
    // the first link. Collisions are rare and servers aren't @-mentioned.
    // A URL names one actor.
    const AS_TYPE = 'https://www.w3.org/ns/activitystreams#type';
    const supabase = getSupabaseClient();

    const userQuery = parsed.kind === 'server'
      ? Promise.resolve({ data: null })
      : supabase
        .from('profiles')
        .select('username')
        .ilike('username', pattern)
        .eq('is_local', true)
        .is('deleted_at', null)
        .maybeSingle();
    // Only public, federation-enabled local servers are discoverable by
    // handle. Private servers stay invite-only (reached by Group-actor URL
    // through the invite flow), never by guessing a handle.
    const serverQuery = parsed.kind === 'account'
      ? Promise.resolve({ data: null })
      : (() => {
        const q = supabase
          .from('servers')
          .select('id, slug')
          .eq('is_local_server', true)
          .eq('federation_enabled', true)
          .eq('public', true);
        return (parsed.kind === 'server' ? q.eq('id', parsed.id) : q.ilike('slug', pattern)).maybeSingle();
      })();
    const [{ data: user }, { data: server }] = await Promise.all([userQuery, serverQuery]) as [
      { data: { username: string } | null },
      { data: { id: string; slug: string | null } | null },
    ];

    if (!user && !server) {
      if (parsed.kind !== 'server' && await deletedActorByUsername(parsed.name)) {
        return res.status(410).json({ error: 'Account deleted' });
      }
      return res.status(404).json({ error: 'Account not found' });
    }

    const links: any[] = [];
    const aliases: string[] = [];
    // Canonical localpart for the subject: prefer the user's casing, else server's.
    const canonical = user?.username || server?.slug;

    if (user) {
      const userUrl = `https://${config.INSTANCE_DOMAIN}/users/${user.username}`;
      aliases.push(userUrl, profilePageUrl(user.username));
      links.push({
        rel: 'self',
        type: 'application/activity+json',
        href: userUrl,
        properties: { [AS_TYPE]: 'Person' },
      });
      links.push({
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: profilePageUrl(user.username),
      });
      links.push({ rel: SUBSCRIBE_REL, template: subscribeTemplate() });
    }

    if (server) {
      const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${server.id}`;
      aliases.push(serverUrl);
      links.push({
        rel: 'self',
        type: 'application/activity+json',
        href: serverUrl,
        properties: { [AS_TYPE]: 'Group' },
      });
    }

    res.setHeader('Content-Type', 'application/jrd+json');
    return res.json({
      subject: canonical ? `acct:${canonical}@${config.INSTANCE_DOMAIN}` : resource,
      aliases,
      links,
    });
  })
);

/**
 * host-meta (XML) - part of the WebFinger discovery chain.
 * Some implementations fetch this first to discover the WebFinger template.
 */
router.get('/.well-known/host-meta', (_req: Request, res: Response) => {
  const domain = config.INSTANCE_DOMAIN;
  res.setHeader('Content-Type', 'application/xrd+xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" type="application/xrd+xml" template="https://${domain}/.well-known/webfinger?resource={uri}" />
</XRD>`);
});

/**
 * host-meta.json - JSON variant of host-meta
 */
router.get('/.well-known/host-meta.json', (_req: Request, res: Response) => {
  const domain = config.INSTANCE_DOMAIN;
  res.json({
    links: [
      {
        rel: 'lrdd',
        type: 'application/jrd+json',
        template: `https://${domain}/.well-known/webfinger?resource={uri}`,
      },
    ],
  });
});

export default router;
