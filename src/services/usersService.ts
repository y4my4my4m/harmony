import { supabase } from '@/supabase';
import type { Profile } from '@/types';

// OPTIMIZED: Cache for server member IDs with TTL
const serverMemberCache = new Map<string, { userIds: string[], timestamp: number }>()
const pendingServerMemberRequests = new Map<string, Promise<string[]>>()
const MEMBER_CACHE_TTL = 2 * 60 * 1000 // 2 minutes

// TODO: fix the RLS!!!
// currently it's allowing anyone to fetch user_servers, which means people could see what servers other people are in even if they dont share servers...
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
    const avatarUrls = profiles.map(profile => profile.avatar_url).filter(url => url);

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
  getProfiles, 
  getProfilesWithAvatarUrls,
  invalidateServerMemberCache,
  clearAllMemberCaches
}