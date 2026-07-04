import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { User } from '@/types';
import { UserStatus } from '@/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { updateUserStatus } from '@/services/ProfileService';
import { userDataService } from '@/services/userDataService';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { debug } from '@/utils/debug'
  
export const useServerUsersStore = defineStore('serverUsers', {
  state: () => ({
    userProfiles: {} as Record<string, User>,
    usersInVoiceChannels: {} as Record<string, string[]>,
    voiceChannelCallStartTimes: {} as Record<string, Date>,
    presenceChannel: null as RealtimeChannel | null,
    voiceChannelBroadcast: null as RealtimeChannel | null,
    onlineUsers: new Set<string>(),
    offlineBroadcastChannel: null as RealtimeChannel | null,
    currentServerId: null as string | null,
    membershipSubscriptionActive: false,
  }),
  getters: {
    usernameToUserIdMap: () => {
      const map: Record<string, string> = {};
      const allUsers = userDataService.getAllUsers();
      
      for (const userData of allUsers) {
        if (userData && userData.username) {
          map[userData.username.toLowerCase()] = userData.id;
          
          if (!userData.isLocal && userData.domain) {
            map[`${userData.username}@${userData.domain}`.toLowerCase()] = userData.id;
          }
        }
      }
      return map;
    },
    
    isServerMember: (state) => (userId: string): boolean => {
      return userId in state.userProfiles;
    },
    
    getUserProfile: () => (userId: string): User | null => {
      return userDataService.getUserProfile(userId);
    },
    
    getCacheStats: () => {
      const allUsers = userDataService.getAllUsers();
      return {
        totalCached: allUsers.length,
        mainProfiles: allUsers.length,
        pendingFetches: 0,
        hitRate: 1,
      };
    },
  },
  actions: {
    initializeUserDataIntegration() {
      debug.log('🔗 UserDataService is now the single source of truth for user data')
      debug.log('✅ UserDataService integration initialized')
    },

    async fetchUserProfile(userId: string, forceRefresh = false): Promise<User | null> {
      try {
        return await userDataService.fetchUserProfile(userId, forceRefresh);
      } catch (error) {
        debug.error(`Error fetching profile for user ${userId}:`, error);
        return null;
      }
    },

    async fetchMultipleUserProfiles(userIds: string[], forceRefresh = false): Promise<Record<string, User>> {
      try {
        return await userDataService.fetchMultipleUserProfiles(userIds, forceRefresh);
      } catch (error) {
        debug.error('Error batch fetching profiles:', error);
        return {};
      }
    },

    async ensureProfilesAvailable(userIds: string[]): Promise<void> {
      try {
        await userDataService.ensureUsersLoaded(userIds);
      } catch (error) {
        debug.error('Error ensuring profiles are available:', error);
      }
    },

    async fetchUserProfiles(userIds: string[]) {
      await userDataService.ensureUsersLoaded(userIds);
      
      this.userProfiles = {};
      userIds.forEach(userId => {
        const userProfile = userDataService.getUserProfile(userId);
        if (userProfile) {
          this.userProfiles[userId] = userProfile;
        }
      });
    },

    async setStatus(userId: string, status: UserStatus) {
      const currentUser = userDataService.getCurrentUser();
      if (currentUser && currentUser.id === userId) {
        await userDataService.updateCurrentUserStatus(status, true);
      } else {
        const numericStatus = status as number;
        const updatedUser = await updateUserStatus(userId, numericStatus);
        if (updatedUser) {
          if (this.userProfiles[userId]) {
            this.userProfiles[userId].status = status;
          }
        }
      }
    },


    async updatePresence(status: 'online' | 'offline') {
      if (this.presenceChannel) {
        if (status === 'online') {
          await this.presenceChannel.track({
            online_at: new Date().toISOString(),
          });
        } else {
          await this.presenceChannel.untrack();
        }
      }
    },

    updateOnlineUsers(presenceState: Record<string, any>) {
      debug.log('📊 Updating online users from presence:', presenceState);
      
      const onlineUserIds = new Set<string>();
      
      Object.values(presenceState).forEach((presences: any) => {
        presences.forEach((presence: any) => {
          if (presence.user_id) {
            onlineUserIds.add(presence.user_id);
          }
        });
      });
      
      debug.log('👥 Online user IDs:', Array.from(onlineUserIds));
      
      const previouslyOnlineUsers = Array.from(this.onlineUsers);
      previouslyOnlineUsers.forEach((userId: string) => {
        if (!onlineUserIds.has(userId)) {
          debug.log('🔴 User went offline:', userId);
          this.setUserOnlineStatus(userId, false);
        }
      });
      
      this.onlineUsers.clear();
      onlineUserIds.forEach((userId: string) => {
        this.onlineUsers.add(userId);
        this.setUserOnlineStatus(userId, true);
      });
      
      debug.log('✅ Online users updated:', this.onlineUsers.size, 'online');
    },

    setUserOnlineStatus(userId: string, isOnline: boolean) {
      const userData = userDataService.getUser(userId);
      if (userData) {
        // Only update isOnline; don't override Away/Busy with auto-Online.
        userData.isOnline = isOnline;
        userData.lastSeen = new Date().toISOString();
        
        if (!isOnline && userData.status === UserStatus.Online) {
          userData.status = UserStatus.Offline;
        }
      }
      
      if (this.userProfiles[userId]) {
        const currentStatus = this.userProfiles[userId].status;
        
        if (!isOnline && currentStatus === UserStatus.Online) {
          this.userProfiles[userId].status = UserStatus.Offline;
        }
      }
    },

    async initializeMembershipTracking(serverId: string) {
      try {
        if (this.currentServerId !== serverId) {
          debug.log(`🔄 Initializing membership tracking for server: ${serverId}`)

          this.cleanupMembershipTracking()

          this.currentServerId = serverId
          this.membershipSubscriptionActive = true

          debug.log(`✅ Membership tracking initialized for server: ${serverId}`)
        }
      } catch (error) {
        debug.error('❌ Failed to initialize membership tracking:', error)
      }
    },

    cleanupMembershipTracking() {
      if (this.currentServerId && this.membershipSubscriptionActive) {
        debug.log(`🧹 Cleaning up membership tracking for server: ${this.currentServerId}`)
        this.membershipSubscriptionActive = false
      }
    },

    cleanup() {
      this.cleanupMembershipTracking()

      if (this.presenceChannel) {
        this.presenceChannel.unsubscribe()
        this.presenceChannel = null
      }
      if (this.voiceChannelBroadcast) {
        this.voiceChannelBroadcast.unsubscribe()
        this.voiceChannelBroadcast = null
      }
      if (this.offlineBroadcastChannel) {
        this.offlineBroadcastChannel.unsubscribe()
        this.offlineBroadcastChannel = null
      }

      // BUGS.md Pattern B: also drop cached user state. Leaving profiles /
      // voice membership / presence populated leaked the previous account's
      // data into the next session on a shared device.
      this.userProfiles = {}
      this.usersInVoiceChannels = {}
      this.voiceChannelCallStartTimes = {}
      this.onlineUsers.clear()

      this.currentServerId = null
    },

    async setupVoiceChannelBroadcast(serverId: string) {
      if (this.voiceChannelBroadcast) {
        await this.voiceChannelBroadcast.unsubscribe();
      }

      debug.log('🎙️ Setting up voice channel broadcast for server:', serverId);

      // Voice channel state is ephemeral (broadcast-only, no DB table for initial state).
      this.voiceChannelBroadcast = supabase.channel(`voice-channels:${serverId}`, {
        config: {
          broadcast: { self: true },
        },
      });

      this.voiceChannelBroadcast.on('broadcast', { event: 'voice-channel-event' }, async (payload) => {
        debug.log('🎙️ Received voice channel event:', payload);
        const { event, userId, channelId, callStartTime, federated } = payload.payload;

        if (event === 'user-joined') {
          if (!this.usersInVoiceChannels[channelId]) {
            this.usersInVoiceChannels[channelId] = [];
          }
          if (!this.usersInVoiceChannels[channelId].includes(userId)) {
            this.usersInVoiceChannels[channelId].push(userId);
          }
          
          if (callStartTime && !this.voiceChannelCallStartTimes[channelId]) {
            this.voiceChannelCallStartTimes[channelId] = new Date(callStartTime);
            debug.log(`🕐 Set call start time for channel ${channelId}:`, this.voiceChannelCallStartTimes[channelId]);
          }
          
          if (federated && userId) {
            debug.log(`🌐 Loading profile for federated voice user: ${userId}`);
            userDataService.ensureUsersLoaded([userId]).catch((err) => {
              debug.warn('Failed to load federated user profile:', err);
            });
          }
          
          debug.log(`✅ User ${userId} joined voice channel ${channelId}. Total: ${this.usersInVoiceChannels[channelId].length}`);
        } else if (event === 'user-left') {
          if (this.usersInVoiceChannels[channelId]) {
            this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
            debug.log(`✅ User ${userId} left voice channel ${channelId}. Total: ${this.usersInVoiceChannels[channelId].length}`);
            
            if (this.usersInVoiceChannels[channelId].length === 0) {
              delete this.voiceChannelCallStartTimes[channelId];
              debug.log(`🕐 Cleared call start time for channel ${channelId} (empty)`);
            }
          }
        } else if (event === 'call-start-time-sync') {
          if (callStartTime) {
            this.voiceChannelCallStartTimes[channelId] = new Date(callStartTime);
            debug.log(`🕐 Synced call start time for channel ${channelId}:`, this.voiceChannelCallStartTimes[channelId]);
          }
        } else if (event === 'request-state') {
          const voiceStore = useUnifiedVoiceChannelStore();
          if (voiceStore.isConnected && voiceStore.currentChannelId) {
            debug.log('📡 Responding to state request with our voice channel presence');
            this.broadcastVoiceChannelEvent(
              serverId,
              voiceStore.currentChannelId,
              'user-joined',
              voiceStore.localState.userId,
              voiceStore.callStartTime?.toISOString()
            );
          }
        }
      });

      await this.voiceChannelBroadcast.subscribe();
      debug.log('✅ Voice channel broadcast subscribed for server:', serverId);
      
      this.broadcastVoiceChannelEvent(serverId, '', 'request-state', '');
      debug.log('📡 Requested current voice channel state from active users');
    },

    async fetchVoiceChannelState(serverId: string) {
      try {
        debug.log('📞 Fetching voice channel state for server:', serverId);
        // DM voice calls don't use voice_channel_participants (non-UUID IDs)
        if (serverId === 'dm') {
          debug.log('📞 Skipping DB fetch for DM voice state');
          return;
        }
        
        const channelUsers: Record<string, string[]> = {};
        
        const { data: participantsData, error: participantsError } = await supabase
          .from('voice_channel_participants')
          .select('user_id, channel_id')
          .eq('server_id', serverId);

        if (!participantsError && participantsData) {
          for (const participant of participantsData) {
            if (participant.channel_id) {
              if (!channelUsers[participant.channel_id]) {
                channelUsers[participant.channel_id] = [];
              }
              if (!channelUsers[participant.channel_id].includes(participant.user_id)) {
                channelUsers[participant.channel_id].push(participant.user_id);
              }
            }
          }
        }

        this.usersInVoiceChannels = { ...channelUsers };
        
        debug.log('✅ Fetched voice channel state:', this.usersInVoiceChannels);
        debug.log('📊 Channels with users:', Object.keys(this.usersInVoiceChannels).length);
      } catch (error) {
        debug.error('Error fetching voice channel state:', error);
      }
    },

    broadcastVoiceChannelEvent(serverId: string, channelId: string, event: string, userId: string, callStartTime?: string) {
      if (!this.voiceChannelBroadcast) {
        debug.error('❌ Voice channel broadcast not initialized');
        return;
      }

      this.voiceChannelBroadcast.send({
        type: 'broadcast',
        event: 'voice-channel-event',
        payload: { event, userId, channelId, callStartTime }
      });
      
      debug.log(`📡 Broadcasted ${event} for user ${userId} in channel ${channelId}`, callStartTime ? `with start time ${callStartTime}` : '');
    },

    getUsersInVoiceChannel(channelId: string): string[] {
      return this.usersInVoiceChannels[channelId] || [];
    },

    getCallStartTime(channelId: string): Date | null {
      return this.voiceChannelCallStartTimes[channelId] || null;
    },

    async joinVoiceChannel(serverId: string, channelId: string, userId: string, isLocalServer: boolean = true) {
      try {
        const isFirstUser = !this.usersInVoiceChannels[channelId] || this.usersInVoiceChannels[channelId].length === 0;
        
        if (!this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = [];
        }
        if (!this.usersInVoiceChannels[channelId].includes(userId)) {
          this.usersInVoiceChannels[channelId].push(userId);
        }

        let callStartTime: string | undefined;
        if (isFirstUser) {
          this.voiceChannelCallStartTimes[channelId] = new Date();
          callStartTime = this.voiceChannelCallStartTimes[channelId].toISOString();
          debug.log(`🕐 First user - setting call start time for channel ${channelId}`);
        } else {
          callStartTime = this.voiceChannelCallStartTimes[channelId]?.toISOString();
        }

        // DM/federated calls use non-UUID IDs; only local server channels write to voice_channel_participants.
        const isDMCall = serverId === 'dm' || channelId.startsWith('dm-') || channelId.startsWith('federated-dm-');
        if (isLocalServer && !isDMCall) {
          supabase
            .from('voice_channel_participants')
            .upsert({
              channel_id: channelId,
              server_id: serverId,
              user_id: userId,
              joined_at: new Date().toISOString(),
              is_federated: false,
            }, { onConflict: 'channel_id,user_id' })
            .then(({ error }) => {
              if (error) {
                debug.warn('Failed to write to voice_channel_participants:', error.message);
              } else {
                debug.log('✅ Wrote to voice_channel_participants');
              }
            });
        } else if (isDMCall) {
          debug.log('📞 DM voice call - skipping voice_channel_participants DB write');
        } else {
          debug.log('📡 Federated voice channel - skipping local DB write');
        }

        this.broadcastVoiceChannelEvent(serverId, channelId, 'user-joined', userId, callStartTime);
        
        debug.log(`User ${userId} joined voice channel ${channelId}`);
        return true;
      } catch (error) {
        debug.error('Error joining voice channel:', error);
        return false;
      }
    },

    async leaveVoiceChannel(serverId: string, channelId: string, userId: string, isLocalServer: boolean = true) {
      try {
        if (this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
          
          if (this.usersInVoiceChannels[channelId].length === 0) {
            delete this.voiceChannelCallStartTimes[channelId];
            debug.log(`🕐 Cleared call start time for channel ${channelId}`);
          }
        }

        const isDMCall = serverId === 'dm' || channelId.startsWith('dm-') || channelId.startsWith('federated-dm-');
        if (isLocalServer && !isDMCall) {
          supabase
            .from('voice_channel_participants')
            .delete()
            .eq('channel_id', channelId)
            .eq('user_id', userId)
            .then(({ error }) => {
              if (error) {
                debug.warn('Failed to delete from voice_channel_participants:', error.message);
              } else {
                debug.log('✅ Removed from voice_channel_participants');
              }
            });
        } else if (isDMCall) {
          debug.log('📞 DM voice call - skipping voice_channel_participants DB delete');
        } else {
          debug.log('📡 Federated voice channel - skipping local DB delete');
        }

        this.broadcastVoiceChannelEvent(serverId, channelId, 'user-left', userId);
        
        debug.log(`User ${userId} left voice channel ${channelId}`);
        return true;
      } catch (error) {
        debug.error('Error leaving voice channel:', error);
        return false;
      }
    },

    isUserInVoiceChannel(userId: string, channelId: string): boolean {
      return this.usersInVoiceChannels[channelId]?.includes(userId) || false;
    },

    async leaveAllVoiceChannels(serverId: string, userId: string) {
      const channelsToLeave = Object.keys(this.usersInVoiceChannels).filter(channelId => 
        this.usersInVoiceChannels[channelId].includes(userId)
      );

      for (const channelId of channelsToLeave) {
        await this.leaveVoiceChannel(serverId, channelId, userId);
      }
    },

    /**
     * Clean up a disconnected user from voice channel state (crash/network loss).
     */
    cleanupDisconnectedUser(serverId: string, channelId: string, userId: string) {
      debug.log(`🧹 Cleaning up disconnected user ${userId} from channel ${channelId}`);
      
      if (this.usersInVoiceChannels[channelId]) {
        this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
        
        if (this.usersInVoiceChannels[channelId].length === 0) {
          delete this.voiceChannelCallStartTimes[channelId];
        }
      }

      const isDMCall = channelId.startsWith('dm-') || channelId.startsWith('federated-dm-');
      if (!isDMCall) {
        supabase
          .from('voice_channel_participants')
          .delete()
          .eq('channel_id', channelId)
          .eq('user_id', userId)
          .then(({ error }) => {
            if (error) {
              debug.warn('Failed to cleanup voice_channel_participants:', error.message);
            } else {
              debug.log('✅ Cleaned up disconnected user from voice_channel_participants');
            }
          });
      }

      this.broadcastVoiceChannelEvent(serverId, channelId, 'user-left', userId);
    },
  }
});