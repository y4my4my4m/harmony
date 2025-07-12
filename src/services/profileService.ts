import { supabase } from '../supabase';
import type { User } from '@/types';

const getProfile = async (userId: string): Promise<User | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return data;
};

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

const updateProfile = async (userId: string, updates: Partial<User>): Promise<User | undefined> => {
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .match({ id: userId });

  if (error) throw error;
  
  // If the update was successful, broadcast profile changes via presence service
  if (data && data[0]) {
    try {
      // Import dynamically to avoid circular dependencies
      const { globalPresenceService } = await import('./globalPresenceService')
      
      // Extract profile data that should be broadcast
      const profileData: any = {}
      if (updates.username !== undefined) profileData.username = updates.username
      if (updates.display_name !== undefined) profileData.displayName = updates.display_name
      if (updates.avatar_url !== undefined) profileData.avatarUrl = updates.avatar_url
      
      // Handle Profile-specific fields safely
      const profileUpdates = updates as any
      if (profileUpdates.bio !== undefined) profileData.bio = profileUpdates.bio
      if (profileUpdates.color !== undefined) profileData.color = profileUpdates.color
      if (profileUpdates.verified !== undefined) profileData.verified = profileUpdates.verified
      
      // Only broadcast if there are profile changes to broadcast
      if (Object.keys(profileData).length > 0) {
        await globalPresenceService.updateUserProfile(userId, profileData)
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

export { getProfile, getProfileWithAvatarUrl, updateProfile, downloadAvatar, uploadAvatar, updateUserStatus };
