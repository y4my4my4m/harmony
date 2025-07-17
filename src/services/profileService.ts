import { supabase } from '../supabase';
import type { User } from '@/types';
import { getPublicBannerUrl } from '@/utils/bannerUtils';

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
  if (!profile) return profile;

  // Get signed avatar URL if avatar exists
  if (profile.avatar_url) {
    try {
      const { data, error } = await supabase.storage
        .from('avatars')
        .createSignedUrl(profile.avatar_url, 60); // 60 seconds validity for the URL

      if (error) throw error;
      profile.avatar_url = data.signedUrl;
    } catch (error) {
      console.error('Error getting signed avatar URL:', error);
    }
  }

  // Get public banner URL if banner exists (for federation compatibility)
  if (profile.banner_url) {
    const bannerUrl = getPublicBannerUrl(profile.banner_url, { width: 1280, height: 720, quality: 80 });
    if (bannerUrl) {
      profile.banner_url = bannerUrl;
    }
  }

  return profile;
};

// Get profile with avatar URL by auth user ID (for authenticated users)
const getProfileWithAvatarUrlByAuthUserId = async (authUserId: string): Promise<User | null> => {
  const profile = await getProfileByAuthUserId(authUserId);
  if (!profile) return profile;

  // Get signed avatar URL if avatar exists
  if (profile.avatar_url) {
    try {
      const { data, error } = await supabase.storage
        .from('avatars')
        .createSignedUrl(profile.avatar_url, 60); // 60 seconds validity for the URL

      if (error) throw error;
      profile.avatar_url = data.signedUrl;
    } catch (error) {
      console.error('Error getting signed avatar URL:', error);
    }
  }

  // Get public banner URL if banner exists (for federation compatibility)
  if (profile.banner_url) {
    const bannerUrl = getPublicBannerUrl(profile.banner_url, { width: 1280, height: 720, quality: 80 });
    if (bannerUrl) {
      profile.banner_url = bannerUrl;
    }
  }

  return profile;
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
      if (updates.banner_url !== undefined) profileData.bannerUrl = updates.banner_url
      
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
  const ext = file.name.split('.').pop();
  if (!ext) throw new Error('File must have an extension');
  const filePath = `${userId}/${userId}.${ext}`;
  const { error } = await supabase.storage.from('avatars').upload(filePath, file, {
    upsert: true
  });

  if (error) throw error;
  return filePath;
};

const uploadBanner = async (userId: string, file: File): Promise<string> => {
  const ext = file.name.split('.').pop();
  if (!ext) throw new Error('File must have an extension');
  const filePath = `${userId}/${userId}_banner.${ext}`;
  const { error } = await supabase.storage.from('banners').upload(filePath, file, {
    upsert: true
  });

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

export { getProfile, getProfileWithAvatarUrl, updateProfile, downloadAvatar, uploadAvatar, uploadBanner, updateUserStatus, getProfileByAuthUserId, getProfileWithAvatarUrlByAuthUserId };
