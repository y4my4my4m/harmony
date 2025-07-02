import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { User } from '@/types';
import { UserStatus } from '@/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { getProfilesWithAvatarUrls } from '@/services/usersService';
import { updateUserStatus } from '@/services/profileService';

const convertToStatusEnum = (numericStatus: number): UserStatus => {
    return numericStatus as UserStatus;
};
  
export const useServerUsersStore = defineStore('serverUsers', {
  state: () => ({
    userProfiles: {} as Record<string, User>,
    usersInVoiceChannels: {} as Record<string, string[]>,
    presenceChannel: null as RealtimeChannel | null,
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
      .subscribe((status: string) => {
        console.log('User status subscription status:', status);
      });
    },

    // Professional approach: Use Supabase Presence with proper TypeScript
    async initializePresence(serverId: string, userId: string, username: string, avatar?: string) {
      // Remove old presence channel
      if (this.presenceChannel) {
        await this.presenceChannel.unsubscribe();
        this.presenceChannel = null;
      }

      // Create presence channel
      this.presenceChannel = supabase
        .channel(`server:${serverId}:presence`)
        .on('presence', { event: 'sync' }, () => {
          const presenceState = this.presenceChannel?.presenceState();
          this.updateOnlineUsers(presenceState);
        })
        .on('presence', { event: 'join' }, ({ key, newPresences }) => {
          console.log('User joined:', key, newPresences);
          this.onlineUsers.add(key);
          this.setUserOnlineStatus(key, true);
        })
        .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
          console.log('User left:', key, leftPresences);
          this.onlineUsers.delete(key);
          this.setUserOnlineStatus(key, false);
        })
        .subscribe(async (status: string) => {
          if (status === 'SUBSCRIBED') {
            // Track current user's presence
            const presenceData = {
              user_id: userId,
              display_name: username || 'Unknown User',
              avatar_url: avatar,
              online_at: new Date().toISOString(),
            };
            
            await this.presenceChannel?.track(presenceData);
          }
        });

      // Store cleanup function globally for immediate access during beforeunload
      (window as any).__harmonyPresenceCleanup = () => {
        console.log('Immediate presence cleanup triggered');
        if (this.presenceChannel) {
          // Immediate untrack and cleanup
          this.presenceChannel.untrack();
          // Force offline status update in local state
          this.setUserOnlineStatus(userId, false);
          // Broadcast offline status to other users immediately
          this.broadcastOfflineStatus(userId);
        }
      };
    },

    async updatePresence(status: 'online' | 'offline') {
      if (this.presenceChannel) {
        const presenceData = {
          user_id: this.presenceChannel.config.presence.key,
          online_at: new Date().toISOString(),
        };
        
        if (status === 'online') {
          await this.presenceChannel.track(presenceData);
        } else {
          await this.presenceChannel.untrack();
        }
      }
    },

    // New method to immediately broadcast offline status
    broadcastOfflineStatus(userId: string) {
      try {
        // Create a temporary broadcast channel for immediate offline notification
        const offlineChannel = supabase.channel(`offline-${userId}-${Date.now()}`, {
          config: {
            broadcast: { self: false }, // Don't broadcast to self
          },
        });

        offlineChannel.subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            // Broadcast immediate offline status
            offlineChannel.send({
              type: 'broadcast',
              event: 'user-offline',
              payload: { 
                user_id: userId, 
                timestamp: new Date().toISOString() 
              }
            });
            
            // Clean up the temporary channel after a short delay
            setTimeout(() => {
              supabase.removeChannel(offlineChannel);
            }, 1000);
          }
        });
      } catch (error) {
        console.error('Error broadcasting offline status:', error);
      }
    },

    // Listen for immediate offline broadcasts from other users
    subscribeToOfflineBroadcasts() {
      const offlineChannel = supabase.channel('global-offline-status', {
        config: {
          broadcast: { self: false },
        },
      });

      offlineChannel
        .on('broadcast', { event: 'user-offline' }, (payload) => {
          const { user_id } = payload.payload;
          console.log('Received immediate offline broadcast for user:', user_id);
          this.setUserOnlineStatus(user_id, false);
        })
        .subscribe();
    },

    updateOnlineUsers(presenceState: Record<string, any>) {
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

    cleanup() {
      if (this.presenceChannel) {
        supabase.removeChannel(this.presenceChannel)
        this.presenceChannel = null
      }
      if (this.offlineBroadcastChannel) {
        supabase.removeChannel(this.offlineBroadcastChannel)
        this.offlineBroadcastChannel = null
      }
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