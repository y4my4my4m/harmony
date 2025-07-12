import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { User } from '@/types';
import { UserStatus } from '@/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { getProfilesWithAvatarUrls } from '@/services/usersService';
import { updateUserStatus } from '@/services/profileService';
import { getMembershipService } from '@/services/membershipService';
import { userDataService } from '@/services/userDataService';

const convertToStatusEnum = (numericStatus: number): UserStatus => {
    return numericStatus as UserStatus;
};

// Cache configuration
interface UserProfileCache {
  profile: User;
  lastFetched: Date;
  hits: number;
}
  
export const useServerUsersStore = defineStore('serverUsers', {
  state: () => ({
    userProfiles: {} as Record<string, User>,
    usersInVoiceChannels: {} as Record<string, string[]>,
    presenceChannel: null as RealtimeChannel | null,
    onlineUsers: new Set<string>(),
    offlineBroadcastChannel: null as RealtimeChannel | null,
    currentServerId: null as string | null, // Track current server for membership events
    membershipSubscriptionActive: false,
    
    // Enhanced caching system
    profileCache: new Map<string, UserProfileCache>(),
    cacheValidityDuration: 10 * 60 * 1000, // 10 minutes for user profiles
    maxCacheSize: 1000, // Maximum number of profiles to cache
    pendingFetches: new Set<string>(), // Track in-progress fetches to avoid duplicates
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
    
    // Check if a user is a member of the current server
    isServerMember: (state) => (userId: string): boolean => {
      return userId in state.userProfiles;
    },
    
    // Get user profile with intelligent fallback strategy
    // First checks server members, then falls back to cache for non-members
    getUserProfile: (state) => (userId: string): User | null => {
      // First check the main userProfiles (current server users)
      if (state.userProfiles[userId]) {
        return state.userProfiles[userId];
      }
      
      // Check cache for any previously fetched profiles (including non-server members)
      const cached = state.profileCache.get(userId);
      if (cached) {
        const now = new Date();
        const cacheAge = now.getTime() - cached.lastFetched.getTime();
        if (cacheAge < state.cacheValidityDuration) {
          cached.hits++;
          return cached.profile;
        }
      }
      
      return null;
    },
    
    // Get cache statistics
    getCacheStats: (state) => ({
      totalCached: state.profileCache.size,
      mainProfiles: Object.keys(state.userProfiles).length,
      pendingFetches: state.pendingFetches.size,
      hitRate: state.profileCache.size > 0 ? 
        Array.from(state.profileCache.values()).reduce((sum, cache) => sum + cache.hits, 0) / state.profileCache.size : 0,
    }),
  },
  actions: {
    /**
     * Initialize integration with userDataService for single source of truth
     * This ensures serverUsersStore stays in sync with userDataService updates
     */
    initializeUserDataIntegration() {
      console.log('🔗 Setting up userDataService integration with serverUsersStore')
      
      // Listen for user profile updates from userDataService
      userDataService.addEventListener('user-updated', (event: Event) => {
        const customEvent = event as CustomEvent
        const { userId } = customEvent.detail
        const userData = userDataService.getUser(userId)
        
        if (userData) {
          // Convert UserData to User format for serverUsersStore
          const userProfile: User = {
            id: userData.id,
            username: userData.username,
            display_name: userData.displayName,
            avatar_url: userData.avatarUrl,
            status: userData.status,
            // Keep other fields from existing profile if available
            ...this.getUserProfile(userId)
          }
          
          // Update both cache and main profiles
          this.addToProfileCache(userProfile)
          
          // Update main profiles if user is a server member
          if (this.userProfiles[userId]) {
            this.userProfiles[userId] = userProfile
            console.log(`🔄 Updated server user profile for: ${userData.displayName}`)
          }
        }
      })
      
      console.log('✅ UserDataService integration initialized')
    },

    // Cache management methods
    evictOldestCacheEntries() {
      if (this.profileCache.size <= this.maxCacheSize) return;

      // Sort by last accessed time and remove oldest entries
      const entries = Array.from(this.profileCache.entries())
        .sort((a, b) => a[1].lastFetched.getTime() - b[1].lastFetched.getTime());

      const toRemove = entries.slice(0, entries.length - this.maxCacheSize);
      toRemove.forEach(([userId]) => {
        this.profileCache.delete(userId);
      });

      console.log(`Evicted ${toRemove.length} old profile cache entries`);
    },

    addToProfileCache(user: User) {
      this.evictOldestCacheEntries();
      
      this.profileCache.set(user.id, {
        profile: user,
        lastFetched: new Date(),
        hits: 0,
      });
    },

    // Fetch individual user profile with caching
    async fetchUserProfile(userId: string, forceRefresh = false): Promise<User | null> {
      // Check if already fetching to avoid duplicate requests
      if (this.pendingFetches.has(userId)) {
        // Wait for existing fetch to complete
        return new Promise((resolve) => {
          const checkComplete = () => {
            if (!this.pendingFetches.has(userId)) {
              resolve(this.getUserProfile(userId));
            } else {
              setTimeout(checkComplete, 50);
            }
          };
          checkComplete();
        });
      }

      // Check cache first (unless force refresh)
      if (!forceRefresh) {
        const cachedProfile = this.getUserProfile(userId);
        if (cachedProfile) {
          console.log(`Profile cache hit for user: ${userId}`);
          return cachedProfile;
        }
      }

      this.pendingFetches.add(userId);

      try {
        console.log(`Fetching profile for user: ${userId}`);
        
        const profiles = await getProfilesWithAvatarUrls([userId]);
        
        if (profiles.length === 0) {
          console.warn(`No profile found for user: ${userId}`);
          return null;
        }

        const profile = {
          ...profiles[0],
          status: convertToStatusEnum(profiles[0].status as number)
        };

        // Always add to cache for future lookups
        this.addToProfileCache(profile);

        // Only add to main userProfiles if they're already there (i.e., they're a server member)
        // This keeps userProfiles clean and only for current server members
        if (this.userProfiles[userId]) {
          this.userProfiles[userId] = profile;
        }

        console.log(`Successfully fetched and cached profile for user: ${userId}`);
        return profile;

      } catch (error) {
        console.error(`Error fetching profile for user ${userId}:`, error);
        return null;
      } finally {
        this.pendingFetches.delete(userId);
      }
    },

    // Batch fetch multiple profiles efficiently
    async fetchMultipleUserProfiles(userIds: string[], forceRefresh = false): Promise<Record<string, User>> {
      const results: Record<string, User> = {};

      // Filter out users that are already cached (unless force refresh)
      const uncachedUserIds = forceRefresh ? userIds : userIds.filter(id => !this.getUserProfile(id));

      if (uncachedUserIds.length === 0) {
        // All profiles are cached, return them
        userIds.forEach(id => {
          const profile = this.getUserProfile(id);
          if (profile) {
            results[id] = profile;
          }
        });
        return results;
      }

      try {
        console.log(`Batch fetching ${uncachedUserIds.length} profiles`);
        
        const profiles = await getProfilesWithAvatarUrls(uncachedUserIds);

        profiles.forEach(profile => {
          if (profile) {
            const processedProfile = {
              ...profile,
              status: convertToStatusEnum(profile.status as number)
            };

            // Add to cache
            this.addToProfileCache(processedProfile);

            // Add to main userProfiles if not already there
            if (!this.userProfiles[profile.id]) {
              this.userProfiles[profile.id] = processedProfile;
            }

            results[profile.id] = processedProfile;
          }
        });

        // Also include any cached profiles that were requested
        userIds.forEach(id => {
          if (!results[id]) {
            const cachedProfile = this.getUserProfile(id);
            if (cachedProfile) {
              results[id] = cachedProfile;
            }
          }
        });

        console.log(`Successfully batch fetched ${profiles.length} profiles`);
        return results;

      } catch (error) {
        console.error('Error batch fetching profiles:', error);
        return results;
      }
    },

    // Optimized profile fetching for message displays
    // Efficiently handles bulk fetching of profiles that might not be server members
    async ensureProfilesAvailable(userIds: string[]): Promise<void> {
      const missingUserIds = userIds.filter(id => !this.getUserProfile(id));
      
      if (missingUserIds.length === 0) {
        return; // All profiles already available
      }

      try {
        console.log(`Ensuring ${missingUserIds.length} profiles are available`);
        await this.fetchMultipleUserProfiles(missingUserIds);
      } catch (error) {
        console.error('Error ensuring profiles are available:', error);
      }
    },

    // Clear cache for specific user (useful when profile is updated)
    invalidateUserProfileCache(userId: string) {
      this.profileCache.delete(userId);
      console.log(`Invalidated profile cache for user: ${userId}`);
    },

    // Clear all profile caches
    clearProfileCache() {
      this.profileCache.clear();
      console.log('Cleared all profile caches');
    },

    async fetchUserProfiles(userIds: string[]) {
      const profiles = await getProfilesWithAvatarUrls(userIds);

      this.userProfiles = profiles.reduce((acc, profile) => {
        if (profile) {
          const userProfile = { 
            ...profile,
            status: convertToStatusEnum(profile.status as number)
          };
          acc[profile.id] = userProfile;
          
          // Also add to cache
          this.addToProfileCache(userProfile);
        }
        return acc;
      }, {} as Record<string, User>);
      
      // IMPORTANT: Ensure userDataService also has this user data for reactive access
      try {
        await userDataService.ensureUsersLoaded(userIds);
      } catch (error) {
        console.warn('Failed to load user data into userDataService:', error);
      }
    },

    async setStatus(userId: string, status: UserStatus) {
      const numericStatus = status as number;
      const updatedUser = await updateUserStatus(userId, numericStatus);
      if (updatedUser) {
        this.userProfiles[userId].status = status;
      }
    },

    // DEPRECATED: This method is replaced by the global presence system
    // Kept for backward compatibility but should not be used
    subscribeToUserStatuses() {
      console.warn('subscribeToUserStatuses is deprecated. Use global presence system instead.');
      return; // No-op to avoid conflicts with global presence
      
      // Legacy implementation (disabled):
      // Only unsubscribe from the specific user-status channel if it exists
      // DO NOT use removeAllChannels() as it destroys ALL subscriptions including notifications!
      // const existingChannel = supabase.getChannels().find(ch => ch.topic === 'user-statuses');
      // if (existingChannel) {
      //   supabase.removeChannel(existingChannel);
      // }
      // ... rest of legacy implementation
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