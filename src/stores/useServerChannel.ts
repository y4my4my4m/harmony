import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Server, Category, Channel, Emoji, ResolvedEmoji } from '@/types';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { 
  subscribeToServerNotifications,
  listenInServer
} from '@/services/notificationService';

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
  }),

  getters: {
    // Get resolved emojis from the emoji cache store
    resolvedEmojiList: () => {
      const emojiCache = useEmojiCacheStore();
      return emojiCache.resolvedEmojis;
    },
    
    // Get emojis for current server
    currentServerEmojis: () => {
      const emojiCache = useEmojiCacheStore();
      const store = useServerChannelStore();
      if (!store.currentServerId) return [];
      return emojiCache.getServerEmojis(store.currentServerId);
    },
  },

  actions: {
    async initializeUserEnvironment(userId: string): Promise<void> {
      try {
        console.log('🚀 Initializing user environment...');
        
        // Fetch user's servers first
        await this.fetchServersForUser(userId);
        
        // Initialize emoji cache with user's servers
        const emojiCache = useEmojiCacheStore();
        const serverIds = this.servers.map(server => server.id);
        await emojiCache.initialize(serverIds);
        
        // Set up server notifications
        await this.subscribeAndListentoServerNotifications(userId);
        
        console.log('✅ User environment initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize user environment:', error);
        throw error;
      }
    },

    async subscribeAndListentoServerNotifications(userId: string) {
      this.servers.forEach(server => {
        subscribeToServerNotifications(userId, server.id);
        console.log('Subscribed to server notifications for server:', server.id);
      });
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

      this.servers = data.map(item => item.server).filter(Boolean);
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

      // Fetch channels
      const { data: channels, error: channelsError } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId);

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
    },

    async moveChannelToCategory(channelId: string, newCategoryId: string) {
      const { data, error } = await supabase
        .from('channels')
        .update({ category: newCategoryId })
        .eq('id', channelId)
        .select()
        .single();

      if (error) {
        console.error('Error moving channel to category:', error);
        return;
      }

      // Update local state
      const channelIndex = this.channels.findIndex(c => c.id === channelId);
      if (channelIndex !== -1) {
        this.channels[channelIndex] = data;
        // Refresh categoryChannels mapping
        await this.fetchCategoriesAndChannels(this.currentServerId!);
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

    async createServer(name: string, userId: string) {
      const { data, error } = await supabase
        .from('servers')
        .insert([{ name, owner: userId }])
        .select()
        .single();

      if (error) {
        console.error('Error creating server:', error);
        return null;
      }

      this.servers.push(data);
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

    // Legacy method for backward compatibility
    async fetchAllEmojis() {
      console.log('⚠️ fetchAllEmojis is deprecated, use emoji cache store instead');
      await this.refreshEmojis();
    },

    // Legacy method for backward compatibility  
    resolveAndCacheEmojis() {
      console.log('⚠️ resolveAndCacheEmojis is deprecated, emoji resolution is automatic');
      // Emoji resolution is now handled automatically by the cache store
    },

    // Legacy methods - kept for compatibility but delegate to cache
    resolveNamingConflicts(): Record<string, { server_name: string; server_icon?: string; emojis: ResolvedEmoji[]; }> {
      console.log('⚠️ resolveNamingConflicts is deprecated, use resolvedEmojiList getter instead');
      return this.resolvedEmojiList;
    },

    cacheEmojis(emojisByServer: Record<string, { server_name: string; server_icon?: string; emojis: ResolvedEmoji[]; }>) {
      console.log('⚠️ cacheEmojis is deprecated, caching is automatic');
      // Caching is now handled automatically by the emoji cache store
    },
    
    getServerDetails(serverId: string): { name?: string; icon?: string } | undefined {
      return this.servers.find(server => server.id === serverId);
    },

    setCurrentServer(serverId: string) {
      this.currentServerId = serverId;
      this.getCurrentServer();
    },

    setCurrentChannel(channelId: string) {
      this.currentChannelId = channelId;
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
  },
});
