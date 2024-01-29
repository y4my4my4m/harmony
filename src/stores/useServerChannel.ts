import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Server, Category, Channel, Emoji, ResolvedEmoji } from '@/types';

export const useServerChannelStore = defineStore('serverChannel', {
  state: () => ({
    servers: [] as Server[],
    publicServers: [] as Server[],
    emojiList: [] as { serverId: string, emojis: Emoji[] }[],
    resolvedEmojiList: {} as Record<string, { 
      server_name: string; 
      server_icon?: string; 
      emojis: ResolvedEmoji[]; 
    }>,
    channels: [] as Channel[],
    categories: {} as Category[],
    categoryChannels: {} as Record<string, Channel[]>,
    currentServer: {} as Server,
    currentServerId: null as string | null,
    currentChannelId: null as string | null,
  }),
  actions: {
    async initializeUserEnvironment(userId: string): Promise<void> {
      await this.fetchServersForUser(userId);
      await this.fetchAllEmojis();
      this.resolveAndCacheEmojis();
    },
    async fetchServersForUser(userId: string) {
      const { data, error } = await supabase
        .from('user_servers')
        .select('server_id')
        .eq('user_id', userId);

      if (error) {
        console.error('Error fetching servers:', error);
        return;
      }

      const serverIds = data.map(us => us.server_id);
      if (serverIds.length > 0) {
        const { data: serversData, error: serversError } = await supabase
          .from('servers')
          .select('*')
          .in('id', serverIds)
          .select();

        if (serversError) {
          console.error('Error fetching server details:', serversError);
        } else {
          this.servers = serversData;
        }
      }
      // await this.updateServerIcons(this.servers);
    },
    async fetchServers() {
      const { data: servers, error } = await supabase.from('servers').select('*');
      if (error) console.error('Error fetching servers:', error);
      else this.servers = servers;
    },
    async fetchCategoriesAndChannels(serverId: string) {
      // Fetch categories for the server, ordered by 'order'
      const { data: categories, error: categoriesError } = await supabase
        .from('channel_categories')
        .select('*')
        .eq('server_id', serverId)
        .order('order', { ascending: true });

      if (categoriesError) {
        console.error('Error fetching categories:', categoriesError);
        return;
      }
      // this.categories = categories;
      this.categories = categories.map(cat => ({ ...cat, expanded: true }));

      // Fetch channels for the server
      const { data: channels, error: channelsError } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId);
  
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
        } else {
          // console.log(`Channel with id ${channel.id} has no category_id or invalid category_id`);
        }
      });
    },
    async createCategory(name: string, serverId: string) {
      try {
        // find the highest order number
        const highestOrder = this.categories.sort((a, b) =>  a.order - b.order);
        const { data: categoryData, error: categoryError } = await supabase
          .from('channel_categories')
          .insert([{ name: name, server_id: serverId, order: highestOrder[highestOrder.length - 1].order + 1}])
          .select()
          .single();
        if (categoryError) throw categoryError;

        // Handle successful category creation
        this.categories.push(categoryData);
      } catch (error) {
        console.error('Error creating category:', error);
      }
    },
    async fetchChannels(serverId: string) {
        const { data: channels, error } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId);

      if (error) console.error('Error fetching channels:', error);
      else this.channels = channels;
    },
    async createServer(name: string, userId: string) {
      try {
        // Create server
        const { data: serverData, error: serverError } = await supabase
          .from('servers')
          .insert([{ name: name, owner: userId }])
          .select()
          .single();
        if (serverError) throw serverError;

        console.log(serverData);

        // TODO: FIX MY RLS POLICY, currently *anyone* can make any user_servers relation entry
        // Connect user to the server
        const { error: userServerError } = await supabase
          .from('user_servers')
          .insert([{ user_id: userId, server_id: serverData.id }]);
        if (userServerError) throw userServerError;

        // Create default channel
        const { error: channelError } = await supabase
          .from('channels')
          .insert([{ name: 'General', server_id: serverData.id }]);
        if (channelError) throw channelError;

        return true;
        // Handle successful server creation
      } catch (error) {
        console.error('Error creating server:', error);
      }
    },
    async getCurrentServer() {
      const { data, error } = await supabase
        .from('servers')
        .select('*')
        .in('id', this.currentServerId ? [this.currentServerId] : [])
        .select()
        .single();

        if (error) console.error('Error fetching servers:', error);
        else this.currentServer = data;
    },
    async fetchAllEmojis() {
      try {
        // Get server IDs from the current user's servers
        const serverIds = this.servers.map(server => server.id);
    
        // Fetch emojis only from those servers
        const { data, error } = await supabase
          .from('emojis')
          .select(`
            *,
            server:server_id ( name )
          `)
          .in('server_id', serverIds);
    
        if (error) throw error;
    
        // Reset emojis state
        this.emojiList = [];
    
        // Group emojis by server
        data.forEach(emoji => {
          let serverEmoji = this.emojiList.find(e => e.serverId === emoji.server_id);
          if (!serverEmoji) {
            serverEmoji = { serverId: emoji.server_id, emojis: [] };
            this.emojiList.push(serverEmoji);
          }
          serverEmoji.emojis.push(emoji);
        });
      } catch (error) {
        console.error('Error fetching emojis:', error);
      }
    },
    resolveAndCacheEmojis() {
      const resolvedEmojis = this.resolveNamingConflicts();
      this.cacheEmojis(resolvedEmojis);
    },

    resolveNamingConflicts(): Record<string, { server_name: string; server_icon?: string; emojis: ResolvedEmoji[]; }> {
      const nameCount: Record<string, number> = {};
      const emojisByServer: Record<string, { server_name: string; server_icon?: string; emojis: ResolvedEmoji[]; }> = {};
    
      this.emojiList.forEach(({ serverId, emojis }) => { // Corrected serverId
        const serverDetails = this.getServerDetails(serverId);
    
        emojisByServer[serverId] = { // Corrected serverId
          server_name: serverDetails?.name || '', // Default to empty string if undefined
          server_icon: serverDetails?.icon,
          emojis: emojis.map(emoji => {
            const count = nameCount[emoji.name] || 0;
            nameCount[emoji.name] = count + 1;
    
            return {
              ...emoji,
              display_name: count > 0 ? `${emoji.name}~${count}` : emoji.name,
            };
          }),
        };
      });
    
      return emojisByServer;
    },

    cacheEmojis(emojisByServer: Record<string, { server_name: string; server_icon?: string; emojis: ResolvedEmoji[]; }>) {
      this.resolvedEmojiList = emojisByServer;
    },
    
    getServerDetails(serverId: string): { name?: string; icon?: string } | undefined {
      return this.servers.find(server => server.id === serverId);
    },

    setCurrentServer(serverId: string) {
      this.currentServerId = serverId;
      this.getCurrentServer();
      // this.fetchChannels(serverId).then(() => {
      //   if (!this.currentChannelId && this.channels.length > 0) {
      //     const firstChannelId = this.channels[0].id;
      //     this.setCurrentChannel(firstChannelId);
      //   }
      // });
    },
    setCurrentChannel(channelId: string) {
      this.currentChannelId = channelId;
    },
    // subscribeToServers() {
    //   supabase.channel('user-statuses')
    //     .on(
    //       'postgres_changes',
    //       { event: 'UPDATE', schema: 'public', table: 'user_servers' },
    //       (payload) => {

    //       }
    //     )
    //     .subscribe();
    // },
    async fetchPublicServers(searchTerm = '', limit = 10) {
      let query = supabase
        .from('servers')
        .select('*')
        .eq('public', true)
        .limit(limit);
    
      if (searchTerm) {
        query = query.ilike('name', `%${searchTerm}%`); // Assuming 'name' is the field to search
      }
    
      const { data: servers, error } = await query;
    
      if (error) {
        console.error('Error fetching servers:', error);
      } else {
        console.log(servers);
        this.publicServers = servers;
      }
    },
  },
});
