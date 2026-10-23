/**
 * This instance's tools for a server hosted elsewhere (migration 20261027300001): a block
 * (public.instance_server_blocks.blocked) and keep-outs of single local accounts
 * (public.instance_server_keepouts). Both act on this instance only.
 *
 * A blocked copy takes no relay, no copy-inbox activity and no channel write, and no local
 * account discovers or joins it; a kept-out account does not join it. A lookup that fails
 * reads as not blocked: the membership guard on user_servers still refuses the join.
 */

import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

type Supabase = ReturnType<typeof getSupabaseClient>;

export type JoinRefusalCode = 'server_blocked_here' | 'kept_out_here';

export interface JoinRefusal {
  code: JoinRefusalCode;
  error: string;
}

/** The copy `serverId` is blocked on this instance. */
export async function isServerBlockedHere(supabase: Supabase, serverId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('instance_server_blocks')
    .select('blocked')
    .eq('server_id', serverId)
    .maybeSingle();
  if (error) {
    logger.warn(`Block of server ${serverId} not read: ${error.message}`);
    return false;
  }
  return data?.blocked === true;
}

/** The copy whose Group is `groupUrl` is blocked on this instance. */
export async function isGroupBlockedHere(supabase: Supabase, groupUrl: string): Promise<boolean> {
  const { data: server } = await supabase
    .from('servers')
    .select('id')
    .eq('ap_id', groupUrl)
    .eq('is_local_server', false)
    .maybeSingle();
  return !!server && isServerBlockedHere(supabase, server.id);
}

export function serverBlockedRefusal(): JoinRefusal {
  return { code: 'server_blocked_here', error: `This server is blocked on ${config.INSTANCE_DOMAIN}` };
}

/** Why `profileId` may not join the copy `serverId` from this instance; null when it may. */
export async function joinRefusalHere(supabase: Supabase, serverId: string, profileId: string): Promise<JoinRefusal | null> {
  if (await isServerBlockedHere(supabase, serverId)) return serverBlockedRefusal();
  const { data, error } = await supabase
    .from('instance_server_keepouts')
    .select('profile_id')
    .eq('server_id', serverId)
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) logger.warn(`Keep-out of ${profileId} in ${serverId} not read: ${error.message}`);
  if (data) {
    return {
      code: 'kept_out_here',
      error: `${config.INSTANCE_DOMAIN} staff removed you from this server; you can't rejoin it from ${config.INSTANCE_DOMAIN}`,
    };
  }
  return null;
}
