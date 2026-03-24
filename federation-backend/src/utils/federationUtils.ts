/**
 * Shared federation utilities
 * 
 * Functions used across multiple federation handlers (channel messages, threads, profiles, etc.)
 */

import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';

export interface RemoteMemberGroup {
  instance: string;
  member_ap_ids: string[];
  member_count: number;
  shared_inbox?: string;
}

/**
 * Get remote member groups for a server, grouped by instance.
 * Used to determine which remote instances need to receive federated activities.
 */
export async function getRemoteMemberGroups(serverId: string): Promise<RemoteMemberGroup[]> {
  const supabase = getSupabaseClient();
  const hostDomain = config.INSTANCE_DOMAIN;

  const { data: memberGroups, error: rpcError } = await supabase
    .rpc('get_server_members_by_instance', { p_server_id: serverId });

  if (!rpcError && memberGroups) {
    return memberGroups.filter(
      (group: any) => group.instance !== 'local' && group.instance !== hostDomain
    );
  }

  // Fallback: manual query
  const { data: members } = await supabase
    .from('user_servers')
    .select(`
      member_instance,
      profile:profiles!user_servers_user_id_fkey(federated_id, shared_inbox_url)
    `)
    .eq('server_id', serverId)
    .eq('status', 'accepted')
    .not('member_instance', 'is', null);

  if (!members) {
    return [];
  }

  const instanceMap = new Map<string, RemoteMemberGroup>();

  for (const member of members) {
    const instance = member.member_instance;
    if (!instance || instance === hostDomain) continue;

    const profile = (member as any).profile;
    if (!profile?.federated_id) continue;

    if (!instanceMap.has(instance)) {
      instanceMap.set(instance, {
        instance,
        member_ap_ids: [],
        member_count: 0,
        shared_inbox: profile.shared_inbox_url || `https://${instance}/inbox`,
      });
    }

    const group = instanceMap.get(instance)!;
    group.member_ap_ids.push(profile.federated_id);
    group.member_count++;
  }

  return Array.from(instanceMap.values());
}

/**
 * Get all unique remote instances the user shares servers with.
 * Returns deduplicated shared inbox URLs mapped by instance.
 */
export async function getServerCoMemberInstances(profileId: string): Promise<RemoteMemberGroup[]> {
  const supabase = getSupabaseClient();

  // Get all servers this user belongs to
  const { data: userServers, error: serverError } = await supabase
    .from('user_servers')
    .select('server_id')
    .eq('user_id', profileId)
    .eq('status', 'accepted');

  if (serverError || !userServers || userServers.length === 0) {
    return [];
  }

  // Collect remote member groups across all servers, dedup by instance
  const instanceMap = new Map<string, RemoteMemberGroup>();

  for (const us of userServers) {
    const groups = await getRemoteMemberGroups(us.server_id);
    for (const group of groups) {
      if (!instanceMap.has(group.instance)) {
        instanceMap.set(group.instance, {
          instance: group.instance,
          member_ap_ids: [...group.member_ap_ids],
          member_count: group.member_count,
          shared_inbox: group.shared_inbox,
        });
      } else {
        const existing = instanceMap.get(group.instance)!;
        for (const apId of group.member_ap_ids) {
          if (!existing.member_ap_ids.includes(apId)) {
            existing.member_ap_ids.push(apId);
            existing.member_count++;
          }
        }
      }
    }
  }

  return Array.from(instanceMap.values());
}
