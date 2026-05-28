import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import { useToast } from 'vue-toastification';
import type { Server, Category, Channel, ResolvedEmoji, ServerFolder } from '@/types';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useChatStore } from '@/stores/useChat';
import { statePersistence } from '@/services/StatePersistence';
import { userEventChannel } from '@/services/UserEventChannel';
import { authContextService } from '@/services/AuthContextService';
import { debug } from '@/utils/debug';
import type { RealtimeChannel } from '@supabase/supabase-js';
import router from '@/router';

export const useServerChannelStore = defineStore('serverChannel', {
  state: () => ({
    servers: [] as Server[],
    publicServers: [] as Server[],
    folders: [] as ServerFolder[],
    channels: [] as Channel[],
    categories: [] as Category[],
    categoryChannels: {} as Record<string, Channel[]>,
    currentServer: {} as Server,
    currentServerId: null as string | null,
    currentChannelId: null as string | null,
    isInitializing: false as boolean,
    hasInitialized: false as boolean,
    // Real-time subscriptions
    serverStructureSubscription: null as RealtimeChannel | null,
    userServersSubscription: null as RealtimeChannel | null, // legacy, kept for type compat
    _userServerBroadcastUnsubs: [] as (() => void)[],
    currentUserId: null as string | null,
    // Request deduplication - prevents concurrent duplicate fetches
    _pendingFetches: {} as Record<string, Promise<void> | undefined>,
    // Tracks which server's categories/channels are currently loaded in memory
    // Since categories/channels are shared state, only ONE server's data exists at a time
    _loadedCategoriesServerId: null as string | null,
    // Flag to auto-open invite modal after navigating to a server
    pendingInviteOpen: false as boolean,
  }),

  getters: {
    // Get resolved emojis from the emoji cache store
    resolvedEmojiList: () => {
      const emojiCache = useEmojiCacheStore();
      return emojiCache.resolvedEmojis;
    },
    
    // Get emojis for current server
    currentServerEmojis(this): ResolvedEmoji[] {
      const emojiCache = useEmojiCacheStore();
      if (!this.currentServerId) return [];
      return emojiCache.getServerEmojis(this.currentServerId);
    },
    
    /**
     * Get a channel by ID - O(n) but channels array is typically small
     * For voice channel lookups and other direct channel access
     * Usage: serverChannelStore.getChannelById('channel-id')
     */
    getChannelById: (state) => (channelId: string): Channel | undefined => {
      return state.channels.find((c: Channel) => c.id === channelId);
    },
    
    /**
     * Get channel name by ID - convenience getter for voice channel overlay etc.
     * Usage: serverChannelStore.getChannelNameById('channel-id')
     */
    getChannelNameById: (state) => (channelId: string): string => {
      const channel = state.channels.find((c: Channel) => c.id === channelId);
      return channel?.name || 'Unknown Channel';
    },
  },

  actions: {
    async initializeUserEnvironment(userId: string): Promise<void> {
      try {
        debug.log('🚀 Initializing user environment...');
        this.isInitializing = true;
        this.currentUserId = userId;
        
        // Fetch user's servers and folders in parallel
        await Promise.all([
          this.fetchServersForUser(userId),
          this.fetchFolders(userId)
        ]);
        
        // Subscribe to real-time updates for user's server list (join/leave)
        // NON-BLOCKING: Don't wait for websocket connection - let it connect in background
        // This prevents 6+ second blocking during initial load
        this.subscribeToUserServers(userId).catch(error => {
          debug.warn('⚠️ Failed to subscribe to user servers (non-blocking):', error)
        })
        
        // Restore last selected server and channel from persistence
        await this.restorePersistedState();
        
        // Note: Emoji cache is now initialized by RouteAwareInitialization
        // to only load emojis for current server initially
        
        // Mark app as initialized to prevent flash on subsequent loads
        statePersistence.setAppInitialized(true);
        this.hasInitialized = true;
        this.isInitializing = false;
        
        debug.log('✅ User environment initialized successfully');
      } catch (error) {
        debug.error('❌ Failed to initialize user environment:', error);
        this.isInitializing = false;
        throw error;
      }
    },

    async restorePersistedState(): Promise<void> {
      if (this.servers.length === 0) return;

      // Initialize persistence service first
      await statePersistence.initialize()
      
      const lastServerId = statePersistence.getLastServer();
      
      // Validate that the last server still exists in user's servers
      const serverExists = this.servers.some(server => server.id === lastServerId);
      
      if (lastServerId && serverExists) {
        debug.log('🔄 Restoring last selected server:', lastServerId);
        this.setCurrentServer(lastServerId);
        
        // Fetch categories and channels for the server first
        await this.fetchCategoriesAndChannels(lastServerId);
        
        // Restore last channel for this server
        const lastChannelId = statePersistence.getLastChannel(lastServerId);
        if (lastChannelId && this.channels.some(channel => channel.id === lastChannelId)) {
          debug.log('🔄 Restoring last selected channel:', lastChannelId);
          this.setCurrentChannel(lastChannelId);
        } else if (this.channels.length > 0) {
          // Set default channel if last channel doesn't exist
          const defaultChannel = this.getDefaultChannel();
          if (defaultChannel) {
            this.setCurrentChannel(defaultChannel);
          }
        }
      } else if (this.servers.length > 0) {
        // No valid last server, select first available server
        debug.log('🔄 No valid last server, selecting first available');
        this.setCurrentServer(this.servers[0].id);
        
        // Fetch categories and channels for the first server
        await this.fetchCategoriesAndChannels(this.servers[0].id);
        
        if (this.channels.length > 0) {
          const defaultChannel = this.getDefaultChannel();
          if (defaultChannel) {
            this.setCurrentChannel(defaultChannel);
          }
        }
      }
      
      // Mark state persistence as complete
      statePersistence.setRestorationComplete()
    },

    getDefaultChannel(): string | null {
      // Priority order for channel selection:
      // 1. First text channel in first category
      // 2. First orphan text channel
      // 3. Any first channel as fallback

      // Try to find first text channel in first category
      if (this.categories && this.categories.length > 0) {
        for (const category of this.categories) {
          const categoryChannelList = this.categoryChannels[category.id] || [];
          const firstTextChannel = categoryChannelList.find(ch => ch.type === 0);
          if (firstTextChannel) {
            return firstTextChannel.id;
          }
        }
      }

      // Try to find first orphan text channel
      const orphanChannels = this.channels.filter(channel => !channel.category);
      const firstOrphanTextChannel = orphanChannels.find(ch => ch.type === 0);
      if (firstOrphanTextChannel) {
        return firstOrphanTextChannel.id;
      }

      // Fallback to any first available channel
      const firstChannel = this.channels.find(ch => ch.type === 0) || this.channels[0];
      return firstChannel?.id || null;
    },

    setCurrentServer(serverId: string): void {
      // SMART CACHING: Prevent setting the same server twice
      if (this.currentServerId === serverId) {
        debug.log(`💾 Server ${serverId} already selected, skipping duplicate set`);
        return;
      }
      
      const server = this.servers.find(s => s.id === serverId);
      if (server) {
        this.currentServerId = serverId;
        this.currentServer = server;
        // Persist state asynchronously without blocking
        statePersistence.setLastServer(serverId).catch(debug.error);
        debug.log('📍 Current server set to:', server.name);
        
        // Subscribe to real-time updates for this server's structure (channels/categories)
        this.subscribeToServerStructure(serverId).catch(debug.error);
      }
    },

    setCurrentChannel(channelId: string | null): void {
      this.currentChannelId = channelId;
      if (channelId && this.currentServerId) {
        // Persist state asynchronously without blocking
        statePersistence.setLastChannel(this.currentServerId, channelId).catch(debug.error);
        const channel = this.channels.find(c => c.id === channelId);
        debug.log('📍 Current channel set to:', channel?.name || channelId);
      }
    },

    /**
     * OPTIMIZED: Skip fetching if servers already loaded (unless forced)
     */
    async fetchServersForUser(userId: string, force = false) {
      const fetchKey = `servers-${userId}`;
      
      // Skip if servers are already loaded and not forcing refresh
      if (this.servers.length > 0 && !force) {
        debug.log(`📋 User servers already loaded (${this.servers.length}), skipping fetch`);
        return;
      }
      
      // Deduplicate concurrent requests
      if (this._pendingFetches[fetchKey]) {
        debug.log('🔄 Deduplicating user servers fetch');
        return this._pendingFetches[fetchKey];
      }

      const fetchPromise = (async () => {
        try {
          debug.log('🔄 Fetching servers for user via service-like helper:', userId)
          
          // Use service-like helper for user server fetching
          const servers = await this._fetchServersForUserHelper(userId)
          
          if (servers) {
            this.servers = servers
            debug.log(`✅ Servers fetched successfully via service-like helper: ${servers.length} servers`)
          }
        } catch (error) {
          debug.error('❌ Failed to fetch servers for user via service-like helper:', error)
          
          // Fallback to direct fetching if helper fails
          try {
            debug.log('🔄 Falling back to direct user server fetching')
            await this._fetchServersForUserFallback(userId)
          } catch (fallbackError) {
            debug.error('❌ Fallback user server fetching also failed:', fallbackError)
            throw fallbackError
          }
        } finally {
          delete this._pendingFetches[fetchKey];
        }
      })();
      
      this._pendingFetches[fetchKey] = fetchPromise;
      return fetchPromise;
    },

    /**
     * Service-like helper: Fetch servers for a specific user
     */
    async _fetchServersForUserHelper(userId: string): Promise<Server[]> {
      const { data, error } = await supabase
        .from('user_servers')
        .select(`
          folder_id,
          position,
          server:server_id (
            id,
            name,
            description,
            icon,
            owner,
            allow_cross_server_emojis,
            public,
            federation_enabled,
            is_local_server,
            federation_domain,
            federation_inbox_url
          )
        `)
        .eq('user_id', userId)
        .order('position', { ascending: true })

      if (error) {
        throw new Error(`User servers fetching failed: ${error.message}`)
      }

      return data?.map((item: any) => ({
        ...item.server,
        folder_id: item.folder_id,
        position: item.position
      })).filter((s: any) => s.id) || []
    },

    /**
     * Fallback method for fetching servers for user
     */
    async _fetchServersForUserFallback(userId: string): Promise<void> {
      const { data, error } = await supabase
        .from('user_servers')
        .select(`
          folder_id,
          position,
          server:server_id (
            id,
            name,
            description,
            icon,
            owner,
            allow_cross_server_emojis,
            public,
            federation_enabled,
            is_local_server,
            federation_domain,
            federation_inbox_url
          )
        `)
        .eq('user_id', userId)
        .order('position', { ascending: true })

      if (error) {
        debug.error('Error fetching servers for user in fallback:', error)
        return
      }

      this.servers = data?.map((item: any) => ({
        ...item.server,
        folder_id: item.folder_id,
        position: item.position
      })).filter((s: any) => s.id) || []
      debug.log(`📊 Loaded ${this.servers.length} servers for user`)
    },

    async fetchServers() {
      try {
        debug.log('🔄 Fetching all servers via service-like helper');
        
        // Use service-like helper for database operations
        const servers = await this._fetchServersHelper();
        this.servers = servers || [];
        
        debug.log(`✅ Fetched ${this.servers.length} servers via service-like helper`);
      } catch (error) {
        debug.error('❌ Failed to fetch servers via service-like helper:', error);
        
        // Fallback to direct query if helper fails
        try {
          debug.log('🔄 Falling back to direct servers fetch');
          await this._fetchServersFallback();
        } catch (fallbackError) {
          debug.error('❌ Fallback servers fetch also failed:', fallbackError);
          this.servers = []; // Ensure state is clean on total failure
        }
      }
    },

    /**
     * Service-like helper: Fetch all servers with enhanced error handling
     */
    async _fetchServersHelper(): Promise<Server[]> {
      const { data, error } = await supabase.from('servers').select('*');
      
      if (error) {
        throw new Error(`Servers fetch failed: ${error.message}`);
      }
      
      return data || [];
    },

    /**
     * Fallback method for fetching servers
     */
    async _fetchServersFallback(): Promise<void> {
      const { data, error } = await supabase.from('servers').select('*');
      if (error) {
        debug.error('Error in fallback servers fetch:', error);
        throw error;
      }
      this.servers = data || [];
    },

    async fetchCategoriesAndChannels(serverId: string, signal?: AbortSignal, forceRefresh = false) {
      const fetchKey = `categories-channels-${serverId}`;
      
      // Skip if we already have THIS server's data loaded and not forcing refresh
      // NOTE: We check _loadedCategoriesServerId to know which server's data is in memory
      // The shared state (categories, channels) only holds ONE server's data at a time
      if (!forceRefresh && this._loadedCategoriesServerId === serverId && this.categories.length > 0) {
        debug.log('📦 Categories and channels already loaded for server:', serverId);
        return;
      }
      
      // Deduplicate concurrent requests - return existing promise if in flight
      if (this._pendingFetches[fetchKey]) {
        debug.log('🔄 Deduplicating categories/channels fetch for:', serverId);
        return this._pendingFetches[fetchKey];
      }
      
      const fetchPromise = (async () => {
        try {
          debug.log('🔄 Fetching categories and channels via service-like helper:', serverId);
          
          // Use service-like helper with full abort support
          await this._fetchCategoriesAndChannelsHelper(serverId, signal);
          
          // Track which server's data is currently in memory
          this._loadedCategoriesServerId = serverId;
          
          debug.log(`✅ Fetched ${this.categories?.length || 0} categories and ${this.channels?.length || 0} channels via service-like helper`);
        } catch (error) {
          if (signal?.aborted) {
            debug.log('🛑 Categories and channels fetch aborted');
            return;
          }
          
          debug.error('❌ Failed to fetch categories and channels via service-like helper:', error);
          
          // Fallback to direct query if helper fails
          try {
            debug.log('🔄 Falling back to direct categories and channels fetch');
            await this._fetchCategoriesAndChannelsFallback(serverId, signal);
            this._loadedCategoriesServerId = serverId;
          } catch (fallbackError) {
            if (signal?.aborted) {
              debug.log('🛑 Categories and channels fallback fetch aborted');
              return;
            }
            debug.error('❌ Fallback categories and channels fetch also failed:', fallbackError);
            // Ensure state is clean on total failure
            this.categories = [];
            this.channels = [];
            this.categoryChannels = {};
            this._loadedCategoriesServerId = null;
          }
        } finally {
          delete this._pendingFetches[fetchKey];
        }
      })();
      
      this._pendingFetches[fetchKey] = fetchPromise;
      return fetchPromise;
    },

    /**
     * Service-like helper: Fetch categories and channels with abort support
     */
    async _fetchCategoriesAndChannelsHelper(serverId: string, signal?: AbortSignal): Promise<void> {
      // Fetch categories first
      const { data: categories, error: categoriesError } = await supabase
        .from('channel_categories')
        .select('*')
        .eq('server_id', serverId)
        .order('order', { ascending: true });

      if (signal?.aborted) throw new Error('Operation aborted');
      
      if (categoriesError) {
        throw new Error(`Categories fetch failed: ${categoriesError.message}`);
      }

      // Fetch channels
      const { data: channels, error: channelsError } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId)
        .order('order', { ascending: true });

      if (signal?.aborted) throw new Error('Operation aborted');
      
      if (channelsError) {
        throw new Error(`Channels fetch failed: ${channelsError.message}`);
      }

      // Update state and process data
      this._processCategoriesAndChannelsData(categories || [], channels || [], serverId);
    },

    /**
     * Fallback method for fetching categories and channels
     */
    async _fetchCategoriesAndChannelsFallback(serverId: string, signal?: AbortSignal): Promise<void> {
      // Fetch categories
      const { data: categories, error: categoriesError } = await supabase
        .from('channel_categories')
        .select('*')
        .eq('server_id', serverId)
        .order('order', { ascending: true });

      if (signal?.aborted) return;
      
      if (categoriesError) {
        debug.error('Error fetching categories in fallback:', categoriesError);
        throw categoriesError;
      }

      // Fetch channels ordered by order column
      const { data: channels, error: channelsError } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId)
        .order('order', { ascending: true });

      if (signal?.aborted) return;
      
      if (channelsError) {
        debug.error('Error fetching channels in fallback:', channelsError);
        throw channelsError;
      }

      // Update state and process data
      this._processCategoriesAndChannelsData(categories || [], channels || [], serverId);
    },

    /**
     * Service-like helper: Process categories and channels data
     */
    _processCategoriesAndChannelsData(categories: Category[], channels: Channel[], serverId: string): void {
      this.categories = categories;
      this.channels = channels;
      this.categoryChannels = {};

      // Populate categoryChannels mapping
      this.channels.forEach(channel => {
        if (channel.category) {
          if (!this.categoryChannels[channel.category]) {
            this.categoryChannels[channel.category] = [];
          }
          this.categoryChannels[channel.category].push(channel);
        }
      });

      // Sort channels within each category by order
      Object.keys(this.categoryChannels).forEach(categoryId => {
        this.categoryChannels[categoryId].sort((a, b) => (a.order || 0) - (b.order || 0));
      });

      // Update current server state
      this.setCurrentServer(serverId);
    },

    async moveChannelToCategory(channelId: string, newCategoryId: string | null) {
      try {
        debug.log('🔄 Moving channel to category via service-like helper:', { channelId, newCategoryId })
        
        // Use service-like helper for optimistic channel move with rollback
        const updatedChannel = await this._moveChannelToCategoryHelper(channelId, newCategoryId)
        
        debug.log(`✅ Channel moved successfully via service-like helper: ${channelId} → ${newCategoryId || 'orphan'}`)
        return updatedChannel
      } catch (error) {
        debug.error('❌ Failed to move channel via service-like helper:', error)
        
        // Fallback to direct move if helper fails
        try {
          debug.log('🔄 Falling back to direct channel move')
          return await this._moveChannelToCategoryFallback(channelId, newCategoryId)
        } catch (fallbackError) {
          debug.error('❌ Fallback channel move also failed:', fallbackError)
          throw fallbackError
        }
      }
    },

    /**
     * Service-like helper: Move channel to category with optimistic updates and rollback
     */
    async _moveChannelToCategoryHelper(channelId: string, newCategoryId: string | null) {
      // Store original state for potential rollback
      const originalChannels = [...this.channels]
      const originalCategoryChannels = { ...this.categoryChannels }

      try {
        // Optimistic update: Update local state immediately
        const channelIndex = this.channels.findIndex(c => c.id === channelId)
        if (channelIndex !== -1) {
          this.channels[channelIndex] = { 
            ...this.channels[channelIndex], 
            category: newCategoryId 
          }
          // Refresh category channels mapping optimistically
          this.refreshCategoryChannels()
        }

        // Now perform the server update in the background
        const { data, error } = await supabase
          .from('channels')
          .update({ category: newCategoryId })
          .eq('id', channelId)
          .select()
          .single()

        if (error) {
          throw new Error(`Channel move failed: ${error.message}`)
        }

        return data
      } catch (error) {
        // Rollback on error: Restore original state
        debug.log('🔄 Rolling back optimistic channel move due to error')
        this.channels = originalChannels
        this.categoryChannels = originalCategoryChannels
        throw error
      }
    },

    /**
     * Fallback method for moving channel to category
     */
    async _moveChannelToCategoryFallback(channelId: string, newCategoryId: string | null) {
      // Store original state for potential rollback
      const originalChannels = [...this.channels]
      const originalCategoryChannels = { ...this.categoryChannels }

      try {
        // Optimistic update: Update local state immediately
        const channelIndex = this.channels.findIndex(c => c.id === channelId)
        if (channelIndex !== -1) {
          this.channels[channelIndex] = { 
            ...this.channels[channelIndex], 
            category: newCategoryId 
          }
          // Refresh category channels mapping optimistically
          this.refreshCategoryChannels()
        }

        // Now perform the server update in the background
        const { data, error } = await supabase
          .from('channels')
          .update({ category: newCategoryId })
          .eq('id', channelId)
          .select()
          .single()

        if (error) {
          debug.error('Error moving channel to category in fallback:', error)
          throw error
        }

        debug.log(`✅ Successfully moved channel ${channelId} to category ${newCategoryId || 'orphan'}`)
        return data
      } catch (error) {
        // Rollback on error: Restore original state
        debug.error('❌ Server update failed, rolling back channel move:', error)
        this.channels = originalChannels
        this.categoryChannels = originalCategoryChannels
        throw error
      }
    },

    async updateChannelOrder(channels: Channel[], categoryId: string | null) {
      try {
        debug.log('🔄 Updating channel order via service-like helper:', { count: channels.length, categoryId })
        
        // Use service-like helper for complex channel ordering with rollback
        await this._updateChannelOrderHelper(channels, categoryId)
        
        debug.log(`✅ Channel order updated successfully via service-like helper: ${channels.length} channels`)
      } catch (error) {
        debug.error('❌ Failed to update channel order via service-like helper:', error)
        
        // Fallback to direct ordering if helper fails
        try {
          debug.log('🔄 Falling back to direct channel ordering')
          await this._updateChannelOrderFallback(channels, categoryId)
        } catch (fallbackError) {
          debug.error('❌ Fallback channel ordering also failed:', fallbackError)
          throw fallbackError
        }
      }
    },

    /**
     * Service-like helper: Update channel order with optimistic updates and rollback
     */
    async _updateChannelOrderHelper(channels: Channel[], categoryId: string | null): Promise<void> {
      // Store original state for potential rollback
      const originalChannels = [...this.channels]
      const originalCategoryChannels = { ...this.categoryChannels }

      try {
        // Optimistic update: Update local state immediately
        const updateMap = new Map(channels.map((channel, index) => [channel.id, { order: index, category: categoryId }]))
        this.channels = this.channels.map(channel => {
          const update = updateMap.get(channel.id)
          return update ? { ...channel, order: update.order, category: update.category } : channel
        })

        // Refresh category channels mapping optimistically
        this.refreshCategoryChannels()

        // Now perform the server update in the background
        for (let i = 0; i < channels.length; i++) {
          const channel = channels[i]
          const { error } = await supabase
            .from('channels')
            .update({ 
              order: i, 
              category: categoryId 
            })
            .eq('id', channel.id)

          if (error) {
            throw new Error(`Channel order update failed for ${channel.id}: ${error.message}`)
          }
        }
      } catch (error) {
        // Rollback on error: Restore original state
        debug.log('🔄 Rolling back optimistic channel order due to error')
        this.channels = originalChannels
        this.categoryChannels = originalCategoryChannels
        throw error
      }
    },

    /**
     * Fallback method for updating channel order
     */
    async _updateChannelOrderFallback(channels: Channel[], categoryId: string | null): Promise<void> {
      // Store original state for potential rollback
      const originalChannels = [...this.channels]
      const originalCategoryChannels = { ...this.categoryChannels }

      try {
        // Optimistic update: Update local state immediately
        const updateMap = new Map(channels.map((channel, index) => [channel.id, { order: index, category: categoryId }]))
        this.channels = this.channels.map(channel => {
          const update = updateMap.get(channel.id)
          return update ? { ...channel, order: update.order, category: update.category } : channel
        })

        // Refresh category channels mapping optimistically
        this.refreshCategoryChannels()

        // Now perform the server update in the background
        for (let i = 0; i < channels.length; i++) {
          const channel = channels[i]
          const { error } = await supabase
            .from('channels')
            .update({ 
              order: i, 
              category: categoryId 
            })
            .eq('id', channel.id)

          if (error) {
            debug.error(`Error updating channel ${channel.id}:`, error)
            throw error
          }
        }

        debug.log(`✅ Successfully updated order for ${channels.length} channels`)
      } catch (error) {
        // Rollback on error: Restore original state
        debug.error('❌ Server update failed, rolling back changes:', error)
        this.channels = originalChannels
        this.categoryChannels = originalCategoryChannels
        throw error
      }
    },

    async reorderChannelsInCategory(categoryId: string | null, newChannelOrder: Channel[]) {
      try {
        debug.log('🔄 Reordering channels in category via service-like helper:', { categoryId, count: newChannelOrder.length })
        
        // Use service-like helper for channel reordering
        await this._reorderChannelsInCategoryHelper(categoryId, newChannelOrder)
        
        debug.log(`✅ Channels reordered successfully via service-like helper: ${newChannelOrder.length} in ${categoryId || 'orphan'}`)
      } catch (error) {
        debug.error('❌ Failed to reorder channels via service-like helper:', error)
        
        // Fallback to direct reordering if helper fails
        try {
          debug.log('🔄 Falling back to direct channel reordering')
          await this._reorderChannelsInCategoryFallback(categoryId, newChannelOrder)
        } catch (fallbackError) {
          debug.error('❌ Fallback channel reordering also failed:', fallbackError)
          throw fallbackError
        }
      }
    },

    /**
     * Service-like helper: Reorder channels within a category
     */
    async _reorderChannelsInCategoryHelper(categoryId: string | null, newChannelOrder: Channel[]): Promise<void> {
      // Delegate to the updateChannelOrder helper for consistency
      await this.updateChannelOrder(newChannelOrder, categoryId)
    },

    /**
     * Fallback method for reordering channels in category
     */
    async _reorderChannelsInCategoryFallback(categoryId: string | null, newChannelOrder: Channel[]): Promise<void> {
      // Specifically handle reordering within the same category
      try {
        await this.updateChannelOrder(newChannelOrder, categoryId)
        debug.log(`✅ Reordered ${newChannelOrder.length} channels in category ${categoryId || 'orphan'}`)
      } catch (error) {
        debug.error('❌ Failed to reorder channels in category:', error)
        throw error
      }
    },

    refreshCategoryChannels() {
      // Rebuild the categoryChannels mapping from current channels
      this.categoryChannels = {};
      
      this.channels.forEach(channel => {
        if (channel.category) {
          if (!this.categoryChannels[channel.category]) {
            this.categoryChannels[channel.category] = [];
          }
          this.categoryChannels[channel.category].push(channel);
        }
      });

      // Sort channels within each category by order
      Object.keys(this.categoryChannels).forEach(categoryId => {
        this.categoryChannels[categoryId].sort((a, b) => (a.order || 0) - (b.order || 0));
      });
    },

    async updateCategoryOrder(categories: Category[]) {
      try {
        debug.log('🔄 Updating category order via service-like helper:', { count: categories.length })
        
        // Use service-like helper for complex category ordering with rollback
        await this._updateCategoryOrderHelper(categories)
        
        debug.log(`✅ Category order updated successfully via service-like helper: ${categories.length} categories`)
      } catch (error) {
        debug.error('❌ Failed to update category order via service-like helper:', error)
        
        // Fallback to direct ordering if helper fails
        try {
          debug.log('🔄 Falling back to direct category ordering')
          await this._updateCategoryOrderFallback(categories)
        } catch (fallbackError) {
          debug.error('❌ Fallback category ordering also failed:', fallbackError)
          throw fallbackError
        }
      }
    },

    /**
     * Service-like helper: Update category order with optimistic updates and rollback
     */
    async _updateCategoryOrderHelper(categories: Category[]): Promise<void> {
      // Store original state for potential rollback
      const originalCategories = [...this.categories]

      try {
        // Optimistic update: Update local state immediately AND sort by order
        this.categories = this.categories.map(category => {
          const newIndex = categories.findIndex(c => c.id === category.id)
          return newIndex !== -1 ? { ...category, order: newIndex } : category
        }).sort((a, b) => (a.order || 0) - (b.order || 0)) // Add sorting here!

        // Now perform the server update in the background using individual updates
        for (let i = 0; i < categories.length; i++) {
          const category = categories[i]
          const { error } = await supabase
            .from('channel_categories')
            .update({ order: i })
            .eq('id', category.id)

          if (error) {
            throw new Error(`Category order update failed for ${category.id}: ${error.message}`)
          }
        }
      } catch (error) {
        // Rollback on error: Restore original state
        debug.log('🔄 Rolling back optimistic category order due to error')
        this.categories = originalCategories
        throw error
      }
    },

    /**
     * Fallback method for updating category order
     */
    async _updateCategoryOrderFallback(categories: Category[]): Promise<void> {
      // Store original state for potential rollback
      const originalCategories = [...this.categories]

      try {
        // Optimistic update: Update local state immediately AND sort by order
        this.categories = this.categories.map(category => {
          const newIndex = categories.findIndex(c => c.id === category.id)
          return newIndex !== -1 ? { ...category, order: newIndex } : category
        }).sort((a, b) => (a.order || 0) - (b.order || 0)) // Add sorting here!

        // Now perform the server update in the background using individual updates
        for (let i = 0; i < categories.length; i++) {
          const category = categories[i]
          const { error } = await supabase
            .from('channel_categories')
            .update({ order: i })
            .eq('id', category.id)

          if (error) {
            debug.error(`Error updating category ${category.id}:`, error)
            throw error
          }
        }

        debug.log(`✅ Successfully updated order for ${categories.length} categories`)
      } catch (error) {
        // Rollback on error: Restore original state
        debug.error('❌ Server update failed, rolling back category changes:', error)
        this.categories = originalCategories
        throw error
      }
    },

    async createCategory(name: string, serverId: string) {
      try {
        debug.log('🔄 Creating category via service-like helper:', { name, serverId });
        
        // Use service-like helper for category creation
        const newCategory = await this._createCategoryHelper(name, serverId);
        
        if (newCategory) {
          // Check if realtime subscription already added this category (race condition prevention)
          if (!this.categories.some(c => c.id === newCategory.id)) {
            this.categories.push(newCategory);
            // Sort by order
            this.categories.sort((a, b) => (a.order || 0) - (b.order || 0));
            // Initialize empty channel array for this category
            if (!this.categoryChannels[newCategory.id]) {
              this.categoryChannels[newCategory.id] = [];
            }
          } else {
            debug.log('⚠️ Category already added by realtime, skipping duplicate push');
          }
          debug.log('✅ Category created successfully via service-like helper:', newCategory.id);
          return newCategory;
        }
        
        return null;
      } catch (error) {
        debug.error('❌ Failed to create category via service-like helper:', error);
        
        // Fallback to direct creation if helper fails
        try {
          debug.log('🔄 Falling back to direct category creation');
          return await this._createCategoryFallback(name, serverId);
        } catch (fallbackError) {
          debug.error('❌ Fallback category creation also failed:', fallbackError);
          return null;
        }
      }
    },

    /**
     * Service-like helper: Create category with proper ordering
     * Enforces a maximum of 25 categories per server
     */
    async _createCategoryHelper(name: string, serverId: string): Promise<Category | null> {
      const MAX_CATEGORIES_PER_SERVER = 25;
      
      // Check category count limit
      const { count: categoryCount, error: countError } = await supabase
        .from('channel_categories')
        .select('*', { count: 'exact', head: true })
        .eq('server_id', serverId);
      
      if (countError) {
        debug.warn('Warning: Could not check category count:', countError);
      } else if ((categoryCount || 0) >= MAX_CATEGORIES_PER_SERVER) {
        throw new Error(`Category limit reached: Maximum ${MAX_CATEGORIES_PER_SERVER} categories per server`);
      }
      
      // Get the highest order value for existing categories in this server
      const { data: existingCategories, error: fetchError } = await supabase
        .from('channel_categories')
        .select('order')
        .eq('server_id', serverId)
        .order('order', { ascending: false })
        .limit(1);

      if (fetchError) {
        debug.warn('Warning: Could not fetch existing categories for ordering, using default');
      }

      // Calculate the next order value (highest + 1, or 0 if no categories exist)
      const nextOrder = existingCategories && existingCategories.length > 0 
        ? (existingCategories[0].order || 0) + 1 
        : 0;

      const { data, error } = await supabase
        .from('channel_categories')
        .insert([{ name, server_id: serverId, order: nextOrder }])
        .select()
        .single();

      if (error) {
        throw new Error(`Category creation failed: ${error.message}`);
      }

      return data;
    },

    /**
     * Fallback method for creating category
     * Enforces a maximum of 25 categories per server
     */
    async _createCategoryFallback(name: string, serverId: string): Promise<Category | null> {
      const MAX_CATEGORIES_PER_SERVER = 25;
      
      // Check category count limit
      const { count: categoryCount, error: countError } = await supabase
        .from('channel_categories')
        .select('*', { count: 'exact', head: true })
        .eq('server_id', serverId);
      
      if (countError) {
        debug.warn('Warning: Could not check category count in fallback:', countError);
      } else if ((categoryCount || 0) >= MAX_CATEGORIES_PER_SERVER) {
        throw new Error(`Category limit reached: Maximum ${MAX_CATEGORIES_PER_SERVER} categories per server`);
      }
      
      // Get the highest order value for existing categories in this server
      const { data: existingCategories, error: fetchError } = await supabase
        .from('channel_categories')
        .select('order')
        .eq('server_id', serverId)
        .order('order', { ascending: false })
        .limit(1);

      if (fetchError) {
        debug.error('Error fetching existing categories for ordering in fallback:', fetchError);
        // Continue with default order if fetch fails
      }

      // Calculate the next order value (highest + 1, or 0 if no categories exist)
      const nextOrder = existingCategories && existingCategories.length > 0 
        ? (existingCategories[0].order || 0) + 1 
        : 0;

      const { data, error } = await supabase
        .from('channel_categories')
        .insert([{ name, server_id: serverId, order: nextOrder }])
        .select()
        .single();

      if (error) {
        debug.error('Error creating category in fallback:', error);
        throw error;
      }

      // Check if realtime subscription already added this category (race condition prevention)
      if (!this.categories.some(c => c.id === data.id)) {
        this.categories.push(data);
        this.categories.sort((a, b) => (a.order || 0) - (b.order || 0));
        if (!this.categoryChannels[data.id]) {
          this.categoryChannels[data.id] = [];
        }
      } else {
        debug.log('⚠️ Category already added by realtime in fallback, skipping duplicate push');
      }
      return data;
    },

    async fetchChannels(serverId: string) {
      try {
        debug.log('🔄 Fetching channels via service-like helper:', serverId)
        
        // Use service-like helper for channel fetching
        const channels = await this._fetchChannelsHelper(serverId)
        
        if (channels) {
          this.channels = channels
          debug.log('✅ Channels fetched successfully via service-like helper:', channels.length)
        }
      } catch (error) {
        debug.error('❌ Failed to fetch channels via service-like helper:', error)
        
        // Fallback to direct fetching if helper fails
        try {
          debug.log('🔄 Falling back to direct channel fetching')
          await this._fetchChannelsFallback(serverId)
        } catch (fallbackError) {
          debug.error('❌ Fallback channel fetching also failed:', fallbackError)
          throw fallbackError
        }
      }
    },

    /**
     * Service-like helper: Fetch channels for a server
     */
    async _fetchChannelsHelper(serverId: string): Promise<Channel[]> {
      const { data, error } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId)

      if (error) {
        throw new Error(`Channel fetching failed: ${error.message}`)
      }

      return data || []
    },

    /**
     * Fallback method for fetching channels
     */
    async _fetchChannelsFallback(serverId: string): Promise<void> {
      const { data, error } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId)

      if (error) {
        debug.error('Error fetching channels in fallback:', error)
        return
      }
      this.channels = data
    },

    async createServer(serverData: { name: string; description?: string; public?: boolean; owner: string }) {
      try {
        debug.log('🔄 Creating server via service-like helper:', serverData.name)
        
        // Use service-like helper for server creation with user membership
        const newServer = await this._createServerHelper(serverData)
        
        debug.log('✅ Server created successfully via service-like helper:', newServer.id)
        return newServer
      } catch (error) {
        debug.error('❌ Failed to create server via service-like helper:', error)
        
        // Fallback to direct creation if helper fails
        try {
          debug.log('🔄 Falling back to direct server creation')
          return await this._createServerFallback(serverData)
        } catch (fallbackError) {
          debug.error('❌ Fallback server creation also failed:', fallbackError)
          throw fallbackError
        }
      }
    },

    /**
     * Service-like helper: Create server with user membership and local state
     */
    async _createServerHelper(serverData: { name: string; description?: string; public?: boolean; owner: string }) {
      const { data, error } = await supabase
        .from('servers')
        .insert([{
          name: serverData.name,
          description: serverData.description || null,
          public: serverData.public || false,
          owner: serverData.owner
        }])
        .select()
        .single()

      if (error) {
        throw new Error(`Server creation failed: ${error.message}`)
      }

      // Add server to local state before addUserToServer so the realtime
      // handler (_handleUserServerJoin) sees it and skips the duplicate push.
      if (!this.servers.some(s => s.id === data.id)) {
        this.servers.push(data)
      }

      // Add the new server to the user's server list
      await this.addUserToServer(data.id, serverData.owner)
      
      return data
    },

    /**
     * Fallback method for creating server
     */
    async _createServerFallback(serverData: { name: string; description?: string; public?: boolean; owner: string }) {
      const { data, error } = await supabase
        .from('servers')
        .insert([{
          name: serverData.name,
          description: serverData.description || null,
          public: serverData.public || false,
          owner: serverData.owner
        }])
        .select()
        .single()

      if (error) {
        debug.error('Error creating server in fallback:', error)
        throw error
      }

      // Add server to local state before addUserToServer so the realtime
      // handler (_handleUserServerJoin) sees it and skips the duplicate push.
      if (!this.servers.some(s => s.id === data.id)) {
        this.servers.push(data)
      }

      // Add the new server to the user's server list
      await this.addUserToServer(data.id, serverData.owner)
      
      debug.log('✅ Server created successfully with default structure:', data)
      return data
    },

    async addUserToServer(serverId: string, userId: string) {
      try {
        debug.log('🔄 Adding user to server via service-like helper:', { serverId, userId })
        
        // Use service-like helper for user-server membership
        await this._addUserToServerHelper(serverId, userId)
        
        debug.log('✅ User added to server successfully via service-like helper')
      } catch (error) {
        debug.error('❌ Failed to add user to server via service-like helper:', error)
        
        // Fallback to direct addition if helper fails
        try {
          debug.log('🔄 Falling back to direct user-server addition')
          await this._addUserToServerFallback(serverId, userId)
        } catch (fallbackError) {
          debug.error('❌ Fallback user-server addition also failed:', fallbackError)
          throw fallbackError
        }
      }
    },

    /**
     * Service-like helper: Add user to server with duplicate handling
     */
    async _addUserToServerHelper(serverId: string, userId: string): Promise<void> {
      const { error } = await supabase
        .from('user_servers')
        .insert([{ server_id: serverId, user_id: userId }])

      if (error) {
        // Handle duplicate membership gracefully
        if (error.code === '23505') { // Unique constraint violation
          debug.log("User is already a member of this server")
          return // Consider it successful since the desired state is achieved
        }
        throw new Error(`Adding user to server failed: ${error.message}`)
      }
    },

    /**
     * Fallback method for adding user to server
     */
    async _addUserToServerFallback(serverId: string, userId: string): Promise<void> {
      const toast = useToast()
      
      const { error } = await supabase
        .from('user_servers')
        .insert([{ server_id: serverId, user_id: userId }])

      if (error) {
        // Handle duplicate membership gracefully
        if (error.code === '23505') { // Unique constraint violation
          debug.log("User is already a member of this server")
          // Don't show a toast here since this is typically called internally
          return // Consider it successful since the desired state is achieved
        }
        debug.error('Error adding user to server:', error)
        toast.error("Failed to add user to server")
        throw error
      }
    },

    async updateServer(serverData: { id: string; icon?: string; name?: string; description?: string; public?: boolean }) {
      try {
        debug.log('🔄 Updating server via service-like helper:', serverData.id);
        
        // Use service-like helper for server update
        const updatedServer = await this._updateServerHelper(serverData);
        
        if (updatedServer) {
          // Update local state with optimistic update
          const serverIndex = this.servers.findIndex(server => server.id === serverData.id);
          if (serverIndex !== -1) {
            this.servers[serverIndex] = { ...this.servers[serverIndex], ...updatedServer };
          }
          
          debug.log('✅ Server updated successfully via service-like helper:', updatedServer.id);
          return updatedServer;
        }
        
        throw new Error('Server update returned no data');
      } catch (error) {
        debug.error('❌ Failed to update server via service-like helper:', error);
        
        // Fallback to direct update if helper fails
        try {
          debug.log('🔄 Falling back to direct server update');
          return await this._updateServerFallback(serverData);
        } catch (fallbackError) {
          debug.error('❌ Fallback server update also failed:', fallbackError);
          throw fallbackError;
        }
      }
    },

    /**
     * Service-like helper: Update server with enhanced error handling
     */
    async _updateServerHelper(serverData: { id: string; icon?: string; name?: string; description?: string; public?: boolean }) {
      const updateData: Record<string, any> = {};
      
      // Build update object conditionally
      if (serverData.icon) updateData.icon = serverData.icon;
      if (serverData.name) updateData.name = serverData.name;
      if (serverData.description !== undefined) updateData.description = serverData.description;
      if (serverData.public !== undefined) updateData.public = serverData.public;

      const { data, error } = await supabase
        .from('servers')
        .update(updateData)
        .eq('id', serverData.id)
        .select()
        .single();

      if (error) {
        throw new Error(`Server update failed: ${error.message}`);
      }

      return data;
    },

    /**
     * Fallback method for updating server
     */
    async _updateServerFallback(serverData: { id: string; icon?: string; name?: string; description?: string; public?: boolean }) {
      const { data, error } = await supabase
        .from('servers')
        .update({
          ...(serverData.icon && { icon: serverData.icon }),
          ...(serverData.name && { name: serverData.name }),
          ...(serverData.description !== undefined && { description: serverData.description }),
          ...(serverData.public !== undefined && { public: serverData.public })
        })
        .eq('id', serverData.id)
        .select()
        .single();

      if (error) {
        debug.error('Error updating server in fallback:', error);
        throw error;
      }

      // Update local state
      const serverIndex = this.servers.findIndex(server => server.id === serverData.id);
      if (serverIndex !== -1) {
        this.servers[serverIndex] = { ...this.servers[serverIndex], ...data };
      }

      return data;
    },

    async getCurrentServer() {
      if (this.currentServerId) {
        this.currentServer = this.servers.find(server => server.id === this.currentServerId) || {} as Server;
      }
    },

    // Simplified emoji management - delegate to emoji cache store
    async refreshEmojis() {
      const emojiCache = useEmojiCacheStore();
      const serverIds = this.servers.map(server => server.id);
      await emojiCache.loadEmojisForServers(serverIds);
    },

    getServerDetails(serverId: string): { name?: string; icon?: string } | undefined {
      return this.servers.find(server => server.id === serverId);
    },

    // Enhanced emoji search using cache
    async searchEmojis(query: string, options: { serverId?: string; limit?: number } = {}) {
      const emojiCache = useEmojiCacheStore();
      return emojiCache.searchEmojisByName(query, options.limit);
    },

    // Get emoji by ID using cache
    getEmojiById(emojiId: string) {
      const emojiCache = useEmojiCacheStore();
      return emojiCache.getEmojiById(emojiId);
    },

    // Handle emoji updates (called by real-time subscriptions)
    async handleEmojiUpdate(payload: any) {
      const emojiCache = useEmojiCacheStore();
      await emojiCache.handleEmojiUpdate(payload);
    },

    // Invalidate emoji cache for a server
    async invalidateEmojiCache(serverId?: string) {
      const emojiCache = useEmojiCacheStore();
      if (serverId) {
        await emojiCache.invalidate({ serverId });
      } else {
        // Refresh all servers
        const serverIds = this.servers.map(server => server.id);
        await emojiCache.loadEmojisForServers(serverIds);
      }
    },

    async fetchPublicServers(searchTerm = '', limit = 10) {
      try {
        debug.log('🔄 Fetching public servers via service-like helper:', { searchTerm, limit });
        
        // Use service-like helper for database operations
        const servers = await this._fetchPublicServersHelper(searchTerm, limit);
        this.publicServers = servers || [];
        
        debug.log(`✅ Fetched ${this.publicServers.length} public servers via service-like helper`);
      } catch (error) {
        debug.error('❌ Failed to fetch public servers via service-like helper:', error);
        
        // Fallback to direct query if helper fails
        try {
          debug.log('🔄 Falling back to direct public servers fetch');
          await this._fetchPublicServersFallback(searchTerm, limit);
        } catch (fallbackError) {
          debug.error('❌ Fallback public servers fetch also failed:', fallbackError);
          this.publicServers = []; // Ensure state is clean on total failure
        }
      }
    },

    /**
     * Service-like helper: Fetch public servers with enhanced error handling
     */
    async _fetchPublicServersHelper(searchTerm = '', limit = 10): Promise<Server[]> {
      let query = supabase
        .from('servers')
        .select('*')
        .eq('public', true)
        .limit(limit);

      if (searchTerm.trim()) {
        query = query.ilike('name', `%${searchTerm.trim()}%`);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(`Public servers fetch failed: ${error.message}`);
      }

      return data || [];
    },

    /**
     * Fallback method for fetching public servers
     */
    async _fetchPublicServersFallback(searchTerm = '', limit = 10): Promise<void> {
      let query = supabase
        .from('servers')
        .select('*')
        .eq('public', true)
        .limit(limit);

      if (searchTerm) {
        query = query.ilike('name', `%${searchTerm}%`);
      }

      const { data, error } = await query;

      if (error) {
        debug.error('Error in fallback public servers fetch:', error);
        throw error;
      }

      this.publicServers = data || [];
    },

    async deleteChannel(channelId: string): Promise<void> {
      try {
        debug.log('🔄 Deleting channel via service-like helper:', channelId);
        
        // Use service-like helper for channel deletion
        await this._deleteChannelHelper(channelId);
        
        // Handle complex local state cleanup using service-like helper
        this._removeChannelFromLocalState(channelId);
        
        debug.log('✅ Channel deleted successfully via service-like helper:', channelId);
      } catch (error) {
        debug.error('❌ Failed to delete channel via service-like helper:', error);
        
        // Fallback to direct deletion if helper fails
        try {
          debug.log('🔄 Falling back to direct channel deletion');
          await this._deleteChannelFallback(channelId);
        } catch (fallbackError) {
          debug.error('❌ Fallback channel deletion also failed:', fallbackError);
          throw fallbackError;
        }
      }
    },

    /**
     * Service-like helper: Delete channel with enhanced error handling
     */
    async _deleteChannelHelper(channelId: string): Promise<void> {
      const { error } = await supabase
        .from('channels')
        .delete()
        .eq('id', channelId);

      if (error) {
        throw new Error(`Channel deletion failed: ${error.message}`);
      }
    },

    /**
     * Service-like helper: Remove channel from complex local state
     */
    _removeChannelFromLocalState(channelId: string): void {
      // Remove channel from local state
      this.channels = this.channels.filter(channel => channel.id !== channelId);
      
      // Remove from category channels if it was in a category
      Object.keys(this.categoryChannels).forEach(categoryId => {
        this.categoryChannels[categoryId] = this.categoryChannels[categoryId].filter(
          channel => channel.id !== channelId
        );
      });

      // If this was the current channel, navigate to another channel
      // Use router.push to ensure the URL changes and ChatView reloads
      if (this.currentChannelId === channelId) {
        const defaultChannel = this.getDefaultChannel();
        if (defaultChannel && this.currentServerId) {
          this.setCurrentChannel(defaultChannel);
          // Navigate via router to trigger ChatView's route-based loading
          router.push(`/chat/${this.currentServerId}/${defaultChannel}`).catch(debug.error);
          debug.log('🔄 Navigated to default channel after deletion:', defaultChannel);
        } else {
          this.currentChannelId = null;
          // Navigate to server root if no channels available
          if (this.currentServerId) {
            router.push(`/chat/${this.currentServerId}`).catch(debug.error);
          }
        }
      }
    },

    /**
     * Fallback method for deleting channel
     */
    async _deleteChannelFallback(channelId: string): Promise<void> {
      const { error } = await supabase
        .from('channels')
        .delete()
        .eq('id', channelId);

      if (error) {
        debug.error('Error deleting channel in fallback:', error);
        throw error;
      }

      // Handle complex local state cleanup using reusable helper
      this._removeChannelFromLocalState(channelId);
    },

    /**
     * Delete a category
     * @param categoryId - The category to delete
     * @param deleteChannels - If true, cascade delete all channels. If false (default), make them orphans.
     */
    async deleteCategory(categoryId: string, deleteChannels: boolean = false): Promise<void> {
      try {
        debug.log('🔄 Deleting category via service-like helper:', categoryId, { deleteChannels });
        
        // Get channels that need to be handled
        const channelsInCategory = this.categoryChannels[categoryId] || [];
        
        // Use service-like helper for complex category deletion
        await this._deleteCategoryHelper(categoryId, channelsInCategory, deleteChannels);
        
        // Handle complex local state cleanup using service-like helper
        this._removeCategoryFromLocalState(categoryId, channelsInCategory, deleteChannels);
        
        debug.log('✅ Category deleted successfully via service-like helper:', categoryId);
      } catch (error) {
        debug.error('❌ Failed to delete category via service-like helper:', error);
        
        // Fallback to direct deletion if helper fails
        try {
          debug.log('🔄 Falling back to direct category deletion');
          await this._deleteCategoryFallback(categoryId, deleteChannels);
        } catch (fallbackError) {
          debug.error('❌ Fallback category deletion also failed:', fallbackError);
          throw fallbackError;
        }
      }
    },

    /**
     * Service-like helper: Delete category with proper channel handling
     * @param deleteChannels - If true, cascade delete all channels. If false, make them orphans.
     */
    async _deleteCategoryHelper(categoryId: string, channelsInCategory: Channel[], deleteChannels: boolean = false): Promise<void> {
      if (channelsInCategory.length > 0) {
        if (deleteChannels) {
          // Cascade delete: remove all channels in the category
          const { error: deleteError } = await supabase
            .from('channels')
            .delete()
            .in('id', channelsInCategory.map(channel => channel.id));

          if (deleteError) {
            throw new Error(`Error deleting channels: ${deleteError.message}`);
          }
          debug.log(`🗑️ Deleted ${channelsInCategory.length} channels from category`);
        } else {
          // Make channels orphans - NOTE: column is 'category', NOT 'category_id'
          const { error: updateError } = await supabase
            .from('channels')
            .update({ category: null })
            .in('id', channelsInCategory.map(channel => channel.id));

          if (updateError) {
            throw new Error(`Error moving channels to orphans: ${updateError.message}`);
          }
          debug.log(`📦 Moved ${channelsInCategory.length} channels to orphans`);
        }
      }

      // Then delete the category
      const { error } = await supabase
        .from('channel_categories')
        .delete()
        .eq('id', categoryId);

      if (error) {
        throw new Error(`Category deletion failed: ${error.message}`);
      }
    },

    /**
     * Service-like helper: Remove category from complex local state
     * @param deleteChannels - If true, remove channels from state. If false, make them orphans.
     */
    _removeCategoryFromLocalState(categoryId: string, channelsInCategory: Channel[], deleteChannels: boolean = false): void {
      // Update local state
      this.categories = this.categories.filter(cat => cat.id !== categoryId);
      
      if (deleteChannels) {
        // Remove deleted channels from local state
        const channelIds = new Set(channelsInCategory.map(c => c.id));
        this.channels = this.channels.filter(c => !channelIds.has(c.id));
      } else {
        // Move channels to orphans in local state
        if (channelsInCategory.length > 0) {
          channelsInCategory.forEach(channel => {
            channel.category = null;
          });
        }
      }
      
      // Remove category from categoryChannels
      delete this.categoryChannels[categoryId];
    },

    /**
     * Fallback method for deleting category
     * @param deleteChannels - If true, cascade delete channels. If false, orphan them.
     */
    async _deleteCategoryFallback(categoryId: string, deleteChannels: boolean = false): Promise<void> {
      // Get channels that need to be handled
      const channelsInCategory = this.categoryChannels[categoryId] || [];
      
      if (channelsInCategory.length > 0) {
        if (deleteChannels) {
          // Cascade delete channels
          const { error: deleteError } = await supabase
            .from('channels')
            .delete()
            .in('id', channelsInCategory.map(channel => channel.id));

          if (deleteError) {
            debug.error('Error deleting channels in fallback:', deleteError);
            throw deleteError;
          }
        } else {
          // Move channels to orphans - NOTE: column is 'category', NOT 'category_id'
          const { error: updateError } = await supabase
            .from('channels')
            .update({ category: null })
            .in('id', channelsInCategory.map(channel => channel.id));

          if (updateError) {
            debug.error('Error moving channels to orphans in fallback:', updateError);
            throw updateError;
          }
        }
      }

      // Then delete the category
      const { error } = await supabase
        .from('channel_categories')
        .delete()
        .eq('id', categoryId);

      if (error) {
        debug.error('Error deleting category in fallback:', error);
        throw error;
      }

      // Handle complex local state cleanup using reusable helper
      this._removeCategoryFromLocalState(categoryId, channelsInCategory, deleteChannels);
    },

    async updateChannel(channelData: { id: string; name?: string; description?: string }): Promise<void> {
      try {
        debug.log('🔄 Updating channel via service-like helper:', channelData.id);
        
        // Use service-like helper for channel update
        const updatedChannel = await this._updateChannelHelper(channelData);
        
        if (updatedChannel) {
          // Update complex local state using service-like helper
          this._updateChannelInLocalState(updatedChannel);
          
          debug.log('✅ Channel updated successfully via service-like helper:', channelData.id);
        }
      } catch (error) {
        debug.error('❌ Failed to update channel via service-like helper:', error);
        
        // Fallback to direct update if helper fails
        try {
          debug.log('🔄 Falling back to direct channel update');
          await this._updateChannelFallback(channelData);
        } catch (fallbackError) {
          debug.error('❌ Fallback channel update also failed:', fallbackError);
          throw fallbackError;
        }
      }
    },

    /**
     * Service-like helper: Update channel with enhanced error handling
     */
    async _updateChannelHelper(channelData: { id: string; name?: string; description?: string }) {
      const updateData: any = {};
      if (channelData.name !== undefined) updateData.name = channelData.name;
      if (channelData.description !== undefined) updateData.description = channelData.description;

      const { data, error } = await supabase
        .from('channels')
        .update(updateData)
        .eq('id', channelData.id)
        .select()
        .single();

      if (error) {
        throw new Error(`Channel update failed: ${error.message}`);
      }

      return data;
    },

    /**
     * Service-like helper: Update channel in complex local state
     */
    _updateChannelInLocalState(updatedChannel: Channel) {
      // Update local state in main channels array
      const channelIndex = this.channels.findIndex(channel => channel.id === updatedChannel.id);
      if (channelIndex !== -1) {
        this.channels[channelIndex] = { ...this.channels[channelIndex], ...updatedChannel };
      }

      // Update in category channels if it exists
      Object.keys(this.categoryChannels).forEach(categoryId => {
        const categoryChannelIndex = this.categoryChannels[categoryId].findIndex(
          channel => channel.id === updatedChannel.id
        );
        if (categoryChannelIndex !== -1) {
          this.categoryChannels[categoryId][categoryChannelIndex] = {
            ...this.categoryChannels[categoryId][categoryChannelIndex],
            ...updatedChannel
          };
        }
      });
    },

    /**
     * Fallback method for updating channel
     */
    async _updateChannelFallback(channelData: { id: string; name?: string; description?: string }): Promise<void> {
      const updateData: any = {};
      if (channelData.name !== undefined) updateData.name = channelData.name;
      if (channelData.description !== undefined) updateData.description = channelData.description;

      const { data, error } = await supabase
        .from('channels')
        .update(updateData)
        .eq('id', channelData.id)
        .select()
        .single();

      if (error) {
        debug.error('Error updating channel in fallback:', error);
        throw error;
      }

      // Update complex local state using reusable helper
      this._updateChannelInLocalState(data);
    },

    async updateCategory(categoryData: { id: string; name: string }): Promise<void> {
      try {
        debug.log('🔄 Updating category via service-like helper:', categoryData.id);
        
        // Use service-like helper for category update
        const updatedCategory = await this._updateCategoryHelper(categoryData);
        
        if (updatedCategory) {
          // Update local state
          const categoryIndex = this.categories.findIndex(category => category.id === categoryData.id);
          if (categoryIndex !== -1) {
            this.categories[categoryIndex] = { ...this.categories[categoryIndex], ...updatedCategory };
          }
          
          debug.log('✅ Category updated successfully via service-like helper:', categoryData.id);
        }
      } catch (error) {
        debug.error('❌ Failed to update category via service-like helper:', error);
        
        // Fallback to direct update if helper fails
        try {
          debug.log('🔄 Falling back to direct category update');
          await this._updateCategoryFallback(categoryData);
        } catch (fallbackError) {
          debug.error('❌ Fallback category update also failed:', fallbackError);
          throw fallbackError;
        }
      }
    },

    /**
     * Service-like helper: Update category with enhanced error handling
     */
    async _updateCategoryHelper(categoryData: { id: string; name: string }) {
      const { data, error } = await supabase
        .from('channel_categories')
        .update({ name: categoryData.name })
        .eq('id', categoryData.id)
        .select()
        .single();

      if (error) {
        throw new Error(`Category update failed: ${error.message}`);
      }

      return data;
    },

    /**
     * Fallback method for updating category
     */
    async _updateCategoryFallback(categoryData: { id: string; name: string }): Promise<void> {
      const { data, error } = await supabase
        .from('channel_categories')
        .update({ name: categoryData.name })
        .eq('id', categoryData.id)
        .select()
        .single();

      if (error) {
        debug.error('Error updating category in fallback:', error);
        throw error;
      }

      // Update local state
      const categoryIndex = this.categories.findIndex(category => category.id === categoryData.id);
      if (categoryIndex !== -1) {
        this.categories[categoryIndex] = { ...this.categories[categoryIndex], ...data };
      }
    },

    // =====================================================
    // REAL-TIME SUBSCRIPTIONS
    // =====================================================

    /**
     * Subscribe to real-time updates for server structure (channels & categories)
     * Call this when entering a server to get live updates
     */
    async subscribeToServerStructure(serverId: string): Promise<void> {
      // Unsubscribe from previous server if any
      await this.unsubscribeFromServerStructure();
      
      debug.log('🔔 Subscribing to server structure updates for:', serverId);
      
      this.serverStructureSubscription = supabase
        .channel(`server-structure:${serverId}`, { config: { private: true } })
        .on('broadcast', { event: 'server_event' }, async (payload) => {
          const data = payload.payload ?? payload;
          const type = data?.type as string;
          if (!type) return;

          switch (type) {
            case 'channel:insert':
              this._handleChannelInsert(data);
              break;
            case 'channel:update':
              this._handleChannelUpdate(data);
              break;
            case 'channel:delete':
              this._handleChannelDelete(data);
              break;
            case 'category:insert':
              this._handleCategoryInsert(data);
              break;
            case 'category:update':
              this._handleCategoryUpdate(data);
              break;
            case 'category:delete':
              this._handleCategoryDelete(data);
              break;
            case 'membership:event': {
              const { getMembershipService } = await import('@/services/membershipService');
              getMembershipService().handleBroadcastEvent(data.new);
              break;
            }
            case 'thread:insert':
            case 'thread:update':
            case 'thread:delete':
              window.dispatchEvent(new CustomEvent('server-structure:thread-change', { detail: data }));
              break;
            case 'settings:insert':
            case 'settings:update':
              window.dispatchEvent(new CustomEvent('server-structure:settings-change', { detail: data }));
              break;
            case 'role:insert':
            case 'role:update':
            case 'role:delete':
              window.dispatchEvent(new CustomEvent('server-structure:role-change', { detail: data }));
              break;
            case 'user_role:insert':
            case 'user_role:delete':
              window.dispatchEvent(new CustomEvent('server-structure:user-role-change', { detail: data }));
              break;
            case 'permission_override:insert':
            case 'permission_override:update':
            case 'permission_override:delete':
              window.dispatchEvent(new CustomEvent('server-structure:permission-change', { detail: data }));
              break;
          }
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            console.log(`[Realtime] server-structure:${serverId} → SUBSCRIBED`);
          } else if (status === 'CHANNEL_ERROR') {
            console.error(`[Realtime] server-structure:${serverId} → CHANNEL_ERROR`);
          } else {
            console.log(`[Realtime] server-structure:${serverId} →`, status);
          }
        });
    },

    /**
     * Unsubscribe from server structure updates
     */
    async unsubscribeFromServerStructure(): Promise<void> {
      if (this.serverStructureSubscription) {
        debug.log('🔕 Unsubscribing from server structure updates');
        await this.serverStructureSubscription.unsubscribe();
        this.serverStructureSubscription = null;
      }
    },

    /**
     * Handle real-time channel INSERT
     */
    _handleChannelInsert(payload: any): void {
      const newChannel = payload.new as Channel;
      debug.log('📥 Real-time: Channel created:', newChannel.name);
      
      // Check if channel already exists (avoid duplicates)
      if (this.channels.some(c => c.id === newChannel.id)) {
        debug.log('⚠️ Channel already exists, skipping duplicate');
        return;
      }
      
      // Add to channels array
      this.channels.push(newChannel);
      
      // Add to categoryChannels if it has a category
      if (newChannel.category) {
        if (!this.categoryChannels[newChannel.category]) {
          this.categoryChannels[newChannel.category] = [];
        }
        this.categoryChannels[newChannel.category].push(newChannel);
        // Sort by order
        this.categoryChannels[newChannel.category].sort((a, b) => (a.order || 0) - (b.order || 0));
      }
    },

    /**
     * Handle real-time channel UPDATE
     */
    _handleChannelUpdate(payload: any): void {
      const updatedChannel = payload.new as Channel;
      const oldChannel = payload.old as Channel;
      debug.log('📝 Real-time: Channel updated:', updatedChannel.name);
      
      // Update in channels array
      const channelIndex = this.channels.findIndex(c => c.id === updatedChannel.id);
      if (channelIndex !== -1) {
        this.channels[channelIndex] = { ...this.channels[channelIndex], ...updatedChannel };
      }
      
      // Handle category change
      if (oldChannel.category !== updatedChannel.category) {
        // Remove from old category
        if (oldChannel.category && this.categoryChannels[oldChannel.category]) {
          this.categoryChannels[oldChannel.category] = this.categoryChannels[oldChannel.category].filter(
            c => c.id !== updatedChannel.id
          );
        }
        
        // Add to new category
        if (updatedChannel.category) {
          if (!this.categoryChannels[updatedChannel.category]) {
            this.categoryChannels[updatedChannel.category] = [];
          }
          this.categoryChannels[updatedChannel.category].push(updatedChannel);
          this.categoryChannels[updatedChannel.category].sort((a, b) => (a.order || 0) - (b.order || 0));
        }
      } else if (updatedChannel.category) {
        // Update within same category
        const catChannelIndex = this.categoryChannels[updatedChannel.category]?.findIndex(
          c => c.id === updatedChannel.id
        );
        if (catChannelIndex !== undefined && catChannelIndex !== -1) {
          this.categoryChannels[updatedChannel.category][catChannelIndex] = {
            ...this.categoryChannels[updatedChannel.category][catChannelIndex],
            ...updatedChannel
          };
          // Re-sort in case order changed
          this.categoryChannels[updatedChannel.category].sort((a, b) => (a.order || 0) - (b.order || 0));
        }
      }
    },

    /**
     * Handle real-time channel DELETE
     */
    _handleChannelDelete(payload: any): void {
      const deletedChannel = payload.old as Channel;
      debug.log('🗑️ Real-time: Channel deleted:', deletedChannel.id);
      
      // Remove from channels array
      this.channels = this.channels.filter(c => c.id !== deletedChannel.id);
      
      // Remove from categoryChannels
      if (deletedChannel.category && this.categoryChannels[deletedChannel.category]) {
        this.categoryChannels[deletedChannel.category] = this.categoryChannels[deletedChannel.category].filter(
          c => c.id !== deletedChannel.id
        );
      }
      
      // If this was the current channel, navigate to another
      // Use router.push to ensure the URL changes and ChatView reloads
      if (this.currentChannelId === deletedChannel.id) {
        const defaultChannel = this.getDefaultChannel();
        if (defaultChannel && this.currentServerId) {
          this.setCurrentChannel(defaultChannel);
          router.push(`/chat/${this.currentServerId}/${defaultChannel}`).catch(debug.error);
          debug.log('🔄 Navigated to default channel after real-time deletion:', defaultChannel);
        } else {
          this.currentChannelId = null;
          if (this.currentServerId) {
            router.push(`/chat/${this.currentServerId}`).catch(debug.error);
          }
        }
      }
    },

    /**
     * Handle real-time category INSERT
     */
    _handleCategoryInsert(payload: any): void {
      const newCategory = payload.new as Category;
      debug.log('📥 Real-time: Category created:', newCategory.name);
      
      // Check if category already exists
      if (this.categories.some(c => c.id === newCategory.id)) {
        debug.log('⚠️ Category already exists, skipping duplicate');
        return;
      }
      
      // Add to categories array
      this.categories.push(newCategory);
      // Sort by order
      this.categories.sort((a, b) => (a.order || 0) - (b.order || 0));
      
      // Initialize empty channel array for this category
      this.categoryChannels[newCategory.id] = [];
    },

    /**
     * Handle real-time category UPDATE
     */
    _handleCategoryUpdate(payload: any): void {
      const updatedCategory = payload.new as Category;
      debug.log('📝 Real-time: Category updated:', updatedCategory.name);
      
      // Update in categories array
      const categoryIndex = this.categories.findIndex(c => c.id === updatedCategory.id);
      if (categoryIndex !== -1) {
        this.categories[categoryIndex] = { ...this.categories[categoryIndex], ...updatedCategory };
        // Re-sort in case order changed
        this.categories.sort((a, b) => (a.order || 0) - (b.order || 0));
      }
    },

    /**
     * Handle real-time category DELETE
     */
    _handleCategoryDelete(payload: any): void {
      const deletedCategory = payload.old as Category;
      debug.log('🗑️ Real-time: Category deleted:', deletedCategory.id);
      
      // Remove from categories array
      this.categories = this.categories.filter(c => c.id !== deletedCategory.id);
      
      // Move channels from this category to orphans (no category)
      const orphanedChannels = this.categoryChannels[deletedCategory.id] || [];
      orphanedChannels.forEach(channel => {
        channel.category = null;
      });
      
      // Remove category from categoryChannels
      delete this.categoryChannels[deletedCategory.id];
    },

    /**
     * Subscribe to user's server list changes via the shared UserEventChannel.
     * DB triggers broadcast server:joined, server:left, server:updated events
     * to user:{profileId}, eliminating a dedicated postgres_changes channel.
     */
    async subscribeToUserServers(userId: string): Promise<void> {
      await this.unsubscribeFromUserServers();

      this.currentUserId = userId;
      debug.log('🔔 Subscribing to user server list updates via broadcast');

      const ctx = await authContextService.getCurrentContext();
      if (!ctx.isAuthenticated) return;

      userEventChannel.connect(ctx.profileId);

      this._userServerBroadcastUnsubs = [
        userEventChannel.on('server:joined', (data) => {
          this._handleUserServerJoin({ new: { server_id: data.server_id, user_id: data.user_id } });
        }),
        userEventChannel.on('server:left', (data) => {
          this._handleUserServerLeave({ old: { server_id: data.server_id, user_id: data.user_id } });
        }),
        userEventChannel.on('server:updated', (data) => {
          this._handleServerUpdate({ new: data.server });
        }),
      ];
    },

    /**
     * Unsubscribe from user server list broadcast handlers
     */
    async unsubscribeFromUserServers(): Promise<void> {
      if (this._userServerBroadcastUnsubs.length > 0) {
        debug.log('🔕 Unsubscribing from user server broadcast handlers');
        this._userServerBroadcastUnsubs.forEach(fn => fn());
        this._userServerBroadcastUnsubs = [];
      }
      // Legacy cleanup
      if (this.userServersSubscription) {
        await this.userServersSubscription.unsubscribe();
        this.userServersSubscription = null;
      }
    },

    /**
     * Handle user joining a server (real-time)
     */
    async _handleUserServerJoin(payload: any): Promise<void> {
      const serverId = payload.new.server_id;
      debug.log('📥 Real-time: User joined server:', serverId);
      
      // Check if server already in list (may have been added by createServer)
      if (this.servers.some(s => s.id === serverId)) {
        debug.log('⚠️ Server already in list, skipping duplicate');
        return;
      }
      
      // Fetch server details
      try {
        const { data: server, error } = await supabase
          .from('servers')
          .select('*')
          .eq('id', serverId)
          .single();
        
        if (error) {
          debug.error('Error fetching joined server:', error);
          return;
        }
        
        if (server) {
          // Re-check after async fetch to guard against race conditions
          if (!this.servers.some(s => s.id === serverId)) {
            this.servers.push(server);
            debug.log('✅ Server added to list:', server.name);
          } else {
            debug.log('⚠️ Server was added while fetching, skipping duplicate');
          }
        }
      } catch (error) {
        debug.error('Error handling server join:', error);
      }
    },

    /**
     * Handle user leaving a server (real-time)
     */
    _handleUserServerLeave(payload: any): void {
      const serverId = payload.old.server_id;
      debug.log('📤 Real-time: User left server:', serverId);
      
      this._cleanupServerState(serverId);
    },

    /**
     * Clean up all client state associated with a server.
     * Disconnects voice chat, unsubscribes from messages, and switches
     * the active server if the left server was the current one.
     */
    _cleanupServerState(serverId: string): void {
      // Disconnect from voice chat if connected to a channel on this server
      const voiceStore = useUnifiedVoiceChannelStore();
      const voiceServerId = voiceStore.effectiveServerId;
      if (voiceServerId === serverId) {
        debug.log('🔇 Disconnecting voice chat for left server:', serverId);
        voiceStore.leaveVoiceChannel();
      }
      
      // Unsubscribe from message channel if viewing a channel on this server
      if (this.currentServerId === serverId) {
        const chatStore = useChatStore();
        chatStore.unsubscribeFromMessages();
        chatStore.clearMessages();
      }
      
      // Remove server from list
      this.servers = this.servers.filter(s => s.id !== serverId);
      
      // If this was the current server, switch to another
      if (this.currentServerId === serverId) {
        if (this.servers.length > 0) {
          this.setCurrentServer(this.servers[0].id);
        } else {
          this.currentServerId = null;
          this.currentServer = {} as Server;
          this.currentChannelId = null;
          this.channels = [];
          this.categories = [];
          this.categoryChannels = {};
        }
      }
    },

    /**
     * Handle server update (name, icon, description, etc.) - real-time
     */
    _handleServerUpdate(payload: any): void {
      const updatedServer = payload.new as Server;
      debug.log('📝 Real-time: Server updated:', updatedServer.id, updatedServer.name);
      
      // Only update if this server is in the user's list
      const serverIndex = this.servers.findIndex(s => s.id === updatedServer.id);
      if (serverIndex === -1) {
        // Server not in user's list, ignore
        return;
      }
      
      // Update server in the list
      this.servers[serverIndex] = { ...this.servers[serverIndex], ...updatedServer };
      debug.log('✅ Server updated in list:', updatedServer.name);
      
      // If this is the current server, also update currentServer
      if (this.currentServerId === updatedServer.id) {
        this.currentServer = { ...this.currentServer, ...updatedServer };
        debug.log('✅ Current server updated:', updatedServer.name);
      }
    },

    /**
     * Handle server deletion - real-time
     */
    _handleServerDelete(payload: any): void {
      const deletedServer = payload.old as Server;
      debug.log('🗑️ Real-time: Server deleted:', deletedServer.id);
      
      // Check if this server is in the user's list
      const serverExists = this.servers.some(s => s.id === deletedServer.id);
      if (!serverExists) {
        // Server not in user's list, ignore
        return;
      }
      
      // Remove server from list
      this.servers = this.servers.filter(s => s.id !== deletedServer.id);
      debug.log('✅ Deleted server removed from list:', deletedServer.name || deletedServer.id);
      
      // If this was the current server, switch to another
      if (this.currentServerId === deletedServer.id) {
        const toast = useToast();
        toast.info(`Server "${deletedServer.name || 'Unknown'}" has been deleted`);
        
        if (this.servers.length > 0) {
          this.setCurrentServer(this.servers[0].id);
        } else {
          this.currentServerId = null;
          this.currentServer = {} as Server;
          this.channels = [];
          this.categories = [];
          this.categoryChannels = {};
        }
      }
    },

    /**
     * Cleanup all subscriptions
     */
    async cleanupSubscriptions(): Promise<void> {
      await this.unsubscribeFromServerStructure();
      await this.unsubscribeFromUserServers();
    },

    // =============================================
    // SERVER FOLDER MANAGEMENT
    // =============================================

    /**
     * Fetch all folders for a user
     */
    async fetchFolders(userId: string): Promise<void> {
      try {
        debug.log('📁 Fetching folders for user:', userId);
        
        const { data, error } = await supabase
          .from('server_folders')
          .select('*')
          .eq('user_id', userId)
          .order('position', { ascending: true });

        if (error) {
          debug.error('❌ Error fetching folders:', error);
          return;
        }

        this.folders = data || [];
        debug.log(`✅ Fetched ${this.folders.length} folders`);
      } catch (error) {
        debug.error('❌ Failed to fetch folders:', error);
      }
    },

    /**
     * Create a new folder
     */
    async createFolder(name: string = '', color: string = '#0EA5E9', position?: number): Promise<ServerFolder | null> {
      if (!this.currentUserId) {
        debug.error('❌ Cannot create folder: no current user');
        return null;
      }

      try {
        debug.log('📁 Creating folder:', name || '(unnamed)');
        
        // Use provided position or get next available
        const folderPosition = position !== undefined 
          ? position 
          : (this.folders.length > 0 
              ? Math.max(...this.folders.map(f => f.position)) + 1 
              : 0);

        const { data, error } = await supabase
          .from('server_folders')
          .insert({
            user_id: this.currentUserId,
            name,
            color,
            position: folderPosition
          })
          .select()
          .single();

        if (error) {
          debug.error('❌ Error creating folder:', error);
          const toast = useToast();
          toast.error('Failed to create folder');
          return null;
        }

        this.folders.push(data);
        this.folders.sort((a, b) => a.position - b.position);
        
        debug.log('✅ Folder created:', data.id);
        return data;
      } catch (error) {
        debug.error('❌ Failed to create folder:', error);
        return null;
      }
    },

    /**
     * Update a folder's name, color, or expanded state
     */
    async updateFolder(folderId: string, updates: Partial<Pick<ServerFolder, 'name' | 'color' | 'is_expanded'>>): Promise<boolean> {
      try {
        debug.log('📁 Updating folder:', folderId, updates);

        const { error } = await supabase
          .from('server_folders')
          .update(updates)
          .eq('id', folderId);

        if (error) {
          debug.error('❌ Error updating folder:', error);
          const toast = useToast();
          toast.error('Failed to update folder');
          return false;
        }

        // Update local state
        const folderIndex = this.folders.findIndex(f => f.id === folderId);
        if (folderIndex !== -1) {
          this.folders[folderIndex] = { ...this.folders[folderIndex], ...updates };
        }

        debug.log('✅ Folder updated');
        return true;
      } catch (error) {
        debug.error('❌ Failed to update folder:', error);
        return false;
      }
    },

    /**
     * Toggle folder expanded/collapsed state
     */
    async toggleFolderExpanded(folderId: string): Promise<void> {
      const folder = this.folders.find(f => f.id === folderId);
      if (!folder) return;

      await this.updateFolder(folderId, { is_expanded: !folder.is_expanded });
    },

    /**
     * Delete a folder (servers in it move to root level)
     */
    async deleteFolder(folderId: string): Promise<boolean> {
      try {
        debug.log('🗑️ Deleting folder:', folderId);

        // First, move all servers in this folder to root level
        const serversInFolder = this.servers.filter(s => s.folder_id === folderId);
        for (const server of serversInFolder) {
          await this.moveServerToFolder(server.id, null);
        }

        const { error } = await supabase
          .from('server_folders')
          .delete()
          .eq('id', folderId);

        if (error) {
          debug.error('❌ Error deleting folder:', error);
          const toast = useToast();
          toast.error('Failed to delete folder');
          return false;
        }

        // Remove from local state
        this.folders = this.folders.filter(f => f.id !== folderId);
        
        debug.log('✅ Folder deleted');
        return true;
      } catch (error) {
        debug.error('❌ Failed to delete folder:', error);
        return false;
      }
    },

    /**
     * Move a server to a folder (or to root if folderId is null)
     * Uses optimistic updates for smooth UX
     */
    async moveServerToFolder(serverId: string, folderId: string | null): Promise<boolean> {
      if (!this.currentUserId) {
        debug.error('❌ Cannot move server: no current user');
        return false;
      }

      debug.log('📁 Moving server to folder:', serverId, folderId);

      // Get next position in target folder/root
      const serversInTarget = this.servers.filter(s => s.folder_id === folderId);
      const maxPosition = serversInTarget.length > 0
        ? Math.max(...serversInTarget.map(s => s.position || 0)) + 1
        : 0;

      // Store previous state for rollback
      const serverIndex = this.servers.findIndex(s => s.id === serverId);
      const previousFolderId = serverIndex !== -1 ? this.servers[serverIndex].folder_id : null;
      const previousPosition = serverIndex !== -1 ? this.servers[serverIndex].position : 0;

      // OPTIMISTIC UPDATE: Update local state immediately
      if (serverIndex !== -1) {
        this.servers[serverIndex].folder_id = folderId;
        this.servers[serverIndex].position = maxPosition;
      }

      try {
        const { error } = await supabase
          .from('user_servers')
          .update({ folder_id: folderId, position: maxPosition })
          .eq('user_id', this.currentUserId)
          .eq('server_id', serverId);

        if (error) {
          debug.error('❌ Error moving server to folder:', error);
          // Rollback optimistic update
          if (serverIndex !== -1) {
            this.servers[serverIndex].folder_id = previousFolderId;
            this.servers[serverIndex].position = previousPosition;
          }
          return false;
        }

        debug.log('✅ Server moved to folder');
        return true;
      } catch (error) {
        debug.error('❌ Failed to move server to folder:', error);
        // Rollback optimistic update
        if (serverIndex !== -1) {
          this.servers[serverIndex].folder_id = previousFolderId;
          this.servers[serverIndex].position = previousPosition;
        }
        return false;
      }
    },

    /**
     * Update positions for servers and folders after drag-drop reorder
     * Uses optimistic updates for smooth UX - local state updates immediately,
     * database updates happen in the background
     */
    async updateServerPositions(positions: { serverId: string; folderId: string | null; position: number }[]): Promise<boolean> {
      if (!this.currentUserId) {
        debug.error('❌ Cannot update positions: no current user');
        return false;
      }

      // Store previous state for rollback on error
      const previousState = positions.map(pos => {
        const server = this.servers.find(s => s.id === pos.serverId);
        return server ? { serverId: pos.serverId, folderId: server.folder_id, position: server.position } : null;
      }).filter(Boolean) as { serverId: string; folderId: string | null; position: number }[];

      // OPTIMISTIC UPDATE: Update local state immediately using requestAnimationFrame for smooth visuals
      requestAnimationFrame(() => {
        for (const pos of positions) {
          const serverIndex = this.servers.findIndex(s => s.id === pos.serverId);
          if (serverIndex !== -1) {
            this.servers[serverIndex].folder_id = pos.folderId;
            this.servers[serverIndex].position = pos.position;
          }
        }
      });

      try {
        debug.log('📁 Updating server positions:', positions.length, 'items');

        // Batch database updates - run in parallel for speed
        const updatePromises = positions.map(pos =>
          supabase
            .from('user_servers')
            .update({ folder_id: pos.folderId, position: pos.position })
            .eq('user_id', this.currentUserId!)
            .eq('server_id', pos.serverId)
        );

        const results = await Promise.all(updatePromises);
        const hasError = results.some(r => r.error);

        if (hasError) {
          debug.error('❌ Error updating server positions, rolling back');
          // Rollback optimistic update
          requestAnimationFrame(() => {
            for (const prev of previousState) {
              const serverIndex = this.servers.findIndex(s => s.id === prev.serverId);
              if (serverIndex !== -1) {
                this.servers[serverIndex].folder_id = prev.folderId;
                this.servers[serverIndex].position = prev.position;
              }
            }
          });
          return false;
        }

        debug.log('✅ Server positions updated');
        return true;
      } catch (error) {
        debug.error('❌ Failed to update server positions:', error);
        // Rollback optimistic update
        requestAnimationFrame(() => {
          for (const prev of previousState) {
            const serverIndex = this.servers.findIndex(s => s.id === prev.serverId);
            if (serverIndex !== -1) {
              this.servers[serverIndex].folder_id = prev.folderId;
              this.servers[serverIndex].position = prev.position;
            }
          }
        });
        return false;
      }
    },

    /**
     * Update folder positions after drag-drop reorder
     * Uses optimistic updates for smooth UX
     */
    async updateFolderPositions(positions: { folderId: string; position: number }[]): Promise<boolean> {
      // Store previous state for rollback on error
      const previousState = positions.map(pos => {
        const folder = this.folders.find(f => f.id === pos.folderId);
        return folder ? { folderId: pos.folderId, position: folder.position } : null;
      }).filter(Boolean) as { folderId: string; position: number }[];

      // OPTIMISTIC UPDATE: Update local state immediately
      requestAnimationFrame(() => {
        for (const pos of positions) {
          const folderIndex = this.folders.findIndex(f => f.id === pos.folderId);
          if (folderIndex !== -1) {
            this.folders[folderIndex].position = pos.position;
          }
        }
        this.folders.sort((a, b) => a.position - b.position);
      });

      try {
        debug.log('📁 Updating folder positions:', positions.length, 'items');

        // Batch database updates - run in parallel for speed
        const updatePromises = positions.map(pos =>
          supabase
            .from('server_folders')
            .update({ position: pos.position })
            .eq('id', pos.folderId)
        );

        const results = await Promise.all(updatePromises);
        const hasError = results.some(r => r.error);

        if (hasError) {
          debug.error('❌ Error updating folder positions, rolling back');
          // Rollback optimistic update
          requestAnimationFrame(() => {
            for (const prev of previousState) {
              const folderIndex = this.folders.findIndex(f => f.id === prev.folderId);
              if (folderIndex !== -1) {
                this.folders[folderIndex].position = prev.position;
              }
            }
            this.folders.sort((a, b) => a.position - b.position);
          });
          return false;
        }

        debug.log('✅ Folder positions updated');
        return true;
      } catch (error) {
        debug.error('❌ Failed to update folder positions:', error);
        // Rollback optimistic update
        requestAnimationFrame(() => {
          for (const prev of previousState) {
            const folderIndex = this.folders.findIndex(f => f.id === prev.folderId);
            if (folderIndex !== -1) {
              this.folders[folderIndex].position = prev.position;
            }
          }
          this.folders.sort((a, b) => a.position - b.position);
        });
        return false;
      }
    },

    /**
     * Get servers organized by folders for sidebar display
     */
    getOrganizedServers(): Array<ServerFolder | Server> {
      const result: Array<ServerFolder | Server> = [];
      
      // Create a map of folder_id to servers
      const serversByFolder = new Map<string | null, Server[]>();
      
      for (const server of this.servers) {
        const folderId = server.folder_id || null;
        if (!serversByFolder.has(folderId)) {
          serversByFolder.set(folderId, []);
        }
        serversByFolder.get(folderId)!.push(server);
      }

      // Sort servers within each folder by position
      for (const servers of serversByFolder.values()) {
        servers.sort((a, b) => (a.position || 0) - (b.position || 0));
      }

      // Build result: folders (with their servers) and root-level servers
      // sorted by position
      const foldersWithServers = this.folders.map(folder => ({
        ...folder,
        servers: serversByFolder.get(folder.id) || []
      }));

      const rootServers = serversByFolder.get(null) || [];

      // Combine and sort by position
      // Folders and root servers are interleaved based on position
      // For simplicity, we'll put all folders first, then root servers
      // A more complex implementation would interleave by position
      result.push(...foldersWithServers);
      result.push(...rootServers);

      return result;
    },
  }
});