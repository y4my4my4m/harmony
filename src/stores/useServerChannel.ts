import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import { useToast } from 'vue-toastification';
import type { Server, Category, Channel, ResolvedEmoji } from '@/types';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { statePersistence } from '@/services/StatePersistence';

export const useServerChannelStore = defineStore('serverChannel', {
  state: () => ({
    servers: [] as Server[],
    publicServers: [] as Server[],
    channels: [] as Channel[],
    categories: [] as Category[],
    categoryChannels: {} as Record<string, Channel[]>,
    currentServer: {} as Server,
    currentServerId: null as string | null,
    currentChannelId: null as string | null,
    isInitializing: false as boolean,
    hasInitialized: false as boolean,
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
  },

  actions: {
    async initializeUserEnvironment(userId: string): Promise<void> {
      try {
        console.log('🚀 Initializing user environment...');
        this.isInitializing = true;
        
        // Fetch user's servers first
        await this.fetchServersForUser(userId);
        
        // Restore last selected server and channel from persistence
        await this.restorePersistedState();
        
        // Note: Emoji cache is now initialized by RouteAwareInitialization
        // to only load emojis for current server initially
        
        // Mark app as initialized to prevent flash on subsequent loads
        statePersistence.setAppInitialized(true);
        this.hasInitialized = true;
        this.isInitializing = false;
        
        console.log('✅ User environment initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize user environment:', error);
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
        console.log('🔄 Restoring last selected server:', lastServerId);
        this.setCurrentServer(lastServerId);
        
        // Fetch categories and channels for the server first
        await this.fetchCategoriesAndChannels(lastServerId);
        
        // Restore last channel for this server
        const lastChannelId = statePersistence.getLastChannel(lastServerId);
        if (lastChannelId && this.channels.some(channel => channel.id === lastChannelId)) {
          console.log('🔄 Restoring last selected channel:', lastChannelId);
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
        console.log('🔄 No valid last server, selecting first available');
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
      // ✅ SMART CACHING: Prevent setting the same server twice
      if (this.currentServerId === serverId) {
        console.log(`💾 Server ${serverId} already selected, skipping duplicate set`);
        return;
      }
      
      const server = this.servers.find(s => s.id === serverId);
      if (server) {
        this.currentServerId = serverId;
        this.currentServer = server;
        // Persist state asynchronously without blocking
        statePersistence.setLastServer(serverId).catch(console.error);
        console.log('📍 Current server set to:', server.name);
      }
    },

    setCurrentChannel(channelId: string | null): void {
      this.currentChannelId = channelId;
      if (channelId && this.currentServerId) {
        // Persist state asynchronously without blocking
        statePersistence.setLastChannel(this.currentServerId, channelId).catch(console.error);
        const channel = this.channels.find(c => c.id === channelId);
        console.log('📍 Current channel set to:', channel?.name || channelId);
      }
    },

    async fetchServersForUser(userId: string) {
      try {
        console.log('🔄 Fetching servers for user via service-like helper:', userId)
        
        // Use service-like helper for user server fetching
        const servers = await this._fetchServersForUserHelper(userId)
        
        if (servers) {
          this.servers = servers
          console.log(`✅ Servers fetched successfully via service-like helper: ${servers.length} servers`)
        }
      } catch (error) {
        console.error('❌ Failed to fetch servers for user via service-like helper:', error)
        
        // Fallback to direct fetching if helper fails
        try {
          console.log('🔄 Falling back to direct user server fetching')
          await this._fetchServersForUserFallback(userId)
        } catch (fallbackError) {
          console.error('❌ Fallback user server fetching also failed:', fallbackError)
          throw fallbackError
        }
      }
    },

    /**
     * Service-like helper: Fetch servers for a specific user
     */
    async _fetchServersForUserHelper(userId: string): Promise<Server[]> {
      const { data, error } = await supabase
        .from('user_servers')
        .select(`
          server:server_id (
            id,
            name,
            description,
            icon,
            owner,
            allow_cross_server_emojis,
            public
          )
        `)
        .eq('user_id', userId)

      if (error) {
        throw new Error(`User servers fetching failed: ${error.message}`)
      }

      return data?.map((item: any) => item.server).filter(Boolean) || []
    },

    /**
     * Fallback method for fetching servers for user
     */
    async _fetchServersForUserFallback(userId: string): Promise<void> {
      const { data, error } = await supabase
        .from('user_servers')
        .select(`
          server:server_id (
            id,
            name,
            description,
            icon,
            owner,
            allow_cross_server_emojis,
            public
          )
        `)
        .eq('user_id', userId)

      if (error) {
        console.error('Error fetching servers for user in fallback:', error)
        return
      }

      this.servers = data?.map((item: any) => item.server).filter(Boolean) || []
      console.log(`📊 Loaded ${this.servers.length} servers for user`)
    },

    async fetchServers() {
      try {
        console.log('🔄 Fetching all servers via service-like helper');
        
        // Use service-like helper for database operations
        const servers = await this._fetchServersHelper();
        this.servers = servers || [];
        
        console.log(`✅ Fetched ${this.servers.length} servers via service-like helper`);
      } catch (error) {
        console.error('❌ Failed to fetch servers via service-like helper:', error);
        
        // Fallback to direct query if helper fails
        try {
          console.log('🔄 Falling back to direct servers fetch');
          await this._fetchServersFallback();
        } catch (fallbackError) {
          console.error('❌ Fallback servers fetch also failed:', fallbackError);
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
        console.error('Error in fallback servers fetch:', error);
        throw error;
      }
      this.servers = data || [];
    },

    async fetchCategoriesAndChannels(serverId: string, signal?: AbortSignal) {
      try {
        console.log('🔄 Fetching categories and channels via service-like helper:', serverId);
        
        // Use service-like helper with full abort support
        await this._fetchCategoriesAndChannelsHelper(serverId, signal);
        
        console.log(`✅ Fetched ${this.categories?.length || 0} categories and ${this.channels?.length || 0} channels via service-like helper`);
      } catch (error) {
        if (signal?.aborted) {
          console.log('🛑 Categories and channels fetch aborted');
          return;
        }
        
        console.error('❌ Failed to fetch categories and channels via service-like helper:', error);
        
        // Fallback to direct query if helper fails
        try {
          console.log('🔄 Falling back to direct categories and channels fetch');
          await this._fetchCategoriesAndChannelsFallback(serverId, signal);
        } catch (fallbackError) {
          if (signal?.aborted) {
            console.log('🛑 Categories and channels fallback fetch aborted');
            return;
          }
          console.error('❌ Fallback categories and channels fetch also failed:', fallbackError);
          // Ensure state is clean on total failure
          this.categories = [];
          this.channels = [];
          this.categoryChannels = {};
        }
      }
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
        console.error('Error fetching categories in fallback:', categoriesError);
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
        console.error('Error fetching channels in fallback:', channelsError);
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
        console.log('🔄 Moving channel to category via service-like helper:', { channelId, newCategoryId })
        
        // Use service-like helper for optimistic channel move with rollback
        const updatedChannel = await this._moveChannelToCategoryHelper(channelId, newCategoryId)
        
        console.log(`✅ Channel moved successfully via service-like helper: ${channelId} → ${newCategoryId || 'orphan'}`)
        return updatedChannel
      } catch (error) {
        console.error('❌ Failed to move channel via service-like helper:', error)
        
        // Fallback to direct move if helper fails
        try {
          console.log('🔄 Falling back to direct channel move')
          return await this._moveChannelToCategoryFallback(channelId, newCategoryId)
        } catch (fallbackError) {
          console.error('❌ Fallback channel move also failed:', fallbackError)
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
        console.log('🔄 Rolling back optimistic channel move due to error')
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
          console.error('Error moving channel to category in fallback:', error)
          throw error
        }

        console.log(`✅ Successfully moved channel ${channelId} to category ${newCategoryId || 'orphan'}`)
        return data
      } catch (error) {
        // Rollback on error: Restore original state
        console.error('❌ Server update failed, rolling back channel move:', error)
        this.channels = originalChannels
        this.categoryChannels = originalCategoryChannels
        throw error
      }
    },

    async updateChannelOrder(channels: Channel[], categoryId: string | null) {
      try {
        console.log('🔄 Updating channel order via service-like helper:', { count: channels.length, categoryId })
        
        // Use service-like helper for complex channel ordering with rollback
        await this._updateChannelOrderHelper(channels, categoryId)
        
        console.log(`✅ Channel order updated successfully via service-like helper: ${channels.length} channels`)
      } catch (error) {
        console.error('❌ Failed to update channel order via service-like helper:', error)
        
        // Fallback to direct ordering if helper fails
        try {
          console.log('🔄 Falling back to direct channel ordering')
          await this._updateChannelOrderFallback(channels, categoryId)
        } catch (fallbackError) {
          console.error('❌ Fallback channel ordering also failed:', fallbackError)
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
        console.log('🔄 Rolling back optimistic channel order due to error')
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
            console.error(`Error updating channel ${channel.id}:`, error)
            throw error
          }
        }

        console.log(`✅ Successfully updated order for ${channels.length} channels`)
      } catch (error) {
        // Rollback on error: Restore original state
        console.error('❌ Server update failed, rolling back changes:', error)
        this.channels = originalChannels
        this.categoryChannels = originalCategoryChannels
        throw error
      }
    },

    async reorderChannelsInCategory(categoryId: string | null, newChannelOrder: Channel[]) {
      try {
        console.log('🔄 Reordering channels in category via service-like helper:', { categoryId, count: newChannelOrder.length })
        
        // Use service-like helper for channel reordering
        await this._reorderChannelsInCategoryHelper(categoryId, newChannelOrder)
        
        console.log(`✅ Channels reordered successfully via service-like helper: ${newChannelOrder.length} in ${categoryId || 'orphan'}`)
      } catch (error) {
        console.error('❌ Failed to reorder channels via service-like helper:', error)
        
        // Fallback to direct reordering if helper fails
        try {
          console.log('🔄 Falling back to direct channel reordering')
          await this._reorderChannelsInCategoryFallback(categoryId, newChannelOrder)
        } catch (fallbackError) {
          console.error('❌ Fallback channel reordering also failed:', fallbackError)
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
        console.log(`✅ Reordered ${newChannelOrder.length} channels in category ${categoryId || 'orphan'}`)
      } catch (error) {
        console.error('❌ Failed to reorder channels in category:', error)
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
        console.log('🔄 Updating category order via service-like helper:', { count: categories.length })
        
        // Use service-like helper for complex category ordering with rollback
        await this._updateCategoryOrderHelper(categories)
        
        console.log(`✅ Category order updated successfully via service-like helper: ${categories.length} categories`)
      } catch (error) {
        console.error('❌ Failed to update category order via service-like helper:', error)
        
        // Fallback to direct ordering if helper fails
        try {
          console.log('🔄 Falling back to direct category ordering')
          await this._updateCategoryOrderFallback(categories)
        } catch (fallbackError) {
          console.error('❌ Fallback category ordering also failed:', fallbackError)
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
        console.log('🔄 Rolling back optimistic category order due to error')
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
            console.error(`Error updating category ${category.id}:`, error)
            throw error
          }
        }

        console.log(`✅ Successfully updated order for ${categories.length} categories`)
      } catch (error) {
        // Rollback on error: Restore original state
        console.error('❌ Server update failed, rolling back category changes:', error)
        this.categories = originalCategories
        throw error
      }
    },

    async createCategory(name: string, serverId: string) {
      try {
        console.log('🔄 Creating category via service-like helper:', { name, serverId });
        
        // Use service-like helper for category creation
        const newCategory = await this._createCategoryHelper(name, serverId);
        
        if (newCategory) {
          this.categories.push(newCategory);
          console.log('✅ Category created successfully via service-like helper:', newCategory.id);
          return newCategory;
        }
        
        return null;
      } catch (error) {
        console.error('❌ Failed to create category via service-like helper:', error);
        
        // Fallback to direct creation if helper fails
        try {
          console.log('🔄 Falling back to direct category creation');
          return await this._createCategoryFallback(name, serverId);
        } catch (fallbackError) {
          console.error('❌ Fallback category creation also failed:', fallbackError);
          return null;
        }
      }
    },

    /**
     * Service-like helper: Create category with proper ordering
     */
    async _createCategoryHelper(name: string, serverId: string): Promise<Category | null> {
      // Get the highest order value for existing categories in this server
      const { data: existingCategories, error: fetchError } = await supabase
        .from('channel_categories')
        .select('order')
        .eq('server_id', serverId)
        .order('order', { ascending: false })
        .limit(1);

      if (fetchError) {
        console.warn('Warning: Could not fetch existing categories for ordering, using default');
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
     */
    async _createCategoryFallback(name: string, serverId: string): Promise<Category | null> {
      // Get the highest order value for existing categories in this server
      const { data: existingCategories, error: fetchError } = await supabase
        .from('channel_categories')
        .select('order')
        .eq('server_id', serverId)
        .order('order', { ascending: false })
        .limit(1);

      if (fetchError) {
        console.error('Error fetching existing categories for ordering in fallback:', fetchError);
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
        console.error('Error creating category in fallback:', error);
        throw error;
      }

      this.categories.push(data);
      return data;
    },

    async fetchChannels(serverId: string) {
      try {
        console.log('🔄 Fetching channels via service-like helper:', serverId)
        
        // Use service-like helper for channel fetching
        const channels = await this._fetchChannelsHelper(serverId)
        
        if (channels) {
          this.channels = channels
          console.log('✅ Channels fetched successfully via service-like helper:', channels.length)
        }
      } catch (error) {
        console.error('❌ Failed to fetch channels via service-like helper:', error)
        
        // Fallback to direct fetching if helper fails
        try {
          console.log('🔄 Falling back to direct channel fetching')
          await this._fetchChannelsFallback(serverId)
        } catch (fallbackError) {
          console.error('❌ Fallback channel fetching also failed:', fallbackError)
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
        console.error('Error fetching channels in fallback:', error)
        return
      }
      this.channels = data
    },

    async createServer(serverData: { name: string; description?: string; public?: boolean; owner: string }) {
      try {
        console.log('🔄 Creating server via service-like helper:', serverData.name)
        
        // Use service-like helper for server creation with user membership
        const newServer = await this._createServerHelper(serverData)
        
        console.log('✅ Server created successfully via service-like helper:', newServer.id)
        return newServer
      } catch (error) {
        console.error('❌ Failed to create server via service-like helper:', error)
        
        // Fallback to direct creation if helper fails
        try {
          console.log('🔄 Falling back to direct server creation')
          return await this._createServerFallback(serverData)
        } catch (fallbackError) {
          console.error('❌ Fallback server creation also failed:', fallbackError)
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

      // Add the new server to the user's server list
      await this.addUserToServer(data.id, serverData.owner)
      
      // Add server to local state
      this.servers.push(data)
      
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
        console.error('Error creating server in fallback:', error)
        throw error
      }

      // Add the new server to the user's server list
      await this.addUserToServer(data.id, serverData.owner)
      
      // Add server to local state
      this.servers.push(data)
      
      console.log('✅ Server created successfully with default structure:', data)
      return data
    },

    async addUserToServer(serverId: string, userId: string) {
      try {
        console.log('🔄 Adding user to server via service-like helper:', { serverId, userId })
        
        // Use service-like helper for user-server membership
        await this._addUserToServerHelper(serverId, userId)
        
        console.log('✅ User added to server successfully via service-like helper')
      } catch (error) {
        console.error('❌ Failed to add user to server via service-like helper:', error)
        
        // Fallback to direct addition if helper fails
        try {
          console.log('🔄 Falling back to direct user-server addition')
          await this._addUserToServerFallback(serverId, userId)
        } catch (fallbackError) {
          console.error('❌ Fallback user-server addition also failed:', fallbackError)
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
          console.log("User is already a member of this server")
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
          console.log("User is already a member of this server")
          // Don't show a toast here since this is typically called internally
          return // Consider it successful since the desired state is achieved
        }
        console.error('Error adding user to server:', error)
        toast.error("Failed to add user to server")
        throw error
      }
    },

    async updateServer(serverData: { id: string; icon?: string; name?: string; description?: string; public?: boolean }) {
      try {
        console.log('🔄 Updating server via service-like helper:', serverData.id);
        
        // Use service-like helper for server update
        const updatedServer = await this._updateServerHelper(serverData);
        
        if (updatedServer) {
          // Update local state with optimistic update
          const serverIndex = this.servers.findIndex(server => server.id === serverData.id);
          if (serverIndex !== -1) {
            this.servers[serverIndex] = { ...this.servers[serverIndex], ...updatedServer };
          }
          
          console.log('✅ Server updated successfully via service-like helper:', updatedServer.id);
          return updatedServer;
        }
        
        throw new Error('Server update returned no data');
      } catch (error) {
        console.error('❌ Failed to update server via service-like helper:', error);
        
        // Fallback to direct update if helper fails
        try {
          console.log('🔄 Falling back to direct server update');
          return await this._updateServerFallback(serverData);
        } catch (fallbackError) {
          console.error('❌ Fallback server update also failed:', fallbackError);
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
        console.error('Error updating server in fallback:', error);
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
        console.log('🔄 Fetching public servers via service-like helper:', { searchTerm, limit });
        
        // Use service-like helper for database operations
        const servers = await this._fetchPublicServersHelper(searchTerm, limit);
        this.publicServers = servers || [];
        
        console.log(`✅ Fetched ${this.publicServers.length} public servers via service-like helper`);
      } catch (error) {
        console.error('❌ Failed to fetch public servers via service-like helper:', error);
        
        // Fallback to direct query if helper fails
        try {
          console.log('🔄 Falling back to direct public servers fetch');
          await this._fetchPublicServersFallback(searchTerm, limit);
        } catch (fallbackError) {
          console.error('❌ Fallback public servers fetch also failed:', fallbackError);
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
        console.error('Error in fallback public servers fetch:', error);
        throw error;
      }

      this.publicServers = data || [];
    },

    async deleteChannel(channelId: string): Promise<void> {
      try {
        console.log('🔄 Deleting channel via service-like helper:', channelId);
        
        // Use service-like helper for channel deletion
        await this._deleteChannelHelper(channelId);
        
        // Handle complex local state cleanup using service-like helper
        this._removeChannelFromLocalState(channelId);
        
        console.log('✅ Channel deleted successfully via service-like helper:', channelId);
      } catch (error) {
        console.error('❌ Failed to delete channel via service-like helper:', error);
        
        // Fallback to direct deletion if helper fails
        try {
          console.log('🔄 Falling back to direct channel deletion');
          await this._deleteChannelFallback(channelId);
        } catch (fallbackError) {
          console.error('❌ Fallback channel deletion also failed:', fallbackError);
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

      // If this was the current channel, switch to another channel
      if (this.currentChannelId === channelId) {
        const defaultChannel = this.getDefaultChannel();
        if (defaultChannel) {
          this.setCurrentChannel(defaultChannel);
        } else {
          this.currentChannelId = null;
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
        console.error('Error deleting channel in fallback:', error);
        throw error;
      }

      // Handle complex local state cleanup using reusable helper
      this._removeChannelFromLocalState(channelId);
    },

    async deleteCategory(categoryId: string): Promise<void> {
      try {
        console.log('🔄 Deleting category via service-like helper:', categoryId);
        
        // Get channels that need to be moved to orphans
        const channelsInCategory = this.categoryChannels[categoryId] || [];
        
        // Use service-like helper for complex category deletion
        await this._deleteCategoryHelper(categoryId, channelsInCategory);
        
        // Handle complex local state cleanup using service-like helper
        this._removeCategoryFromLocalState(categoryId, channelsInCategory);
        
        console.log('✅ Category deleted successfully via service-like helper:', categoryId);
      } catch (error) {
        console.error('❌ Failed to delete category via service-like helper:', error);
        
        // Fallback to direct deletion if helper fails
        try {
          console.log('🔄 Falling back to direct category deletion');
          await this._deleteCategoryFallback(categoryId);
        } catch (fallbackError) {
          console.error('❌ Fallback category deletion also failed:', fallbackError);
          throw fallbackError;
        }
      }
    },

    /**
     * Service-like helper: Delete category with channel orphaning
     */
    async _deleteCategoryHelper(categoryId: string, channelsInCategory: Channel[]): Promise<void> {
      // First, move all channels in this category to orphans (no category)
      if (channelsInCategory.length > 0) {
        const { error: updateError } = await supabase
          .from('channels')
          .update({ category_id: null })
          .in('id', channelsInCategory.map(channel => channel.id));

        if (updateError) {
          throw new Error(`Error moving channels to orphans: ${updateError.message}`);
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
     */
    _removeCategoryFromLocalState(categoryId: string, channelsInCategory: Channel[]): void {
      // Update local state
      this.categories = this.categories.filter(category => category.id !== categoryId);
      
      // Move channels to orphans in local state
      if (channelsInCategory.length > 0) {
        channelsInCategory.forEach(channel => {
          channel.category_id = null;
        });
      }
      
      // Remove category from categoryChannels
      delete this.categoryChannels[categoryId];
    },

    /**
     * Fallback method for deleting category
     */
    async _deleteCategoryFallback(categoryId: string): Promise<void> {
      // Get channels that need to be moved to orphans
      const channelsInCategory = this.categoryChannels[categoryId] || [];
      
      // First, move all channels in this category to orphans (no category)
      if (channelsInCategory.length > 0) {
        const { error: updateError } = await supabase
          .from('channels')
          .update({ category_id: null })
          .in('id', channelsInCategory.map(channel => channel.id));

        if (updateError) {
          console.error('Error moving channels to orphans in fallback:', updateError);
          throw updateError;
        }
      }

      // Then delete the category
      const { error } = await supabase
        .from('channel_categories')
        .delete()
        .eq('id', categoryId);

      if (error) {
        console.error('Error deleting category in fallback:', error);
        throw error;
      }

      // Handle complex local state cleanup using reusable helper
      this._removeCategoryFromLocalState(categoryId, channelsInCategory);
    },

    async updateChannel(channelData: { id: string; name?: string; description?: string }): Promise<void> {
      try {
        console.log('🔄 Updating channel via service-like helper:', channelData.id);
        
        // Use service-like helper for channel update
        const updatedChannel = await this._updateChannelHelper(channelData);
        
        if (updatedChannel) {
          // Update complex local state using service-like helper
          this._updateChannelInLocalState(updatedChannel);
          
          console.log('✅ Channel updated successfully via service-like helper:', channelData.id);
        }
      } catch (error) {
        console.error('❌ Failed to update channel via service-like helper:', error);
        
        // Fallback to direct update if helper fails
        try {
          console.log('🔄 Falling back to direct channel update');
          await this._updateChannelFallback(channelData);
        } catch (fallbackError) {
          console.error('❌ Fallback channel update also failed:', fallbackError);
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
        console.error('Error updating channel in fallback:', error);
        throw error;
      }

      // Update complex local state using reusable helper
      this._updateChannelInLocalState(data);
    },

    async updateCategory(categoryData: { id: string; name: string }): Promise<void> {
      try {
        console.log('🔄 Updating category via service-like helper:', categoryData.id);
        
        // Use service-like helper for category update
        const updatedCategory = await this._updateCategoryHelper(categoryData);
        
        if (updatedCategory) {
          // Update local state
          const categoryIndex = this.categories.findIndex(category => category.id === categoryData.id);
          if (categoryIndex !== -1) {
            this.categories[categoryIndex] = { ...this.categories[categoryIndex], ...updatedCategory };
          }
          
          console.log('✅ Category updated successfully via service-like helper:', categoryData.id);
        }
      } catch (error) {
        console.error('❌ Failed to update category via service-like helper:', error);
        
        // Fallback to direct update if helper fails
        try {
          console.log('🔄 Falling back to direct category update');
          await this._updateCategoryFallback(categoryData);
        } catch (fallbackError) {
          console.error('❌ Fallback category update also failed:', fallbackError);
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
        console.error('Error updating category in fallback:', error);
        throw error;
      }

      // Update local state
      const categoryIndex = this.categories.findIndex(category => category.id === categoryData.id);
      if (categoryIndex !== -1) {
        this.categories[categoryIndex] = { ...this.categories[categoryIndex], ...data };
      }
    },
  }
});