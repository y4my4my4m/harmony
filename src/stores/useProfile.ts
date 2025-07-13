// src/stores/useProfileStore.ts
import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Profile } from '@/types'; // Assuming you have a Profile type defined
import { userDataService } from '@/services/userDataService';

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
          const cachedProfile = userDataService.getUserProfile(userId);
          if (cachedProfile && cachedProfile.username && cachedProfile.displayName) {
            console.log('Using cached profile for current user');
            // Convert UserData to Profile format
            this.profile = {
              id: cachedProfile.id,
              username: cachedProfile.username,
              display_name: cachedProfile.displayName,
              avatar_url: cachedProfile.avatarUrl,
              status: cachedProfile.status,
              color: cachedProfile.color,
              bio: cachedProfile.bio,
              domain: cachedProfile.domain,
              updated_at: cachedProfile.updatedAt,
              created_at: cachedProfile.createdAt,
              is_local: cachedProfile.isLocal
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

        // Note: userDataService handles its own caching automatically
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
          // userDataService will handle its own cache invalidation automatically
          console.log('Profile updated for user:', data.id);
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
          // userDataService will automatically handle caching when the user is loaded
          console.log('Profile created for user:', this.profile.id);
        }

        return data;
      } catch (error) {
        console.error('Error creating profile:', error);
        throw error; // Re-throw to allow proper error handling in components
      }
    },
    async fetchProfileByAuthUserId(authUserId: string) {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('auth_user_id', authUserId)
          .single();

        if (error && error.code !== 'PGRST100' /* Row not found error code */) {
          throw error;
        }

        // If profile data is found, set it, else keep it null
        this.profile = data ? data : null;
      } catch (error) {
        console.error('Error fetching profile by auth user ID:', error);
        // Handle error appropriately
      }
    },
  },
});
