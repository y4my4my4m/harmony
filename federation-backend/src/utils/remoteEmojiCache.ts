/**
 * Custom emoji of an inbound object recorded in remote_emojis_cache (upsert_remote_emoji), the
 * list an instance admin imports from.
 *
 * Mirrors Misskey's ApNoteService.extractEmojis: every Emoji tag of a stored note is recorded
 * with its licence, `_misskey_license.freeText`. A row says what `name` is on `origin_domain`,
 * so only an actor of that instance writes it: a relayed `name@other` is skipped, as is an
 * emoji of this instance echoed back.
 */

import config from '../config/index.js';
import { urlHost } from './apOrigin.js';
import { inboundEmojiOrigin } from './emojiOrigin.js';
import { logger } from './logger.js';

/** Emoji tags read from one object. */
export const MAX_EMOJI_TAGS = 50;

/** emojis_license_check. */
const MAX_LICENSE = 1024;

const SHORTCODE = /^[^\s:@]{1,64}$/;

export interface RemoteEmojiSighting {
  shortcode: string;
  domain: string;
  url: string;
  license: string | null;
}

const hostname = (host: string | null) => host?.toLowerCase().replace(/:\d+$/, '') ?? null;

function iconUrl(icon: unknown): string | null {
  const one = Array.isArray(icon) ? icon[0] : icon;
  const url = typeof one === 'string' ? one : (one as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) return null;
  return url;
}

function licenseOf(tag: Record<string, unknown>): string | null {
  const text = (tag._misskey_license as { freeText?: unknown } | null | undefined)?.freeText;
  if (typeof text !== 'string') return null;
  return text.trim().slice(0, MAX_LICENSE) || null;
}

/** The emoji of `tags` that `actorUrl`'s instance may speak for, one per shortcode. */
export function remoteEmojiSightings(tags: unknown, actorUrl: string | null | undefined): RemoteEmojiSighting[] {
  const sender = hostname(urlHost(actorUrl));
  if (!sender) return [];
  const list = Array.isArray(tags) ? tags : tags ? [tags] : [];
  const seen = new Set<string>();
  const out: RemoteEmojiSighting[] = [];
  for (const tag of list) {
    if (out.length >= MAX_EMOJI_TAGS) break;
    if (!tag || typeof tag !== 'object' || (tag as { type?: unknown }).type !== 'Emoji') continue;
    const name = (tag as { name?: unknown }).name;
    const url = iconUrl((tag as { icon?: unknown }).icon);
    if (typeof name !== 'string' || !url) continue;
    const origin = inboundEmojiOrigin(name, actorUrl, config.INSTANCE_DOMAIN);
    if (origin.own || !origin.domain || hostname(origin.domain) !== sender) continue;
    if (!SHORTCODE.test(origin.name) || seen.has(origin.name)) continue;
    seen.add(origin.name);
    out.push({ shortcode: origin.name, domain: origin.domain, url, license: licenseOf(tag as Record<string, unknown>) });
  }
  return out;
}

/** Records the emoji tags of a stored inbound object. Never throws. */
export async function cacheInboundEmojiTags(supabase: any, tags: unknown, actorUrl: string | null | undefined): Promise<void> {
  let sightings: RemoteEmojiSighting[];
  try {
    sightings = remoteEmojiSightings(tags, actorUrl);
  } catch (error) {
    logger.debug(`Could not read emoji tags: ${error}`);
    return;
  }
  for (const emoji of sightings) {
    try {
      const { error } = await supabase.rpc('upsert_remote_emoji', {
        p_shortcode: emoji.shortcode,
        p_origin_domain: emoji.domain,
        p_full_code: `:${emoji.shortcode}@${emoji.domain}:`,
        p_url: emoji.url,
        // Absent from a schema before 20261111200001; sent only when there is one to store.
        ...(emoji.license ? { p_license: emoji.license } : {}),
      });
      if (error) logger.debug(`Could not cache emoji ${emoji.shortcode}@${emoji.domain}: ${error.message}`);
    } catch (error) {
      logger.debug(`Could not cache emoji ${emoji.shortcode}@${emoji.domain}: ${error}`);
    }
  }
}
