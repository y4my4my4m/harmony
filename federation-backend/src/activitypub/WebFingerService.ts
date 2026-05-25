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

    // Parse resource (format: acct:username@domain)
    const match = resource.match(/^acct:([^@]+)@(.+)$/);
    
    if (!match) {
      return res.status(400).json({
        error: 'Invalid resource format',
      });
    }

    const [, username, domain] = match;

    // Verify domain matches our instance (case-insensitive per RFC 7033)
    if (domain.toLowerCase() !== config.INSTANCE_DOMAIN.toLowerCase()) {
      return res.status(404).json({
        error: 'User not found on this instance',
      });
    }

    // Lookup user (case-insensitive username via ilike)
    const supabase = getSupabaseClient();
    const { data: user, error } = await supabase
      .from('profiles')
      .select('username, domain')
      .ilike('username', username)
      .eq('is_local', true)
      .maybeSingle();

    if (error || !user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    const canonicalUsername = user.username;
    const userUrl = `https://${config.INSTANCE_DOMAIN}/users/${canonicalUsername}`;

    res.setHeader('Content-Type', 'application/jrd+json');
    res.json({
      subject: `acct:${canonicalUsername}@${config.INSTANCE_DOMAIN}`,
      aliases: [userUrl],
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: userUrl,
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: `https://${config.INSTANCE_DOMAIN}/social/profile/${canonicalUsername}`,
        },
      ],
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
