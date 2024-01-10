import { supabase } from '../supabase';
import type { Profile } from '@/types';

const getProfile = async (userId: string): Promise<Profile | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return data;
};

const getProfileWithAvatarUrl = async (userId: string): Promise<Profile | null> => {
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

const updateProfile = async (userId: string, updates: Partial<Profile>): Promise<Profile | undefined> => {
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .match({ id: userId });

  if (error) throw error;
  return data ? data[0] : undefined;
};

const downloadAvatar = async (avatarPath: string): Promise<string> => {
  const { data, error } = await supabase.storage.from('avatars').download(avatarPath);
  if (error) throw error;

  const url = URL.createObjectURL(data);
  return url;
};

const uploadAvatar = async (userId: string, file: File): Promise<string> => {
  const filePath = `avatars/${userId}/${file.name}`;
  const { error } = await supabase.storage.from('avatars').upload(filePath, file);

  if (error) throw error;
  return filePath;
};

export { getProfile, getProfileWithAvatarUrl, updateProfile, downloadAvatar, uploadAvatar };
