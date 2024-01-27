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
    usersInVoiceChannels: {} as Record<string, string[]>,
  }),
  getters: {
    usernameToUserIdMap: (state) => {
      const map: Record<string, string> = {};
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
    },
    broadcastVoiceChannelEvent(serverId: string, channelId: string, event: string, userId: string) {
      const channel = supabase.channel(`server-${serverId}`, {
        config: {
          broadcast: { self: true },
        },
      })

      channel.on('broadcast', { event: 'voice-channel-event' }, (payload) => {
        console.log(payload);
        const { event, userId } = payload.payload;

        if (event === 'user-joined') {
          // console.log(channel,event);
          if (!this.usersInVoiceChannels[channelId]) {
            this.usersInVoiceChannels[channelId] = [];
          }
          if (!this.usersInVoiceChannels[channelId].includes(userId)) {
            this.usersInVoiceChannels[channelId].push(userId);
          }
        } else if (event === 'user-left') {
          this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
        }
        console.log(this.usersInVoiceChannels[channelId]);
      })
      
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.send({
            type: 'broadcast',
            event: 'voice-channel-event',
            payload: { event, userId }
          });
        }
      })
    },
  }
});