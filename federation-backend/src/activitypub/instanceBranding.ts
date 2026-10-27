/**
 * Icon, banner and theme colour of a remote instance, as GET /instances/probe reads them: NodeInfo
 * metadata (icon, banner, themeColor; Harmony and Misskey publish them), the Mastodon instance
 * API (icon, thumbnail), Misskey's /api/meta and the instance actor. Stored in the metadata of
 * the instance's federated_instances row through record_instance_branding.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

export interface InstanceBranding {
  icon?: string | null;
  banner?: string | null;
  themeColor?: string | null;
}

const MAX_URL = 2048;

/** An absolute http(s) URL for `value`, resolved against the instance; undefined otherwise. */
export function brandingUrl(domain: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim(), `https://${domain}/`);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const href = url.href;
  return href.length <= MAX_URL ? href : undefined;
}

/** A #rgb, #rgba, #rrggbb or #rrggbbaa colour; undefined otherwise. */
export function brandingColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim())
    ? value.trim()
    : undefined;
}

/**
 * Stores one answered probe of `domain` on its existing row: given values replace the stored
 * ones, absent ones keep them. Returns false when nothing was stored.
 */
export async function recordInstanceBranding(domain: string, branding: InstanceBranding): Promise<boolean> {
  try {
    const { data, error } = await getSupabaseClient().rpc('record_instance_branding', {
      p_domain: domain.toLowerCase(),
      p_icon_url: branding.icon ?? null,
      p_banner_url: branding.banner ?? null,
      p_theme_color: branding.themeColor ?? null,
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (err) {
    logger.debug(`record_instance_branding(${domain}) failed: ${(err as Error)?.message ?? err}`);
    return false;
  }
}
