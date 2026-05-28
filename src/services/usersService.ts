import { supabase } from '@/supabase';
import type { Profile } from '@/types';

// Cache for server member IDs with TTL
const serverMemberCache = new Map<string, { userIds: string[], timestamp: number }>()
const pendingServerMemberRequests = new Map<string, Promise<string[]>>()
const MEMBER_CACHE_TTL = 2 * 60 * 1000 // 2 minutes

// RLS on user_servers is scoped: users can only see memberships for servers
// they belong to (see migration 20260323_fix_user_servers_select_rls.sql).
const getUserIdsForServer = async (serverId: string): Promise<string[]> => {
  const now = Date.now()
  
  // Check cache first
  const cached = serverMemberCache.get(serverId)
  if (cached && (now - cached.timestamp) < MEMBER_CACHE_TTL) {
    return cached.userIds
  }
  
  // Deduplicate concurrent requests
  if (pendingServerMemberRequests.has(serverId)) {
    return pendingServerMemberRequests.get(serverId)!
  }
  
  const fetchPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from('user_servers')
        .select('user_id')
        .eq('server_id', serverId);

      if (error) throw error;
      
      const userIds = data.map(item => item.user_id)
      
      // Cache the result
      serverMemberCache.set(serverId, { userIds, timestamp: Date.now() })
      
      return userIds
    } finally {
      pendingServerMemberRequests.delete(serverId)
    }
  })()
  
  pendingServerMemberRequests.set(serverId, fetchPromise)
  return fetchPromise
};

/**
 * Batch-fetch member IDs for multiple servers in a single query.
 * Uses the same cache as getUserIdsForServer - only queries uncached servers.
 */
const getUserIdsForServers = async (serverIds: string[]): Promise<Map<string, string[]>> => {
  const now = Date.now()
  const uncachedIds = serverIds.filter(id => {
    const cached = serverMemberCache.get(id)
    return !cached || (now - cached.timestamp) >= MEMBER_CACHE_TTL
  })

  if (uncachedIds.length > 0) {
    const { data, error } = await supabase
      .from('user_servers')
      .select('user_id, server_id')
      .in('server_id', uncachedIds)

    if (error) throw error

    const grouped = new Map<string, string[]>()
    data?.forEach(row => {
      if (!grouped.has(row.server_id)) grouped.set(row.server_id, [])
      grouped.get(row.server_id)!.push(row.user_id)
    })
    const ts = Date.now()
    for (const [sid, uids] of grouped) {
      serverMemberCache.set(sid, { userIds: uids, timestamp: ts })
    }
    for (const sid of uncachedIds) {
      if (!grouped.has(sid)) {
        serverMemberCache.set(sid, { userIds: [], timestamp: ts })
      }
    }
  }

  const result = new Map<string, string[]>()
  for (const id of serverIds) {
    result.set(id, serverMemberCache.get(id)?.userIds || [])
  }
  return result
}

/**
 * Invalidate the member cache for a server (call when members join/leave)
 */
const invalidateServerMemberCache = (serverId: string): void => {
  serverMemberCache.delete(serverId)
}

/**
 * Clear all member caches
 */
const clearAllMemberCaches = (): void => {
  serverMemberCache.clear()
}

const getProfiles = async (userIds: string[]): Promise<Profile[]> => {
    const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .in('id', userIds);

    if (error) throw error;
    return data;
};

const getProfilesWithAvatarUrls = async (userIds: string[]): Promise<Profile[]> => {
    const profiles = await getProfiles(userIds);
    const avatarUrls = profiles.map(profile => profile.avatar_url).filter((url): url is string => !!url);

    if (avatarUrls.length > 0) {
        const { data: signedUrls, error } = await supabase.storage
            .from('avatars')
            .createSignedUrls(avatarUrls, 3600); // 1 hour validity

        if (!error) {
            const urlMap = new Map(signedUrls.map(u => [u.path, u.signedUrl]));
            profiles.forEach(profile => {
                if (profile.avatar_url) {
                    profile.avatar_url = urlMap.get(profile.avatar_url) || profile.avatar_url;
                }
            });
        }
    }

    return profiles;
};

export { 
  getUserIdsForServer,
  getUserIdsForServers,
  getProfiles, 
  getProfilesWithAvatarUrls,
  invalidateServerMemberCache,
  clearAllMemberCaches
}