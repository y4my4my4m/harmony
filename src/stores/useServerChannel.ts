import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
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
        
        // Initialize emoji cache with user's servers
        const emojiCache = useEmojiCacheStore();
        const serverIds = this.servers.map(server => server.id);
        await emojiCache.initialize(serverIds);
        
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
        .eq('user_id', userId);

      if (error) {
        console.error('Error fetching servers for user:', error);
        return;
      }

      this.servers = data?.map((item: any) => item.server).filter(Boolean) || [];
      console.log(`📊 Loaded ${this.servers.length} servers for user`);
    },

    async fetchServers() {
      const { data, error } = await supabase.from('servers').select('*');
      if (error) {
        console.error('Error fetching servers:', error);
        return;
      }
      this.servers = data;
    },

    async fetchCategoriesAndChannels(serverId: string, signal?: AbortSignal) {
      // Fetch categories
      const { data: categories, error: categoriesError } = await supabase
        .from('channel_categories')
        .select('*')
        .eq('server_id', serverId)
        .order('order', { ascending: true });

      if (signal?.aborted) return;
      
      if (categoriesError) {
        console.error('Error fetching categories:', categoriesError);
        return;
      }
      this.categories = categories;

      // Fetch channels ordered by order column
      const { data: channels, error: channelsError } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId)
        .order('order', { ascending: true });

      if (signal?.aborted) return;
      
      if (channelsError) {
        console.error('Error fetching channels:', channelsError);
        return;
      }
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
      // Store original state for potential rollback
      const originalChannels = [...this.channels];
      const originalCategoryChannels = { ...this.categoryChannels };

      try {
        // Optimistic update: Update local state immediately
        const channelIndex = this.channels.findIndex(c => c.id === channelId);
        if (channelIndex !== -1) {
          this.channels[channelIndex] = { 
            ...this.channels[channelIndex], 
            category: newCategoryId 
          };
          // Refresh category channels mapping optimistically
          this.refreshCategoryChannels();
        }

        // Now perform the server update in the background
        const { data, error } = await supabase
          .from('channels')
          .update({ category: newCategoryId })
          .eq('id', channelId)
          .select()
          .single();

        if (error) {
          console.error('Error moving channel to category:', error);
          throw error;
        }

        console.log(`✅ Successfully moved channel ${channelId} to category ${newCategoryId || 'orphan'}`);
        return data;
      } catch (error) {
        // Rollback on error: Restore original state
        console.error('❌ Server update failed, rolling back channel move:', error);
        this.channels = originalChannels;
        this.categoryChannels = originalCategoryChannels;
        throw error;
      }
    },

    async updateChannelOrder(channels: Channel[], categoryId: string | null) {
      // Store original state for potential rollback
      const originalChannels = [...this.channels];
      const originalCategoryChannels = { ...this.categoryChannels };

      try {
        // Optimistic update: Update local state immediately
        const updateMap = new Map(channels.map((channel, index) => [channel.id, { order: index, category: categoryId }]));
        this.channels = this.channels.map(channel => {
          const update = updateMap.get(channel.id);
          return update ? { ...channel, order: update.order, category: update.category } : channel;
        });

        // Refresh category channels mapping optimistically
        this.refreshCategoryChannels();

        // Now perform the server update in the background
        for (let i = 0; i < channels.length; i++) {
          const channel = channels[i];
          const { error } = await supabase
            .from('channels')
            .update({ 
              order: i, 
              category: categoryId 
            })
            .eq('id', channel.id);

          if (error) {
            console.error(`Error updating channel ${channel.id}:`, error);
            throw error;
          }
        }

        console.log(`✅ Successfully updated order for ${channels.length} channels`);
      } catch (error) {
        // Rollback on error: Restore original state
        console.error('❌ Server update failed, rolling back changes:', error);
        this.channels = originalChannels;
        this.categoryChannels = originalCategoryChannels;
        throw error;
      }
    },

    async reorderChannelsInCategory(categoryId: string | null, newChannelOrder: Channel[]) {
      // Specifically handle reordering within the same category
      try {
        await this.updateChannelOrder(newChannelOrder, categoryId);
        console.log(`✅ Reordered ${newChannelOrder.length} channels in category ${categoryId || 'orphan'}`);
      } catch (error) {
        console.error('❌ Failed to reorder channels in category:', error);
        throw error;
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
      // Store original state for potential rollback
      const originalCategories = [...this.categories];

      try {
        // Optimistic update: Update local state immediately AND sort by order
        this.categories = this.categories.map(category => {
          const newIndex = categories.findIndex(c => c.id === category.id);
          return newIndex !== -1 ? { ...category, order: newIndex } : category;
        }).sort((a, b) => (a.order || 0) - (b.order || 0)); // Add sorting here!

        // Now perform the server update in the background using individual updates
        for (let i = 0; i < categories.length; i++) {
          const category = categories[i];
          const { error } = await supabase
            .from('channel_categories')
            .update({ order: i })
            .eq('id', category.id);

          if (error) {
            console.error(`Error updating category ${category.id}:`, error);
            throw error;
          }
        }

        console.log(`✅ Successfully updated order for ${categories.length} categories`);
      } catch (error) {
        // Rollback on error: Restore original state
        console.error('❌ Server update failed, rolling back category changes:', error);
        this.categories = originalCategories;
        throw error;
      }
    },

    async createCategory(name: string, serverId: string) {
      // Get the highest order value for existing categories in this server
      const { data: existingCategories, error: fetchError } = await supabase
        .from('channel_categories')
        .select('order')
        .eq('server_id', serverId)
        .order('order', { ascending: false })
        .limit(1);

      if (fetchError) {
        console.error('Error fetching existing categories for ordering:', fetchError);
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
        console.error('Error creating category:', error);
        return null;
      }

      this.categories.push(data);
      return data;
    },

    async fetchChannels(serverId: string) {
      const { data, error } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId);

      if (error) {
        console.error('Error fetching channels:', error);
        return;
      }
      this.channels = data;
    },

    async createServer(serverData: { name: string; description?: string; public?: boolean; owner: string }) {
      const { data, error } = await supabase
        .from('servers')
        .insert([{
          name: serverData.name,
          description: serverData.description || null,
          public: serverData.public || false,
          owner: serverData.owner
        }])
        .select()
        .single();

      if (error) {
        console.error('Error creating server:', error);
        throw error;
      }

      // Add the new server to the user's server list
      await this.addUserToServer(data.id, serverData.owner);
      
      // Add server to local state
      this.servers.push(data);
      
      console.log('✅ Server created successfully with default structure:', data);
      return data;
    },

    async addUserToServer(serverId: string, userId: string) {
      const { error } = await supabase
        .from('user_servers')
        .insert([{ server_id: serverId, user_id: userId }]);

      if (error) {
        console.error('Error adding user to server:', error);
        throw error;
      }
    },

    async updateServer(serverData: { id: string; icon?: string; name?: string; description?: string; public?: boolean }) {
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
        console.error('Error updating server:', error);
        throw error;
      }

      // Update local state
      const serverIndex = this.servers.findIndex(server => server.id === serverData.id);
      if (serverIndex !== -1) {
        this.servers[serverIndex] = { ...this.servers[serverIndex], ...data };
      }

      console.log('✅ Server updated successfully:', data);
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
        console.error('Error fetching public servers:', error);
        return;
      }

      this.publicServers = data;
    },

    async deleteChannel(channelId: string): Promise<void> {
      try {
        const { error } = await supabase
          .from('channels')
          .delete()
          .eq('id', channelId);

        if (error) {
          console.error('Error deleting channel:', error);
          throw error;
        }

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

        console.log('✅ Channel deleted successfully:', channelId);
      } catch (error) {
        console.error('❌ Failed to delete channel:', error);
        throw error;
      }
    },

    async deleteCategory(categoryId: string): Promise<void> {
      try {
        // First, move all channels in this category to orphans (no category)
        const channelsInCategory = this.categoryChannels[categoryId] || [];
        if (channelsInCategory.length > 0) {
          const { error: updateError } = await supabase
            .from('channels')
            .update({ category_id: null })
            .in('id', channelsInCategory.map(channel => channel.id));

          if (updateError) {
            console.error('Error moving channels to orphans:', updateError);
            throw updateError;
          }
        }

        // Then delete the category
        const { error } = await supabase
          .from('channel_categories')
          .delete()
          .eq('id', categoryId);

        if (error) {
          console.error('Error deleting category:', error);
          throw error;
        }

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

        console.log('✅ Category deleted successfully:', categoryId);
      } catch (error) {
        console.error('❌ Failed to delete category:', error);
        throw error;
      }
    },

    async updateChannel(channelData: { id: string; name?: string; description?: string }): Promise<void> {
      try {
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
          console.error('Error updating channel:', error);
          throw error;
        }

        // Update local state
        const channelIndex = this.channels.findIndex(channel => channel.id === channelData.id);
        if (channelIndex !== -1) {
          this.channels[channelIndex] = { ...this.channels[channelIndex], ...data };
        }

        // Update in category channels if it exists
        Object.keys(this.categoryChannels).forEach(categoryId => {
          const categoryChannelIndex = this.categoryChannels[categoryId].findIndex(
            channel => channel.id === channelData.id
          );
          if (categoryChannelIndex !== -1) {
            this.categoryChannels[categoryId][categoryChannelIndex] = {
              ...this.categoryChannels[categoryId][categoryChannelIndex],
              ...data
            };
          }
        });

        console.log('✅ Channel updated successfully:', channelData.id);
      } catch (error) {
        console.error('❌ Failed to update channel:', error);
        throw error;
      }
    },

    async updateCategory(categoryData: { id: string; name: string }): Promise<void> {
      try {
        const { data, error } = await supabase
          .from('channel_categories')
          .update({ name: categoryData.name })
          .eq('id', categoryData.id)
          .select()
          .single();

        if (error) {
          console.error('Error updating category:', error);
          throw error;
        }

        // Update local state
        const categoryIndex = this.categories.findIndex(category => category.id === categoryData.id);
        if (categoryIndex !== -1) {
          this.categories[categoryIndex] = { ...this.categories[categoryIndex], ...data };
        }

        console.log('✅ Category updated successfully:', categoryData.id);
      } catch (error) {
        console.error('❌ Failed to update category:', error);
        throw error;
      }
    },
  }
});