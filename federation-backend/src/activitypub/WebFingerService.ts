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

    // Verify domain matches our instance
    if (domain !== config.INSTANCE_DOMAIN) {
      return res.status(404).json({
        error: 'User not found on this instance',
      });
    }

    // Lookup user
    const supabase = getSupabaseClient();
    const { data: user, error } = await supabase
      .from('profiles')
      .select('username, domain')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (error || !user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    const userUrl = `https://${config.INSTANCE_DOMAIN}/users/${username}`;

    res.json({
      subject: `acct:${username}@${config.INSTANCE_DOMAIN}`,
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
          href: userUrl,
        },
      ],
    });
  })
);

export default router;

