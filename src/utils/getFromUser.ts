// import type { Profile } from '@/types';

import { supabase } from '@/supabase';
import type { User } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { debug } from '@/utils/debug'

export const GetUserIdFromUsername = async (username: string): Promise<string> => {
    // fetch from supabase's profiles table
    const { data, error } = await supabase.from('profiles').select('id').eq('username', username);
    if (error || !data) {
        debug.error('Error fetching user id from username', error);
        return '';
    }
    if (data.length === 0) {
        debug.error('No user found with username', username);
        return '';
    }
    return data[0].id;
}

// Get user profile by ID with caching
export const GetUserProfileById = async (userId: string, forceRefresh = false): Promise<User | null> => {
    const serverUsersStore = useServerUsersStore();
    return await serverUsersStore.fetchUserProfile(userId, forceRefresh);
}

// Get user profile by username with caching
export const GetUserProfileByUsername = async (username: string, forceRefresh = false): Promise<User | null> => {
    const userId = await GetUserIdFromUsername(username);
    if (!userId) return null;
    
    return await GetUserProfileById(userId, forceRefresh);
}

// Get multiple user profiles efficiently
export const GetMultipleUserProfiles = async (userIds: string[], forceRefresh = false): Promise<Record<string, User>> => {
    const serverUsersStore = useServerUsersStore();
    return await serverUsersStore.fetchMultipleUserProfiles(userIds, forceRefresh);
}

// Check if user profile is cached
export const IsUserProfileCached = (userId: string): boolean => {
    const serverUsersStore = useServerUsersStore();
    return serverUsersStore.getUserProfile(userId) !== null;
}