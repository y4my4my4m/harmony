/**
 * Read authorization for ActivityPub objects that are not channel content: posts and
 * conversation (DM) messages.
 *
 * Public and unlisted posts are served to anyone. A followers-only or direct post, and a
 * conversation message, is served only to a verified HTTP signature whose actor's host
 * passes public.federation_post_access or public.federation_conversation_access (migration
 * 20261006900001_private_user_media.sql); anything else reads as absent. Mastodon's
 * StatusPolicy decides the same way, by the signing account's instance.
 */

import type { Request } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { verifiedSigner } from './groupAccess.js';

export const PUBLIC_VISIBILITIES = ['public', 'unlisted'] as const;

/** Cache-Control of an object only some signers may read. */
export const PRIVATE_CACHE = 'private, no-store';

export function isPublicVisibility(visibility: string | null | undefined): boolean {
  return !visibility || (PUBLIC_VISIBILITIES as readonly string[]).includes(visibility);
}

/** Host (with port, as profiles.domain stores it) of a signer's actor URL. */
export function signerHost(actorUrl: string | null): string | null {
  if (!actorUrl) return null;
  try {
    return new URL(actorUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

async function accessRpc(fn: string, args: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc(fn, args);
  if (error) {
    logger.error(`${fn} failed: ${error.message}`);
    return false;
  }
  return data === true;
}

/** Whether the request may read the post. Public and unlisted posts need no signature. */
export async function canReadPost(
  req: Request,
  post: { id: string; visibility?: string | null },
): Promise<boolean> {
  if (isPublicVisibility(post.visibility)) return true;
  const host = signerHost(await verifiedSigner(req));
  if (!host) return false;
  return accessRpc('federation_post_access', { p_post_id: post.id, p_domain: host });
}

/** Whether the request may read a message of the conversation. */
export async function canReadConversation(req: Request, conversationId: string): Promise<boolean> {
  const host = signerHost(await verifiedSigner(req));
  if (!host) return false;
  return accessRpc('federation_conversation_access', { p_conversation_id: conversationId, p_domain: host });
}
