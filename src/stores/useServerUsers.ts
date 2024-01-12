import { defineStore } from 'pinia';
import { getProfilesWithAvatarUrls } from '@/services/usersService';
import type { User } from '@/types';

export const useServerUsersStore = defineStore('serverUsers', {
  state: () => ({
      userProfiles: {} as Record<string, User>,
  }),
  actions: {
      async fetchUserProfiles(userIds: string[]) {
          const profiles = await getProfilesWithAvatarUrls(userIds);

          this.userProfiles = profiles.reduce((acc, profile) => {
              if (profile) acc[profile.id] = profile;
              return acc;
          }, {} as Record<string, User>);
      }
  }
});