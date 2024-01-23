import { defineStore } from 'pinia';
import { getProfilesWithAvatarUrls } from '@/services/usersService';
import { updateUserStatus } from '@/services/profileService';
import type { User } from '@/types';
import { UserStatus } from '@/types';
import { supabase } from '@/supabase';

const convertToStatusEnum = (numericStatus: number): UserStatus => {
    return numericStatus as UserStatus;
};
  
export const useServerUsersStore = defineStore('serverUsers', {
  state: () => ({
    userProfiles: {} as Record<string, User>,
  }),
  getters: {
    usernameToUserIdMap: (state) => {
      const map = {};
      for (const userId in state.userProfiles) {
        const profile = state.userProfiles[userId];
        if (profile && profile.username) {
          map[profile.username.toLowerCase()] = userId;
        }
      }
      return map;
    },
  },
  actions: {
    async fetchUserProfiles(userIds: string[]) {
        const profiles = await getProfilesWithAvatarUrls(userIds);
  
        this.userProfiles = profiles.reduce((acc, profile) => {
          if (profile) {
            acc[profile.id] = { 
              ...profile,
              status: convertToStatusEnum(profile.status as number)
            };
          }
          return acc;
        }, {} as Record<string, User>);
      },
      async setStatus(userId: string, status: UserStatus) {
        const numericStatus = status as number;
        const updatedUser = await updateUserStatus(userId, numericStatus);
        if (updatedUser) {
          this.userProfiles[userId].status = status;
        }
      },
      subscribeToUserStatuses() {
        supabase.channel('user-statuses')
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'profiles' },
            (payload) => {
              const updatedUserId = payload.new.id;
              if (this.userProfiles[updatedUserId]) {
                this.userProfiles[updatedUserId].status = convertToStatusEnum(payload.new.status as unknown as number);
              }
            }
          )
          .subscribe();
      }
      
  }
});