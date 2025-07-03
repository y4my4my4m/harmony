// src/stores/useProfileStore.ts
import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Profile } from '@/types'; // Assuming you have a Profile type defined

export const useProfileStore = defineStore('profile', {
  state: () => ({
    profile: null as Profile | null,
  }),
  getters: {
    isProfileComplete: (state) => state.profile !== null
  },
  actions: {
    async fetchProfile(userId: string) {
      try {
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
          .single();

        if (error) throw error;

        this.profile = data;
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
        return data;
      } catch (error) {
        console.error('Error creating profile:', error);
        throw error; // Re-throw to allow proper error handling in components
      }
    }
  },
});
