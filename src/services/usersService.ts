import { supabase } from '@/supabase';
import type { User } from '@/types';


// TODO: fix the RLS!!!
// currently it's allowing anyone to fetch user_servers, which means people could see what servers other people are in even if they dont share servers...
const getUserIdsForServer = async (serverId: string): Promise<string[]> => {
  const { data, error } = await supabase
    .from('user_servers')
    .select('user_id')
    .eq('server_id', serverId);

  if (error) throw error;
  return data.map(item => item.user_id);
};

const getProfiles = async (userIds: string[]): Promise<User[]> => {
    const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .in('id', userIds);

    if (error) throw error;
    return data;
};

const getProfilesWithAvatarUrls = async (userIds: string[]): Promise<User[]> => {
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

export { getUserIdsForServer, getProfiles, getProfilesWithAvatarUrls }