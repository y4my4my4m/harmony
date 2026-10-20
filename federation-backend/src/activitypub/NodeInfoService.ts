import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
// usage.users windows: activeMonth is the past 30 days, activeHalfyear the past 180.
const ACTIVE_MONTH_DAYS = 30;
const ACTIVE_HALFYEAR_DAYS = 180;
const USAGE_TTL_MS = 10 * 60 * 1000;

export interface NodeInfoUsage {
  users: { total: number; activeMonth: number; activeHalfyear: number };
  localPosts: number;
}

let usageCache: { at: number; usage: NodeInfoUsage } | null = null;

export function __resetNodeInfoUsageCache(): void {
  usageCache = null;
}

/** Local accounts active since `since` (public.nodeinfo_active_users); 0 when unavailable. */
async function activeUsersSince(supabase: any, since: Date): Promise<number> {
  const { data, error } = await supabase.rpc('nodeinfo_active_users', { p_since: since.toISOString() });
  if (error) {
    logger.warn(`nodeinfo_active_users failed: ${error.message}`);
    return 0;
  }
  return Number(data) || 0;
}

/**
 * usage of NodeInfo 2.0 and 2.1, computed at most once per USAGE_TTL_MS. users.total counts
 * the accounts nodeinfo_active_users can count: local, signed up (bots have no auth user),
 * not suspended, not deleted.
 */
export async function nodeInfoUsage(supabase: any, now = Date.now()): Promise<NodeInfoUsage> {
  if (usageCache && now - usageCache.at < USAGE_TTL_MS) return usageCache.usage;

  const [{ count: userCount }, { count: postCount }, activeMonth, activeHalfyear] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true })
      .eq('is_local', true)
      .not('auth_user_id', 'is', null)
      .not('is_suspended', 'is', true)
      .is('deleted_at', null),
    supabase.from('posts').select('*', { count: 'exact', head: true }).eq('is_local', true),
    activeUsersSince(supabase, new Date(now - ACTIVE_MONTH_DAYS * DAY_MS)),
    activeUsersSince(supabase, new Date(now - ACTIVE_HALFYEAR_DAYS * DAY_MS)),
  ]);

  const usage: NodeInfoUsage = {
    users: { total: userCount || 0, activeMonth, activeHalfyear },
    localPosts: postCount || 0,
  };
  usageCache = { at: now, usage };
  return usage;
}

/**
 * NodeInfo discovery endpoint
 * /.well-known/nodeinfo
 */
router.get(
  '/.well-known/nodeinfo',
  asyncHandler(async (_req: Request, res: Response) => {
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
  asyncHandler(async (_req: Request, res: Response) => {
    const supabase = getSupabaseClient();

    const [instanceCfg, usage] = await Promise.all([
      getInstanceConfig(supabase),
      nodeInfoUsage(supabase),
    ]);

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
      usage,
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
  asyncHandler(async (_req: Request, res: Response) => {
    const supabase = getSupabaseClient();

    const [instanceCfg, usage] = await Promise.all([
      getInstanceConfig(supabase),
      nodeInfoUsage(supabase),
    ]);

    res.json({
      version: '2.1',
      software: {
        name: 'harmony',
        version: config.VERSION,
        repository: 'https://github.com/y4my4my4m/harmony',
        homepage: 'https://mony.lol',
      },
      protocols: ['activitypub'],
      services: {
        outbound: [],
        inbound: [],
      },
      usage,
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

