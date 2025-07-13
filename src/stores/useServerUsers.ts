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
          if (presenceState) {
            this.updateOnlineUsers(presenceState);
          }
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
          user_id: 'current_user', // We'll track by channel topic instead
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
      // Update userDataService (single source of truth)
      const userData = userDataService.getUser(userId);
      if (userData) {
        userData.isOnline = isOnline;
        userData.status = isOnline ? UserStatus.Online : UserStatus.Offline;
      }
      
      // Also update local state for backwards compatibility
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