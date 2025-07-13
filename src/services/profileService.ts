import { supabase } from '../supabase';
import type { User } from '@/types';

// Get profile by profile ID (for federated users and direct lookups)
const getProfile = async (userId: string): Promise<User | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return data;
};

// Get profile by auth user ID (for local authenticated users)
const getProfileByAuthUserId = async (authUserId: string): Promise<User | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('auth_user_id', authUserId)
    .single();

  if (error) throw error;
  return data;
};

// Get profile with avatar URL by profile ID
const getProfileWithAvatarUrl = async (userId: string): Promise<User | null> => {
  const profile = await getProfile(userId);
  if (!profile || !profile.avatar_url) return profile;

  try {
    const { data, error } = await supabase.storage
      .from('avatars')
      .createSignedUrl(profile.avatar_url, 60); // 60 seconds validity for the URL

    if (error) throw error;
    profile.avatar_url = data.signedUrl;
    return profile;
  } catch (error) {
    console.error('Error getting signed avatar URL:', error);
    return profile; // Return the profile even if the URL fetch fails
  }
};

// Get profile with avatar URL by auth user ID (for authenticated users)
const getProfileWithAvatarUrlByAuthUserId = async (authUserId: string): Promise<User | null> => {
  const profile = await getProfileByAuthUserId(authUserId);
  if (!profile || !profile.avatar_url) return profile;

  try {
    const { data, error } = await supabase.storage
      .from('avatars')
      .createSignedUrl(profile.avatar_url, 60); // 60 seconds validity for the URL

    if (error) throw error;
    profile.avatar_url = data.signedUrl;
    return profile;
  } catch (error) {
    console.error('Error getting signed avatar URL:', error);
    return profile; // Return the profile even if the URL fetch fails
  }
};

const updateProfile = async (userId: string, updates: Partial<User>): Promise<User | undefined> => {
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .match({ id: userId });

  if (error) throw error;
  
  // If the update was successful, broadcast profile changes to relevant contexts only
  if (data && data[0]) {
    try {
      // Import dynamically to avoid circular dependencies
      const { userDataService } = await import('./userDataService')
      
      // Extract profile data that should be broadcast
      const profileData: any = {}
      if (updates.username !== undefined) profileData.username = updates.username
      if (updates.display_name !== undefined) profileData.displayName = updates.display_name
      if (updates.avatar_url !== undefined) profileData.avatarUrl = updates.avatar_url
      
      // Handle Profile-specific fields safely
      const profileUpdates = updates as any
      if (profileUpdates.bio !== undefined) profileData.bio = profileUpdates.bio
      if (profileUpdates.color !== undefined) profileData.color = profileUpdates.color
      
      // Only broadcast if there are profile changes to broadcast
      if (Object.keys(profileData).length > 0) {
        await userDataService.updateCurrentUserProfile(profileData)
        console.log('✅ Profile updated and broadcast to relevant contexts only')
      }
    } catch (presenceError) {
      // Don't fail the profile update if presence broadcast fails
      console.error('Failed to broadcast profile changes:', presenceError)
    }
  }

  return data ? data[0] : undefined;
};

const downloadAvatar = async (avatarPath: string): Promise<string> => {
  const { data, error } = await supabase.storage.from('avatars').download(avatarPath);
  if (error) throw error;

  const url = URL.createObjectURL(data);
  return url;
};

const uploadAvatar = async (userId: string, file: File): Promise<string> => {
  const filePath = `${userId}/${file.name}`;
  const { error } = await supabase.storage.from('avatars').upload(filePath, file);

  if (error) throw error;
  return filePath;
};

const updateUserStatus = async (userId: string, status: number) => {
  const { data, error } = await supabase
    .from('profiles')
    .update({ status })
    .eq('id', userId);

  if (error) {
    console.error('Error updating status:', error);
  }
  return data;
};

export { getProfile, getProfileWithAvatarUrl, updateProfile, downloadAvatar, uploadAvatar, updateUserStatus, getProfileByAuthUserId, getProfileWithAvatarUrlByAuthUserId };
