import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { User } from '@/types';
import { UserStatus } from '@/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { updateUserStatus } from '@/services/ProfileService';
// membershipService CDC subscription removed - membership events now
// flow through the server-structure broadcast channel
import { userDataService } from '@/services/userDataService';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { debug } from '@/utils/debug'
  
export const useServerUsersStore = defineStore('serverUsers', {
  state: () => ({
    userProfiles: {} as Record<string, User>,
    usersInVoiceChannels: {} as Record<string, string[]>,
    voiceChannelCallStartTimes: {} as Record<string, Date>, // Track call start time per channel
    presenceChannel: null as RealtimeChannel | null,
    voiceChannelBroadcast: null as RealtimeChannel | null, // Persistent channel for voice events
    onlineUsers: new Set<string>(),
    offlineBroadcastChannel: null as RealtimeChannel | null,
    currentServerId: null as string | null, // Track current server for membership events
    membershipSubscriptionActive: false,
  }),
  getters: {
    usernameToUserIdMap: () => {
      const map: Record<string, string> = {};
      
      // Get users from userDataService (single source of truth)
      const allUsers = userDataService.getAllUsers();
      
      for (const userData of allUsers) {
        if (userData && userData.username) {
          // Always add local username mapping (just username)
          map[userData.username.toLowerCase()] = userData.id;
          
          // Add full handle mapping for remote users (username@domain)
          if (!userData.isLocal && userData.domain) {
            map[`${userData.username}@${userData.domain}`.toLowerCase()] = userData.id;
          }
        }
      }
      return map;
    },
    
    // Check if a user is a member of the current server
    isServerMember: (state) => (userId: string): boolean => {
      return userId in state.userProfiles;
    },
    
    // Get user profile - delegate to userDataService
    getUserProfile: () => (userId: string): User | null => {
      // Use userDataService's getUserProfile which already returns User format
      return userDataService.getUserProfile(userId);
    },
    
    // Get cache statistics - now from userDataService
    getCacheStats: () => {
      const allUsers = userDataService.getAllUsers();
      return {
        totalCached: allUsers.length,
        mainProfiles: allUsers.length,
        pendingFetches: 0, // No longer tracked locally
        hitRate: 1, // userDataService handles this internally
      };
    },
  },
  actions: {
    /**
     * Initialize integration with userDataService for single source of truth
     * This is now simplified since userDataService IS the source of truth
     */
    initializeUserDataIntegration() {
      debug.log('🔗 UserDataService is now the single source of truth for user data')
      debug.log('✅ UserDataService integration initialized')
    },

    // Fetch individual user profile with caching - delegate to userDataService
    async fetchUserProfile(userId: string, forceRefresh = false): Promise<User | null> {
      try {
        return await userDataService.fetchUserProfile(userId, forceRefresh);
      } catch (error) {
        debug.error(`Error fetching profile for user ${userId}:`, error);
        return null;
      }
    },

    // Batch fetch multiple profiles efficiently - delegate to userDataService
    async fetchMultipleUserProfiles(userIds: string[], forceRefresh = false): Promise<Record<string, User>> {
      try {
        return await userDataService.fetchMultipleUserProfiles(userIds, forceRefresh);
      } catch (error) {
        debug.error('Error batch fetching profiles:', error);
        return {};
      }
    },

    // Optimized profile fetching for message displays - delegate to userDataService
    async ensureProfilesAvailable(userIds: string[]): Promise<void> {
      try {
        await userDataService.ensureUsersLoaded(userIds);
      } catch (error) {
        debug.error('Error ensuring profiles are available:', error);
      }
    },

    // REMOVED: Cache management is now handled by userDataService

    async fetchUserProfiles(userIds: string[]) {
      // Delegate to userDataService for data loading
      await userDataService.ensureUsersLoaded(userIds);
      
      // Update local userProfiles for server members only (for backwards compatibility)
      this.userProfiles = {};
      userIds.forEach(userId => {
        const userProfile = userDataService.getUserProfile(userId);
        if (userProfile) {
          this.userProfiles[userId] = userProfile;
        }
      });
    },

    async setStatus(userId: string, status: UserStatus) {
      // If updating current user, use userDataService
      const currentUser = userDataService.getCurrentUser();
      if (currentUser && currentUser.id === userId) {
        await userDataService.updateCurrentUserStatus(status, true);
      } else {
        // For other users, use the legacy method
        const numericStatus = status as number;
        const updatedUser = await updateUserStatus(userId, numericStatus);
        if (updatedUser) {
          // Update local state for backwards compatibility
          if (this.userProfiles[userId]) {
            this.userProfiles[userId].status = status;
          }
        }
      }
    },


    async updatePresence(status: 'online' | 'offline') {
      if (this.presenceChannel) {
        if (status === 'online') {
          // Re-track with current presence data to update heartbeat
          await this.presenceChannel.track({
            online_at: new Date().toISOString(),
          });
        } else {
          // Simply untrack - Supabase will handle the rest
          await this.presenceChannel.untrack();
        }
      }
    },

    updateOnlineUsers(presenceState: Record<string, any>) {
      debug.log('📊 Updating online users from presence:', presenceState);
      
      // Extract user IDs from presence data, not from keys
      const onlineUserIds = new Set<string>();
      
      Object.values(presenceState).forEach((presences: any) => {
        presences.forEach((presence: any) => {
          if (presence.user_id) {
            onlineUserIds.add(presence.user_id);
          }
        });
      });
      
      debug.log('👥 Online user IDs:', Array.from(onlineUserIds));
      
      // First, mark users who were previously online but are no longer in presence as offline
      const previouslyOnlineUsers = Array.from(this.onlineUsers);
      previouslyOnlineUsers.forEach((userId: string) => {
        if (!onlineUserIds.has(userId)) {
          debug.log('🔴 User went offline:', userId);
          this.setUserOnlineStatus(userId, false);
        }
      });
      
      // Update online users set with current presence
      this.onlineUsers.clear();
      onlineUserIds.forEach((userId: string) => {
        this.onlineUsers.add(userId);
        this.setUserOnlineStatus(userId, true);
      });
      
      debug.log('✅ Online users updated:', this.onlineUsers.size, 'online');
    },

    setUserOnlineStatus(userId: string, isOnline: boolean) {
      // Update userDataService (single source of truth)
      const userData = userDataService.getUser(userId);
      if (userData) {
        // ONLY update the isOnline flag, NOT the status
        // Status should remain what the user manually set (Away, Busy, etc.)
        userData.isOnline = isOnline;
        userData.lastSeen = new Date().toISOString();
        
        // Only auto-set to Offline if user disconnects AND they were Online
        // Don't override Away/Busy status
        if (!isOnline && userData.status === UserStatus.Online) {
          userData.status = UserStatus.Offline;
        }
        // When user comes back online, restore from their preferred status in database
        else if (isOnline && userData.status === UserStatus.Offline) {
          // Don't auto-set to Online - let them keep their preferred status
          // The database status is the source of truth for preferred status
        }
      }
      
      // Also update local state for backwards compatibility
      if (this.userProfiles[userId]) {
        // Same logic - only update if going from Online to Offline
        const currentStatus = this.userProfiles[userId].status;
        
        if (!isOnline && currentStatus === UserStatus.Online) {
          this.userProfiles[userId].status = UserStatus.Offline;
        }
        // Don't auto-restore status when coming online - respect their database status
      }
    },

    /**
     * Initialize membership tracking for a server
     */
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

    /**
     * Clean up membership tracking
     */
    cleanupMembershipTracking() {
      if (this.currentServerId && this.membershipSubscriptionActive) {
        debug.log(`🧹 Cleaning up membership tracking for server: ${this.currentServerId}`)
        this.membershipSubscriptionActive = false
      }
    },

    /**
     * Enhanced cleanup that includes membership tracking
     */
    cleanup() {
      // Clean up membership tracking
      this.cleanupMembershipTracking()
      
      // Clean up presence channels
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
      
      this.currentServerId = null
    },

    /**
     * Setup voice channel broadcast listener for a server
     * This allows users to see real-time updates of who's in voice channels
     */
    async setupVoiceChannelBroadcast(serverId: string) {
      // Clean up existing channel if any
      if (this.voiceChannelBroadcast) {
        await this.voiceChannelBroadcast.unsubscribe();
      }

      debug.log('🎙️ Setting up voice channel broadcast for server:', serverId);

      // NOTE: There is no database table to fetch initial state from.
      // Voice channel state is ephemeral and tracked through broadcast events only.
      // When users join/leave voice channels, they broadcast their state.
      // We'll request current state after connecting to the broadcast channel.

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
          
          // Set call start time if provided
          if (callStartTime && !this.voiceChannelCallStartTimes[channelId]) {
            this.voiceChannelCallStartTimes[channelId] = new Date(callStartTime);
            debug.log(`🕐 Set call start time for channel ${channelId}:`, this.voiceChannelCallStartTimes[channelId]);
          }
          
          // For federated users, ensure their profile is loaded
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
            
            // Clear call start time if last user left
            if (this.usersInVoiceChannels[channelId].length === 0) {
              delete this.voiceChannelCallStartTimes[channelId];
              debug.log(`🕐 Cleared call start time for channel ${channelId} (empty)`);
            }
          }
        } else if (event === 'call-start-time-sync') {
          // Sync call start time from other users
          if (callStartTime) {
            this.voiceChannelCallStartTimes[channelId] = new Date(callStartTime);
            debug.log(`🕐 Synced call start time for channel ${channelId}:`, this.voiceChannelCallStartTimes[channelId]);
          }
        } else if (event === 'request-state') {
          // Someone is requesting current voice channel state
          // If we're in a voice channel, broadcast our presence
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
      
      // Request current voice channel state from any active users
      // This allows new viewers to see who's in voice channels
      this.broadcastVoiceChannelEvent(serverId, '', 'request-state', '');
      debug.log('📡 Requested current voice channel state from active users');
    },

    /**
     * Fetch current voice channel state from database
     * Uses voice_channel_participants table for tracking
     */
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

        // Update local state - REPLACE instead of merge to clear stale data
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

    // Get all users in a specific voice channel
    getUsersInVoiceChannel(channelId: string): string[] {
      return this.usersInVoiceChannels[channelId] || [];
    },

    // Get call start time for a channel
    getCallStartTime(channelId: string): Date | null {
      return this.voiceChannelCallStartTimes[channelId] || null;
    },

    // Voice channel connection methods
    async joinVoiceChannel(serverId: string, channelId: string, userId: string, isLocalServer: boolean = true) {
      try {
        // Check if this is the first user (start new call)
        const isFirstUser = !this.usersInVoiceChannels[channelId] || this.usersInVoiceChannels[channelId].length === 0;
        
        // Add user to local state immediately for responsive UI
        if (!this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = [];
        }
        if (!this.usersInVoiceChannels[channelId].includes(userId)) {
          this.usersInVoiceChannels[channelId].push(userId);
        }

        // Set call start time if first user
        let callStartTime: string | undefined;
        if (isFirstUser) {
          this.voiceChannelCallStartTimes[channelId] = new Date();
          callStartTime = this.voiceChannelCallStartTimes[channelId].toISOString();
          debug.log(`🕐 First user - setting call start time for channel ${channelId}`);
        } else {
          // Use existing call start time
          callStartTime = this.voiceChannelCallStartTimes[channelId]?.toISOString();
        }

        // Only write to voice_channel_participants for LOCAL servers with valid UUIDs
        // DM calls use non-UUID IDs (server_id='dm', channel_id='dm-<uuid>' or 'federated-dm-<uuid>-<ts>')
        // For federated servers, the hosting instance handles this via VoiceChannelJoin activity
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

        // Broadcast to other users with call start time
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
        // Remove user from local state immediately
        if (this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
          
          // Clear call start time if last user left
          if (this.usersInVoiceChannels[channelId].length === 0) {
            delete this.voiceChannelCallStartTimes[channelId];
            debug.log(`🕐 Cleared call start time for channel ${channelId}`);
          }
        }

        // Only write to voice_channel_participants for LOCAL servers with valid UUIDs
        // DM calls use non-UUID IDs (server_id='dm', channel_id='dm-<uuid>' or 'federated-dm-<uuid>-<ts>')
        // For federated servers, the hosting instance handles this via VoiceChannelLeave activity
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

        // Broadcast to other users
        this.broadcastVoiceChannelEvent(serverId, channelId, 'user-left', userId);
        
        debug.log(`User ${userId} left voice channel ${channelId}`);
        return true;
      } catch (error) {
        debug.error('Error leaving voice channel:', error);
        return false;
      }
    },

    // Check if user is in a voice channel
    isUserInVoiceChannel(userId: string, channelId: string): boolean {
      return this.usersInVoiceChannels[channelId]?.includes(userId) || false;
    },

    // Leave all voice channels (for cleanup)
    async leaveAllVoiceChannels(serverId: string, userId: string) {
      const channelsToLeave = Object.keys(this.usersInVoiceChannels).filter(channelId => 
        this.usersInVoiceChannels[channelId].includes(userId)
      );

      for (const channelId of channelsToLeave) {
        await this.leaveVoiceChannel(serverId, channelId, userId);
      }
    },

    /**
     * Clean up a disconnected user from voice channel state
     * Called when LiveKit detects a user has disconnected (crash, network loss, etc.)
     * This ensures the sidebar participant list stays in sync
     */
    cleanupDisconnectedUser(serverId: string, channelId: string, userId: string) {
      debug.log(`🧹 Cleaning up disconnected user ${userId} from channel ${channelId}`);
      
      // Remove from local state
      if (this.usersInVoiceChannels[channelId]) {
        this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
        
        // Clear call start time if last user left
        if (this.usersInVoiceChannels[channelId].length === 0) {
          delete this.voiceChannelCallStartTimes[channelId];
        }
      }

      // Clean up database entry (fire-and-forget, don't block on this)
      // DM calls use non-UUID IDs, skip DB cleanup for those
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

      // Broadcast the leave event so other clients update their UI
      this.broadcastVoiceChannelEvent(serverId, channelId, 'user-left', userId);
    },
  }
});