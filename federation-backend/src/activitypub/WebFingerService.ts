import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import config from '../config/index.js';

const router = Router();

/**
 * WebFinger endpoint
 * /.well-known/webfinger?resource=acct:username@domain
 */
router.get(
  '/.well-known/webfinger',
  asyncHandler(async (req: Request, res: Response) => {
    const resource = req.query.resource as string;

    if (!resource) {
      return res.status(400).json({
        error: 'Missing resource parameter',
      });
    }

    const match = resource.match(/^acct:([^@]+)@(.+)$/);
    
    if (!match) {
      return res.status(400).json({
        error: 'Invalid resource format',
      });
    }

    const [, username, domain] = match;

    if (domain.toLowerCase() !== config.INSTANCE_DOMAIN.toLowerCase()) {
      return res.status(404).json({
        error: 'User not found on this instance',
      });
    }

    // A handle can name a user (Person) AND/OR a chat server (Group). They are
    // distinct actor types that may share a localpart, exactly like Lemmy's
    // users vs communities. WebFinger has no type field in the acct: URI, so we
    // return one rel="self" link PER matching actor, each tagged with its
    // ActivityStreams type in `properties`. The requester filters by the type
    // it wants (Mastodon-style consumers that ignore properties just take the
    // first link - fine, since collisions are rare and servers aren't @-mentioned).
    const AS_TYPE = 'https://www.w3.org/ns/activitystreams#type';
    const supabase = getSupabaseClient();

    const [{ data: user }, { data: server }] = await Promise.all([
      supabase
        .from('profiles')
        .select('username')
        .ilike('username', username)
        .eq('is_local', true)
        .maybeSingle(),
      // Only public, federation-enabled local servers are discoverable by
      // handle. Private servers stay invite-only (reached by Group-actor URL
      // through the invite flow), never by guessing a handle.
      supabase
        .from('servers')
        .select('id, slug')
        .ilike('slug', username)
        .eq('is_local_server', true)
        .eq('federation_enabled', true)
        .eq('public', true)
        .maybeSingle(),
    ]);

    if (!user && !server) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const links: any[] = [];
    const aliases: string[] = [];
    // Canonical localpart for the subject: prefer the user's casing, else server's.
    const canonical = user?.username || server?.slug;

    if (user) {
      const userUrl = `https://${config.INSTANCE_DOMAIN}/users/${user.username}`;
      aliases.push(userUrl);
      links.push({
        rel: 'self',
        type: 'application/activity+json',
        href: userUrl,
        properties: { [AS_TYPE]: 'Person' },
      });
      links.push({
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `https://${config.INSTANCE_DOMAIN}/social/profile/${user.username}`,
      });
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
      subject: `acct:${canonical}@${config.INSTANCE_DOMAIN}`,
      aliases,
      links,
    });
  })
);

/**
 * host-meta (XML) - part of the WebFinger discovery chain.
 * Some implementations fetch this first to discover the WebFinger template.
 */
router.get('/.well-known/host-meta', (req: Request, res: Response) => {
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
router.get('/.well-known/host-meta.json', (req: Request, res: Response) => {
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
