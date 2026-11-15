import { supabase } from '@/supabase';
import { readAllRows } from '@/services/pagedRead';
import type { Profile } from '@/types';

// Cache for server member IDs with TTL
const serverMemberCache = new Map<string, { userIds: string[], timestamp: number }>()
const pendingServerMemberRequests = new Map<string, Promise<string[]>>()
const MEMBER_CACHE_TTL = 2 * 60 * 1000 // 2 minutes

/** Profile ids one `id=in.(...)` request carries; a longer URL is refused by reverse proxies. */
const PROFILE_ID_CHUNK = 100

/**
 * Ids of a server's accepted members, read in pages to the end. A whole-membership read:
 * for an instance without the member directory, and for callers that need every member
 * (encryption recipients). RLS on user_servers shows a server's rows to its members.
 */
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
      const rows = await readAllRows<{ user_id: string }>(() => supabase
        .from('user_servers')
        .select('user_id', { count: 'exact' })
        .eq('server_id', serverId)
        // A row with no status is an accepted member, as current_user_server_ids reads it.
        .or('status.is.null,status.eq.accepted')
        .order('user_id'));

      const userIds = rows.map(item => item.user_id)
      
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
    const profiles: Profile[] = [];
    for (let i = 0; i < userIds.length; i += PROFILE_ID_CHUNK) {
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .in('id', userIds.slice(i, i + PROFILE_ID_CHUNK));

        if (error) throw error;
        profiles.push(...(data ?? []));
    }
    return profiles;
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
  getProfiles, 
  getProfilesWithAvatarUrls,
  invalidateServerMemberCache,
  clearAllMemberCaches
}