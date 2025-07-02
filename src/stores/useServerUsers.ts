import { defineStore } from 'pinia';
import { getProfilesWithAvatarUrls } from '@/services/usersService';
import { updateUserStatus } from '@/services/profileService';
import type { 
  User, 
  UserStatus,
  PresenceState,
  PresenceJoinPayload,
  PresenceLeavePayload,
  PresenceSubscriptionStatus,
  RealtimePresenceState,
  PresenceChannel
} from '@/types';
import { supabase } from '@/supabase';

const convertToStatusEnum = (numericStatus: number): UserStatus => {
    return numericStatus as UserStatus;
};
  
export const useServerUsersStore = defineStore('serverUsers', {
  state: () => ({
    userProfiles: {} as Record<string, User>,
    usersInVoiceChannels: {} as Record<string, string[]>,
    presenceChannel: null as PresenceChannel | null,
    onlineUsers: new Set<string>(),
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
      // Unsubscribe from existing subscription if any
      supabase.removeAllChannels();
      
      supabase.channel('user-statuses')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles' },
        (payload) => {
          const updatedUserId = payload.new.id;
          console.log('User status updated:', updatedUserId, payload.new.status);
          if (this.userProfiles[updatedUserId]) {
            this.userProfiles[updatedUserId] = {
              ...this.userProfiles[updatedUserId],
              status: convertToStatusEnum(payload.new.status as unknown as number)
            };
          }
        }
      )
      .subscribe((status: PresenceSubscriptionStatus) => {
        console.log('User status subscription status:', status);
      });
    },

    // Professional approach: Use Supabase Presence with proper TypeScript
    initializePresence(userId: string, userProfile: User) {
      // Remove old presence channel
      if (this.presenceChannel) {
        supabase.removeChannel(this.presenceChannel as any);
      }

      // Create presence channel with proper typing
      const channel = supabase.channel('online-users', {
        config: {
          presence: {
            key: userId,
          },
        },
      });

      // Track presence changes with proper TypeScript types
      channel
        .on('presence', { event: 'sync' }, () => {
          const presenceState = channel.presenceState() as RealtimePresenceState;
          this.updateOnlineUsers(presenceState);
        })
        .on('presence', { event: 'join' }, ({ key, newPresences }: PresenceJoinPayload) => {
          console.log('User joined:', key, newPresences);
          this.onlineUsers.add(key);
          this.setUserOnlineStatus(key, true);
        })
        .on('presence', { event: 'leave' }, ({ key, leftPresences }: PresenceLeavePayload) => {
          console.log('User left:', key, leftPresences);
          this.onlineUsers.delete(key);
          this.setUserOnlineStatus(key, false);
        })
        .subscribe(async (status: PresenceSubscriptionStatus) => {
          if (status === 'SUBSCRIBED') {
            // Track current user's presence with proper typing
            const presenceData: PresenceState = {
              user_id: userId,
              display_name: userProfile.display_name || 'Unknown User',
              avatar_url: userProfile.avatar_url,
              online_at: new Date().toISOString(),
            };
            
            await channel.track(presenceData);
          }
        });

      // Cast to our generic type to avoid exposing internal Supabase types
      this.presenceChannel = channel as PresenceChannel;
    },

    updateOnlineUsers(presenceState: RealtimePresenceState) {
      const onlineUserIds = Object.keys(presenceState);
      
      // Update online users set
      this.onlineUsers.clear();
      onlineUserIds.forEach((userId: string) => {
        this.onlineUsers.add(userId);
        this.setUserOnlineStatus(userId, true);
      });

      // Set offline users who are not in presence
      Object.keys(this.userProfiles).forEach((userId: string) => {
        if (!this.onlineUsers.has(userId)) {
          this.setUserOnlineStatus(userId, false);
        }
      });
    },

    setUserOnlineStatus(userId: string, isOnline: boolean) {
      if (this.userProfiles[userId]) {
        // Only update if it's actually changing the online/offline status
        const currentStatus = this.userProfiles[userId].status;
        const newStatus = isOnline ? UserStatus.Online : UserStatus.Offline;
        
        if ((isOnline && currentStatus === UserStatus.Offline) || 
            (!isOnline && currentStatus !== UserStatus.Offline)) {
          this.userProfiles[userId].status = newStatus;
        }
      }
    },

    cleanupPresence() {
      if (this.presenceChannel) {
        this.presenceChannel.untrack();
        supabase.removeChannel(this.presenceChannel as any);
        this.presenceChannel = null;
      }
      this.onlineUsers.clear();
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