/**
 * Instance Probe Route
 *
 * Proxies instance discovery requests server-side to avoid browser CORS issues.
 * The frontend cannot directly fetch nodeinfo/mastodon-api/webfinger from remote
 * fediverse instances because those servers don't set CORS headers for our origin.
 *
 * A NodeInfo answer, and the icon, banner and theme colour of any answer, are stored on the
 * instance's existing federated_instances row (record_instance_nodeinfo,
 * record_instance_branding; no row created): the route is unauthenticated.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateExternalHostname, safeFetch } from '../utils/ssrfProtection.js';
import { logger } from '../utils/logger.js';
import { SignatureService } from '../activitypub/SignatureService.js';
import { discoveryLimiter } from '../middleware/rateLimit.js';
import { nodeinfoFacts, recordInstanceNodeinfo, type NodeinfoFacts } from '../activitypub/instanceSoftware.js';
import { brandingColor, brandingUrl, recordInstanceBranding } from '../activitypub/instanceBranding.js';

const router = Router();

interface InstanceProbeResult {
  domain: string;
  software?: string;
  version?: string;
  description?: string;
  user_count?: number;
  status_count?: number;
  admin_contact?: string;
  api_available: boolean;
  federation_enabled: boolean;
  icon_url?: string;
  banner_url?: string;
  theme_color?: string;
}

const PROBE_TIMEOUT = 10_000;

async function probeNodeinfo(domain: string): Promise<{ result: InstanceProbeResult; facts: NodeinfoFacts | null } | null> {
  try {
    const wellKnownResponse = await safeFetch(`https://${domain}/.well-known/nodeinfo`, {
      headers: { Accept: 'application/json' },
      timeoutMs: PROBE_TIMEOUT,
    });

    if (!wellKnownResponse.ok) return null;

    const wellKnown = await wellKnownResponse.json();
    const nodeinfoUrl = wellKnown.links?.find(
      (link: any) => link.rel?.includes('nodeinfo') && (link.rel.includes('2.0') || link.rel.includes('2.1'))
    )?.href;

    if (!nodeinfoUrl) return null;

    // BUGS.md H16: nodeinfoUrl is a `href` returned by the remote
    // well-known endpoint - attacker-controlled. safeFetch re-validates
    // the resolved IP per hop. Signed for instances in authorized fetch mode.
    const nodeinfoResponse = await SignatureService.signedApFetch(nodeinfoUrl, {
      headers: { Accept: 'application/json' },
      timeoutMs: PROBE_TIMEOUT,
    });

    if (!nodeinfoResponse.ok) return null;

    const nodeinfo = await nodeinfoResponse.json();

    const result: InstanceProbeResult = {
      domain,
      software: nodeinfo.software?.name || 'unknown',
      version: nodeinfo.software?.version,
      description: nodeinfo.metadata?.nodeDescription || nodeinfo.metadata?.nodeName,
      user_count: nodeinfo.usage?.users?.total || 0,
      status_count: nodeinfo.usage?.localPosts || 0,
      api_available: true,
      federation_enabled: nodeinfo.openRegistrations !== false,
      icon_url: brandingUrl(domain, nodeinfo.metadata?.icon || nodeinfo.metadata?.iconUrl),
      banner_url: brandingUrl(domain, nodeinfo.metadata?.banner || nodeinfo.metadata?.bannerUrl),
      theme_color: brandingColor(nodeinfo.metadata?.themeColor),
    };
    return { result, facts: nodeinfoFacts(nodeinfo) };
  } catch {
    return null;
  }
}

async function probeMastodonAPI(domain: string): Promise<InstanceProbeResult | null> {
  for (const version of ['v2', 'v1']) {
    try {
      const response = await safeFetch(`https://${domain}/api/${version}/instance`, {
        headers: { Accept: 'application/json' },
        timeoutMs: PROBE_TIMEOUT,
      });

      if (!response.ok) continue;

      const instance = await response.json();

      let iconUrl: string | undefined;
      if (instance.icon && Array.isArray(instance.icon) && instance.icon.length > 0) {
        iconUrl = instance.icon[0]?.src || instance.icon[0]?.url;
      } else if (instance.contact?.account?.avatar_static || instance.contact?.account?.avatar) {
        iconUrl = instance.contact.account.avatar_static || instance.contact.account.avatar;
      }

      let bannerUrl: string | undefined;
      if (instance.thumbnail?.url) {
        bannerUrl = instance.thumbnail.url;
      } else if (typeof instance.thumbnail === 'string') {
        bannerUrl = instance.thumbnail;
      }

      return {
        domain: instance.domain || domain,
        software: instance.source_url?.includes('mastodon') ? 'mastodon'
          : instance.source_url?.includes('pleroma') ? 'pleroma'
          : instance.source_url?.includes('akkoma') ? 'akkoma'
          : 'mastodon-compatible',
        version: instance.version,
        description: instance.description || instance.short_description,
        user_count: instance.stats?.user_count || instance.usage?.users?.active_month || 0,
        status_count: instance.stats?.status_count || 0,
        admin_contact: instance.contact?.email || instance.email,
        api_available: true,
        federation_enabled: true,
        icon_url: brandingUrl(domain, iconUrl),
        banner_url: brandingUrl(domain, bannerUrl),
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function probeActivityPubActor(domain: string): Promise<InstanceProbeResult | null> {
  try {
    const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:instance@${domain}`;
    const response = await safeFetch(webfingerUrl, {
      headers: { Accept: 'application/jrd+json, application/json' },
      timeoutMs: PROBE_TIMEOUT,
    });

    if (!response.ok) return null;

    const result: InstanceProbeResult = {
      domain,
      software: 'activitypub-compatible',
      description: 'ActivityPub-compatible instance',
      api_available: true,
      federation_enabled: true,
    };

    try {
      const webfinger = await response.json();
      const actorLink = webfinger.links?.find(
        (l: any) => l.rel === 'self' && l.type === 'application/activity+json'
      );
      if (actorLink?.href) {
        // BUGS.md H16: actorLink.href is from the remote webfinger response.
        const actorResp = await SignatureService.signedApFetch(actorLink.href, {
          headers: { Accept: 'application/activity+json, application/ld+json' },
          timeoutMs: PROBE_TIMEOUT,
        });
        if (actorResp.ok) {
          const actor = await actorResp.json();
          result.icon_url = brandingUrl(domain, actor.icon?.url ?? actor.icon);
          result.banner_url = brandingUrl(domain, actor.image?.url ?? actor.image);
          if (actor.summary) result.description = actor.summary;
        }
      }
    } catch {
      // Actor fetch is best-effort
    }

    return result;
  } catch {
    return null;
  }
}

async function probeMisskeyAPI(domain: string): Promise<InstanceProbeResult | null> {
  try {
    const response = await safeFetch(`https://${domain}/api/meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      timeoutMs: PROBE_TIMEOUT,
    });
    if (!response.ok) return null;

    const meta = await response.json();

    return {
      domain,
      software: 'misskey',
      version: meta.version,
      description: meta.description || meta.name,
      user_count: 0,
      status_count: 0,
      api_available: true,
      federation_enabled: true,
      icon_url: brandingUrl(domain, meta.iconUrl),
      banner_url: brandingUrl(domain, meta.bannerUrl),
      theme_color: brandingColor(meta.themeColor),
    };
  } catch {
    return null;
  }
}

/**
 * GET /instances/probe?domain=mastodon.social
 * Probes a remote fediverse instance server-side and returns merged metadata.
 */
router.get(
  '/instances/probe',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { domain } = req.query;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain query parameter is required' });
    }

    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

    try {
      validateExternalHostname(cleanDomain);
    } catch (err: any) {
      return res.status(400).json({ error: `Invalid domain: ${err.message}` });
    }

    logger.info(`Probing instance: ${cleanDomain}`);

    const [nodeinfoProbe, mastodonResult, actorResult] = await Promise.all([
      probeNodeinfo(cleanDomain),
      probeMastodonAPI(cleanDomain),
      probeActivityPubActor(cleanDomain),
    ]);
    const nodeinfoResult = nodeinfoProbe?.result ?? null;
    if (nodeinfoProbe?.facts) {
      await recordInstanceNodeinfo(cleanDomain, nodeinfoProbe.facts, false);
    }

    const isMisskey = nodeinfoResult?.software?.toLowerCase()?.match(
      /misskey|calckey|firefish|sharkey|foundkey|iceshrimp/
    );
    const misskeyResult = isMisskey ? await probeMisskeyAPI(cleanDomain) : null;

    const base = nodeinfoResult || mastodonResult || misskeyResult || actorResult;
    if (!base) {
      return res.status(404).json({ error: 'Could not discover instance', domain: cleanDomain });
    }

    if (!base.icon_url) {
      base.icon_url = misskeyResult?.icon_url || mastodonResult?.icon_url || actorResult?.icon_url;
    }
    if (!base.banner_url) {
      base.banner_url = misskeyResult?.banner_url || mastodonResult?.banner_url || actorResult?.banner_url;
    }
    if (!base.theme_color) {
      base.theme_color = misskeyResult?.theme_color;
    }
    if (!base.description && misskeyResult?.description) {
      base.description = misskeyResult.description;
    }

    await recordInstanceBranding(cleanDomain, {
      icon: base.icon_url,
      banner: base.banner_url,
      themeColor: base.theme_color,
    });

    logger.info(`Instance probed: ${cleanDomain} (${base.software})`);

    return res.json(base);
  })
);

/**
 * GET /instances/health?domain=mastodon.social
 * Lightweight health check - verifies nodeinfo is reachable.
 */
router.get(
  '/instances/health',
  discoveryLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { domain } = req.query;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain query parameter is required' });
    }

    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

    try {
      validateExternalHostname(cleanDomain);
    } catch (err: any) {
      return res.status(400).json({ error: `Invalid domain: ${err.message}` });
    }

    try {
      const protocol = cleanDomain.includes('localhost') ? 'http' : 'https';
      const wellKnownRes = await safeFetch(`${protocol}://${cleanDomain}/.well-known/nodeinfo`, {
        headers: { Accept: 'application/json' },
        timeoutMs: 8000,
      });
      if (!wellKnownRes.ok) {
        return res.json({ domain: cleanDomain, status: 'offline' });
      }

      const wk = await wellKnownRes.json();
      const nodeinfoUrl = wk.links?.find(
        (l: any) => l.rel?.includes('nodeinfo') && (l.rel.includes('2.0') || l.rel.includes('2.1'))
      )?.href;

      if (!nodeinfoUrl) {
        return res.json({ domain: cleanDomain, status: 'offline' });
      }

      const infoUrl = typeof nodeinfoUrl === 'string' ? nodeinfoUrl : '';
      const url = infoUrl.startsWith('http')
        ? infoUrl
        : `${protocol}://${cleanDomain}${infoUrl.startsWith('/') ? '' : '/'}${infoUrl}`;

      const infoRes = await SignatureService.signedApFetch(url, {
        headers: { Accept: 'application/json' },
        timeoutMs: 8000,
      });

      return res.json({ domain: cleanDomain, status: infoRes.ok ? 'online' : 'offline' });
    } catch {
      return res.json({ domain: cleanDomain, status: 'offline' });
    }
  })
);

export default router;
