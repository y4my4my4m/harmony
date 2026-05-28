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
    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;

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
async function getInstanceConfig(supabase: any) {
  const { data } = await supabase
    .from('instance_config')
    .select('config_key, config_value')
    .in('config_key', [
      'instance_name', 'instance_description', 'open_registration',
      'instance_icon', 'instance_banner',
      'theme_color', 'maintainer_name', 'maintainer_email',
    ]);

  const cfg: Record<string, any> = {};
  data?.forEach((row: any) => {
    try {
      cfg[row.config_key] = JSON.parse(row.config_value);
    } catch {
      cfg[row.config_key] = row.config_value;
    }
  });

  return {
    name: cfg.instance_name || config.INSTANCE_NAME,
    description: cfg.instance_description || config.INSTANCE_DESCRIPTION,
    openRegistrations: cfg.open_registration !== 'false' && cfg.open_registration !== false,
    icon: cfg.instance_icon || undefined,
    banner: cfg.instance_banner || undefined,
    themeColor: cfg.theme_color || undefined,
    maintainerName: cfg.maintainer_name || undefined,
    maintainerEmail: cfg.maintainer_email || undefined,
  };
}

router.get(
  '/nodeinfo/2.0',
  asyncHandler(async (req: Request, res: Response) => {
    const supabase = getSupabaseClient();

    const [instanceCfg, { count: userCount }, { count: postCount }] = await Promise.all([
      getInstanceConfig(supabase),
      supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('is_local', true),
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('is_local', true),
    ]);

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
        version: config.VERSION,
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
      openRegistrations: instanceCfg.openRegistrations,
      metadata: {
        nodeName: instanceCfg.name,
        nodeDescription: instanceCfg.description,
        ...(instanceCfg.icon && { icon: instanceCfg.icon }),
        ...(instanceCfg.banner && { banner: instanceCfg.banner }),
        ...(instanceCfg.themeColor && { themeColor: instanceCfg.themeColor }),
        ...(instanceCfg.maintainerName || instanceCfg.maintainerEmail
          ? {
              maintainer: {
                ...(instanceCfg.maintainerName && { name: instanceCfg.maintainerName }),
                ...(instanceCfg.maintainerEmail && { email: instanceCfg.maintainerEmail }),
              },
            }
          : {}),
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
    const supabase = getSupabaseClient();

    const [instanceCfg, { count: userCount }, { count: postCount }] = await Promise.all([
      getInstanceConfig(supabase),
      supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('is_local', true),
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('is_local', true),
    ]);

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
        version: config.VERSION,
        repository: 'https://github.com/y4my4my4m/harmony',
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
      openRegistrations: instanceCfg.openRegistrations,
      metadata: {
        nodeName: instanceCfg.name,
        nodeDescription: instanceCfg.description,
        ...(instanceCfg.icon && { icon: instanceCfg.icon }),
        ...(instanceCfg.banner && { banner: instanceCfg.banner }),
        ...(instanceCfg.themeColor && { themeColor: instanceCfg.themeColor }),
        ...(instanceCfg.maintainerName || instanceCfg.maintainerEmail
          ? {
              maintainer: {
                ...(instanceCfg.maintainerName && { name: instanceCfg.maintainerName }),
                ...(instanceCfg.maintainerEmail && { email: instanceCfg.maintainerEmail }),
              },
            }
          : {}),
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

