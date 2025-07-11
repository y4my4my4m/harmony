// src/stores/useProfileStore.ts
import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Profile } from '@/types'; // Assuming you have a Profile type defined
import { useServerUsersStore } from '@/stores/useServerUsers';

export const useProfileStore = defineStore('profile', {
  state: () => ({
    profile: null as Profile | null,
  }),
  getters: {
    isProfileComplete: (state) => state.profile !== null
  },
  actions: {
    async fetchProfile(userId: string, useCache = true) {
      try {
        // If cache is enabled, try to get from the user cache first
        if (useCache) {
          const serverUsersStore = useServerUsersStore();
          const cachedProfile = serverUsersStore.getUserProfile(userId);
          if (cachedProfile && cachedProfile.username && cachedProfile.display_name) {
            console.log('Using cached profile for current user');
            // Convert User to Profile format
            this.profile = {
              id: cachedProfile.id,
              username: cachedProfile.username,
              display_name: cachedProfile.display_name,
              avatar_url: cachedProfile.avatar_url,
              status: cachedProfile.status,
              color: (cachedProfile as any).color,
              bio: (cachedProfile as any).bio,
            };
            return;
          }
        }

        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .single();

        if (error && error.code !== 'PGRST100' /* Row not found error code */) {
          throw error;
        }

        // If profile data is found, set it, else keep it null
        this.profile = data ? data : null;

        // Add to cache if we have the profile
        if (this.profile && useCache) {
          const serverUsersStore = useServerUsersStore();
          // Convert Profile to User format for caching
          const userForCache: any = {
            id: this.profile.id,
            username: this.profile.username,
            display_name: this.profile.display_name,
            avatar_url: this.profile.avatar_url,
            status: this.profile.status || 0, // Default to Offline if no status
            color: this.profile.color,
            bio: this.profile.bio,
          };
          serverUsersStore.addToProfileCache(userForCache);
        }
      } catch (error) {
        console.error('Error fetching profile:', error);
        // Handle error appropriately
      }
    },
    async checkProfileCompletion(userId: string) {
      const profileStore = useProfileStore();
      await profileStore.fetchProfile(userId);
      if (!profileStore.isProfileComplete) {
        throw Error;
      }
    },
    async updateProfile(profileData: Profile) {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .update(profileData)
          .eq('id', this.profile?.id)
          .select()
          .single();

        if (error) throw error;

        this.profile = data as Profile;

        // Invalidate cache since profile was updated
        if (data?.id) {
          const serverUsersStore = useServerUsersStore();
          serverUsersStore.invalidateUserProfileCache(data.id);
          // Add updated profile to cache
          const userForCache: any = {
            id: data.id,
            username: data.username,
            display_name: data.display_name,
            avatar_url: data.avatar_url,
            status: data.status || 0, // Default to Offline if no status
            color: data.color,
            bio: data.bio,
          };
          serverUsersStore.addToProfileCache(userForCache);
        }
      } catch (error) {
        console.error('Error updating profile:', error);
        throw error; // Re-throw to allow proper error handling in components
      }
    },
    async createProfile(profileData: Profile) {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .insert([profileData])
          .select()
          .single();

        if (error) {
          console.error('Supabase error creating profile:', error);
          throw error;
        }

        this.profile = data;

        // Add new profile to cache
        if (this.profile) {
          const serverUsersStore = useServerUsersStore();
          const userForCache: any = {
            id: this.profile.id,
            username: this.profile.username,
            display_name: this.profile.display_name,
            avatar_url: this.profile.avatar_url,
            status: this.profile.status || 0, // Default to Offline if no status
            color: this.profile.color,
            bio: this.profile.bio,
          };
          serverUsersStore.addToProfileCache(userForCache);
        }

        return data;
      } catch (error) {
        console.error('Error creating profile:', error);
        throw error; // Re-throw to allow proper error handling in components
      }
    }
  },
});
