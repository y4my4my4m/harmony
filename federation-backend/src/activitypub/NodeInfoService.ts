import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import config from '../config/index.js';

const router = Router();

/**
 * NodeInfo discovery endpoint
 * /.well-known/nodeinfo
 */
router.get(
  '/.well-known/nodeinfo',
  asyncHandler(async (req: Request, res: Response) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.json({
      links: [
        {
          rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
          href: `${baseUrl}/nodeinfo/2.0`,
        },
        {
          rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
          href: `${baseUrl}/nodeinfo/2.1`,
        },
      ],
    });
  })
);

/**
 * NodeInfo 2.0 endpoint
 * /nodeinfo/2.0
 */
router.get(
  '/nodeinfo/2.0',
  asyncHandler(async (req: Request, res: Response) => {
    const supabase = getSupabaseClient();

    // Get user count
    const { count: userCount } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('is_local', true);

    // Get post count
    const { count: postCount } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('is_local', true);

    // Get active users (posted in last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const { count: activeUsers } = await supabase
      .from('posts')
      .select('author_id', { count: 'exact', head: true })
      .eq('is_local', true)
      .gte('created_at', sixMonthsAgo.toISOString());

    res.json({
      version: '2.0',
      software: {
        name: 'harmony',
        version: '1.0.0',
      },
      protocols: ['activitypub'],
      services: {
        outbound: [],
        inbound: [],
      },
      usage: {
        users: {
          total: userCount || 0,
          activeMonth: activeUsers || 0,
          activeHalfyear: activeUsers || 0,
        },
        localPosts: postCount || 0,
      },
      openRegistrations: true,
      metadata: {
        nodeName: config.INSTANCE_NAME,
        nodeDescription: config.INSTANCE_DESCRIPTION,
      },
    });
  })
);

/**
 * NodeInfo 2.1 endpoint (similar to 2.0 with minor additions)
 * /nodeinfo/2.1
 */
router.get(
  '/nodeinfo/2.1',
  asyncHandler(async (req: Request, res: Response) => {
    // Reuse 2.0 logic
    const supabase = getSupabaseClient();

    const { count: userCount } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('is_local', true);

    const { count: postCount } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('is_local', true);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const { count: activeUsers } = await supabase
      .from('posts')
      .select('author_id', { count: 'exact', head: true })
      .eq('is_local', true)
      .gte('created_at', sixMonthsAgo.toISOString());

    res.json({
      version: '2.1',
      software: {
        name: 'harmony',
        version: '1.0.0',
        repository: 'https://github.com/your-repo/harmony', // TODO: Update
      },
      protocols: ['activitypub'],
      services: {
        outbound: [],
        inbound: [],
      },
      usage: {
        users: {
          total: userCount || 0,
          activeMonth: activeUsers || 0,
          activeHalfyear: activeUsers || 0,
        },
        localPosts: postCount || 0,
      },
      openRegistrations: true,
      metadata: {
        nodeName: config.INSTANCE_NAME,
        nodeDescription: config.INSTANCE_DESCRIPTION,
        features: [
          'discord_like_servers',
          'voice_chat',
          'video_chat',
          'emoji_reactions',
          'mastodon_compatible',
          'misskey_compatible',
        ],
      },
    });
  })
);

export default router;

