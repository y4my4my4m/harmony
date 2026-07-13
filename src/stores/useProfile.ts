import { defineStore } from 'pinia';
import type { Profile } from '@/types';
import { services, createLoadingState, setLoading, setSuccess, setError } from '@/services';
import type { ProfileData } from '@/services/ProfileService';
import { debug } from '@/utils/debug';

export const useProfileStore = defineStore('profile', {
  state: () => ({
    profile: null as Profile | null,
    profileFetched: false,
    loadingState: createLoadingState<Profile>(),
  }),
  getters: {
    isProfileComplete: (state) => services.profiles.isProfileComplete(state.profile),
    isLoading: (state) => state.loadingState.loading,
    error: (state) => state.loadingState.error,
    // App data is keyed on profiles.id, not the Supabase auth user id.
    // Reactive for templates/computed; imperative code uses authContextService.
    profileId: (state): string | undefined => state.profile?.id,
  },
  actions: {
    async fetchProfile(userId: string, useCache = true) {
      try {
        debug.log('Fetching profile via ProfileService:', userId);
        this.loadingState = setLoading(this.loadingState);
        
        const profile = await services.profiles.fetchProfile(userId, useCache);
        
        if (profile) {
          this.profile = profile;
          this.loadingState = setSuccess(this.loadingState, profile);
        } else {
          this.profile = null;
          this.loadingState = setSuccess(this.loadingState, null);
        }
        this.profileFetched = true;
        
        debug.log('Profile fetched via service layer');
      } catch (error: any) {
        debug.error('Error fetching profile via service:', error);
        this.profileFetched = true;
        this.loadingState = setError(this.loadingState, {
          code: error.code || 'FETCH_ERROR',
          message: error.message || 'Failed to fetch profile',
          details: error
        });
      }
    },

    async checkProfileCompletion(userId: string) {
      await this.fetchProfile(userId);
      if (!this.isProfileComplete) {
        throw new Error('Profile is not complete');
      }
    },

    async updateProfile(profileData: ProfileData) {
      try {
        debug.log('Updating profile via ProfileService:', profileData);
        this.loadingState = setLoading(this.loadingState);

        const updatedProfile = await services.profiles.updateProfile(profileData);
        
        this.profile = updatedProfile;
        this.loadingState = setSuccess(this.loadingState, updatedProfile);
        
        debug.log('Profile updated via service layer');
        return updatedProfile;
      } catch (error: any) {
        debug.error('Error updating profile via service:', error);
        this.loadingState = setError(this.loadingState, {
          code: error.code || 'UPDATE_ERROR', 
          message: error.message || 'Failed to update profile',
          details: error
        });
        throw error;
      }
    },

    async createProfile(profileData: Profile) {
      try {
        debug.log('Creating profile via ProfileService:', profileData.username);
        this.loadingState = setLoading(this.loadingState);

        const newProfile = await services.profiles.createProfile(profileData as any);
        
        this.profile = newProfile;
        this.loadingState = setSuccess(this.loadingState, newProfile);
        
        debug.log('Profile created via service layer');
        return newProfile;
      } catch (error: any) {
        debug.error('Error creating profile via service:', error);
        this.loadingState = setError(this.loadingState, {
          code: error.code || 'CREATE_ERROR',
          message: error.message || 'Failed to create profile', 
          details: error
        });
        throw error;
      }
    },

    async fetchProfileByAuthUserId(authUserId: string) {
      try {
        debug.log('Fetching profile by auth user ID via ProfileService:', authUserId);
        this.loadingState = setLoading(this.loadingState);

        const profile = await services.profiles.fetchProfileByAuthUserId(authUserId);
        
        this.profile = profile;
        this.loadingState = setSuccess(this.loadingState, profile);
        this.profileFetched = true;
        
        debug.log('Profile fetched by auth user ID via service layer');
      } catch (error: any) {
        debug.error('Error fetching profile by auth user ID via service:', error);
        this.profileFetched = true;
        this.loadingState = setError(this.loadingState, {
          code: error.code || 'FETCH_BY_AUTH_ERROR',
          message: error.message || 'Failed to fetch profile by auth user ID',
          details: error
        });
      }
    },

    clearError() {
      if (this.loadingState.error) {
        this.loadingState = {
          ...this.loadingState,
          error: null
        };
      }
    },

    clearProfile() {
      this.profile = null;
      this.profileFetched = false;
      this.loadingState = createLoadingState<Profile>();
    }
  },
});
