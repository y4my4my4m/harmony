/**
 * Server card of an invite code, as public.get_invite_preview answers it to anyone holding
 * the code. Local servers only: the function answers not_found for a remote one.
 */

import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { cache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';

/** Codes invite links carry. Minted codes are 8 of [A-Z0-9]. */
export const INVITE_CODE = /^[A-Za-z0-9_-]{3,64}$/;

const INVITE_PATH = /^\/invite\/([A-Za-z0-9_-]{3,64})\/?$/;

const TTL_SECONDS = 60;

export interface InvitePreview {
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  memberCount: number;
  /** Null from a database without 20261012000001. */
  onlineCount: number | null;
}

export type InvitePreviewResult =
  | { status: 'valid'; preview: InvitePreview }
  | { status: 'invalid' }
  | { status: 'unavailable' };

export function inviteUrl(code: string): string {
  return `https://${config.INSTANCE_DOMAIN}/invite/${code}`;
}

/** Code of an invite link on this instance, or null. */
export function inviteCodeFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.host.toLowerCase() !== config.INSTANCE_DOMAIN.toLowerCase()) return null;
  return INVITE_PATH.exec(parsed.pathname)?.[1] ?? null;
}

function count(value: unknown): number | null {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Memoised for TTL_SECONDS per code; a failed lookup is not memoised. */
export async function loadInvitePreview(code: string): Promise<InvitePreviewResult> {
  if (!INVITE_CODE.test(code)) return { status: 'invalid' };

  const key = `invite-preview:${code}`;
  const cached = await cache.getAsync<InvitePreviewResult>(key);
  if (cached) return cached;

  let data: any;
  try {
    const answer = await getSupabaseClient().rpc('get_invite_preview', { p_code: code });
    if (answer.error) throw new Error(answer.error.message);
    data = answer.data;
  } catch (err) {
    logger.warn(`get_invite_preview failed: ${(err as Error).message}`);
    return { status: 'unavailable' };
  }
  if (!data || typeof data !== 'object') return { status: 'unavailable' };

  const result: InvitePreviewResult = data.status === 'valid'
    ? {
        status: 'valid',
        preview: {
          code,
          name: text(data.name) ?? 'Server',
          description: text(data.description),
          icon: text(data.icon),
          banner: text(data.banner),
          memberCount: count(data.member_count) ?? 0,
          onlineCount: count(data.online_count),
        },
      }
    : { status: 'invalid' };

  cache.set(key, result, TTL_SECONDS);
  return result;
}
