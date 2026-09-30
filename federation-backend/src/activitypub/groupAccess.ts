/**
 * Read authorization for the Group endpoints (GroupService).
 *
 * A public server's channels that @everyone can view are served to anyone.
 * Everything else is served only to a remote member: the key owner of a
 * verified HTTP signature whose profile holds an accepted membership, for the
 * channels it can view. The decision is public.federation_group_access.
 */

import type { Request } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { BlockedInstancesCache } from '../services/BlockedInstancesCache.js';
import { SignatureService } from './SignatureService.js';

export interface GroupAccess {
  isPublic: boolean;
  /** Profile id of the signed remote member; null for anyone else. */
  memberId: string | null;
  /** Local channels @everyone can view, whether or not the server is public. */
  everyoneChannelIds: Set<string>;
  /** Local channels the member can view; empty without a member. */
  memberChannelIds: Set<string>;
}

/**
 * Key owner of a valid HTTP signature on this request, or null. An absent,
 * invalid or blocked-instance signature reads as anonymous; public content is
 * still served to it.
 */
export async function verifiedSigner(req: Request): Promise<string | null> {
  const signature = req.headers.signature;
  if (typeof signature !== 'string' || !signature) return null;

  // A signature that leaves out (request-target) authorizes any path on this
  // host within the Date window; Mastodon's signed GETs always cover it.
  const covered = /headers="([^"]*)"/i.exec(signature)?.[1].toLowerCase().split(/\s+/) ?? [];
  if (!covered.includes('(request-target)')) return null;

  const verification = await SignatureService.verifySignature(
    signature,
    req.headers as Record<string, string>,
    req.method,
    req.originalUrl || req.url,
  );
  if (!verification.verified || !verification.actorUrl) {
    logger.debug(`Unverified signature on ${req.method} ${req.originalUrl}: ${verification.error}`);
    return null;
  }

  try {
    if (BlockedInstancesCache.isBlocked(new URL(verification.actorUrl).hostname.toLowerCase())) {
      return null;
    }
  } catch {
    return null;
  }
  return verification.actorUrl;
}

/** Access of `actorUrl` (null: anonymous) to a local server; null when no local server has that id. */
export async function loadGroupAccess(serverId: string, actorUrl: string | null): Promise<GroupAccess | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('federation_group_access', {
    p_server_id: serverId,
    p_actor_ap_id: actorUrl,
  });

  if (error) {
    // 22P02: the id is not a uuid. Any other error fails closed.
    if (error.code !== '22P02') {
      logger.error(`federation_group_access failed for server ${serverId}: ${error.message}`);
    }
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;

  return {
    isPublic: row.is_public === true,
    memberId: row.member_id ?? null,
    everyoneChannelIds: new Set<string>(row.everyone_channel_ids ?? []),
    memberChannelIds: new Set<string>(row.member_channel_ids ?? []),
  };
}

/** The caller may read the server's collections at all. */
export function canReadServer(access: GroupAccess): boolean {
  return access.isPublic || access.memberId !== null;
}

/** Channels anyone may read: @everyone's, on a public server. */
export function publicChannelIds(access: GroupAccess): Set<string> {
  return access.isPublic ? access.everyoneChannelIds : new Set();
}

/** Channels this caller may read. */
export function readableChannelIds(access: GroupAccess): Set<string> {
  const ids = new Set(publicChannelIds(access));
  for (const id of access.memberChannelIds) ids.add(id);
  return ids;
}

/** A response is shareable when it holds nothing beyond what anyone may read. */
export function isPublicView(access: GroupAccess, channelIds: Iterable<string>): boolean {
  if (!access.isPublic) return false;
  for (const id of channelIds) {
    if (!access.everyoneChannelIds.has(id)) return false;
  }
  return true;
}
