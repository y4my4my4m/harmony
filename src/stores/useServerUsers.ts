import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { User } from '@/types';
import { UserStatus } from '@/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { updateUserStatus } from '@/services/profileService';
import { getMembershipService } from '@/services/membershipService';
import { userDataService } from '@/services/userDataService';
  
export const useServerUsersStore = defineStore('serverUsers', {
  state: () => ({
    userProfiles: {} as Record<string, User>,
    usersInVoiceChannels: {} as Record<string, string[]>,
    presenceChannel: null as RealtimeChannel | null,
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
      console.log('🔗 UserDataService is now the single source of truth for user data')
      console.log('✅ UserDataService integration initialized')
    },

    // Fetch individual user profile with caching - delegate to userDataService
    async fetchUserProfile(userId: string, forceRefresh = false): Promise<User | null> {
      try {
        return await userDataService.fetchUserProfile(userId, forceRefresh);
      } catch (error) {
        console.error(`Error fetching profile for user ${userId}:`, error);
        return null;
      }
    },

    // Batch fetch multiple profiles efficiently - delegate to userDataService
    async fetchMultipleUserProfiles(userIds: string[], forceRefresh = false): Promise<Record<string, User>> {
      try {
        return await userDataService.fetchMultipleUserProfiles(userIds, forceRefresh);
      } catch (error) {
        console.error('Error batch fetching profiles:', error);
        return {};
      }
    },

    // Optimized profile fetching for message displays - delegate to userDataService
    async ensureProfilesAvailable(userIds: string[]): Promise<void> {
      try {
        await userDataService.ensureUsersLoaded(userIds);
      } catch (error) {
        console.error('Error ensuring profiles are available:', error);
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
      console.log('📊 Updating online users from presence:', presenceState);
      
      // Extract user IDs from presence data, not from keys
      const onlineUserIds = new Set<string>();
      
      Object.values(presenceState).forEach((presences: any) => {
        presences.forEach((presence: any) => {
          if (presence.user_id) {
            onlineUserIds.add(presence.user_id);
          }
        });
      });
      
      console.log('👥 Online user IDs:', Array.from(onlineUserIds));
      
      // First, mark users who were previously online but are no longer in presence as offline
      const previouslyOnlineUsers = Array.from(this.onlineUsers);
      previouslyOnlineUsers.forEach((userId: string) => {
        if (!onlineUserIds.has(userId)) {
          console.log('🔴 User went offline:', userId);
          this.setUserOnlineStatus(userId, false);
        }
      });
      
      // Update online users set with current presence
      this.onlineUsers.clear();
      onlineUserIds.forEach((userId: string) => {
        this.onlineUsers.add(userId);
        this.setUserOnlineStatus(userId, true);
      });
      
      console.log('✅ Online users updated:', this.onlineUsers.size, 'online');
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
        // Only set up if we're switching to a different server
        if (this.currentServerId !== serverId) {
          console.log(`🔄 Initializing membership tracking for server: ${serverId}`)
          
          // Clean up previous server's membership subscription
          this.cleanupMembershipTracking()
          
          // Subscribe to membership events for the new server
          await getMembershipService().subscribeToServer(serverId)
          
          this.currentServerId = serverId
          this.membershipSubscriptionActive = true
          
          console.log(`✅ Membership tracking initialized for server: ${serverId}`)
        }
      } catch (error) {
        console.error('❌ Failed to initialize membership tracking:', error)
      }
    },

    /**
     * Clean up membership tracking
     */
    cleanupMembershipTracking() {
      if (this.currentServerId && this.membershipSubscriptionActive) {
        console.log(`🧹 Cleaning up membership tracking for server: ${this.currentServerId}`)
        getMembershipService().unsubscribeFromServer(this.currentServerId)
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
      if (this.offlineBroadcastChannel) {
        this.offlineBroadcastChannel.unsubscribe()
        this.offlineBroadcastChannel = null
      }
      
      this.currentServerId = null
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

    // Voice channel connection methods
    async joinVoiceChannel(serverId: string, channelId: string, userId: string) {
      try {
        // Add user to local state immediately for responsive UI
        if (!this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = [];
        }
        if (!this.usersInVoiceChannels[channelId].includes(userId)) {
          this.usersInVoiceChannels[channelId].push(userId);
        }

        // Broadcast to other users
        this.broadcastVoiceChannelEvent(serverId, channelId, 'user-joined', userId);
        
        console.log(`User ${userId} joined voice channel ${channelId}`);
        return true;
      } catch (error) {
        console.error('Error joining voice channel:', error);
        return false;
      }
    },

    async leaveVoiceChannel(serverId: string, channelId: string, userId: string) {
      try {
        // Remove user from local state immediately
        if (this.usersInVoiceChannels[channelId]) {
          this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
        }

        // Broadcast to other users
        this.broadcastVoiceChannelEvent(serverId, channelId, 'user-left', userId);
        
        console.log(`User ${userId} left voice channel ${channelId}`);
        return true;
      } catch (error) {
        console.error('Error leaving voice channel:', error);
        return false;
      }
    },

    // Check if user is in a voice channel
    isUserInVoiceChannel(userId: string, channelId: string): boolean {
      return this.usersInVoiceChannels[channelId]?.includes(userId) || false;
    },

    // Get all users in a specific voice channel
    getUsersInVoiceChannel(channelId: string): string[] {
      return this.usersInVoiceChannels[channelId] || [];
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
  }
});