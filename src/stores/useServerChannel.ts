import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Server, Category, Channel, Emoji } from '@/types';

export const useServerChannelStore = defineStore('serverChannel', {
  state: () => ({
    servers: [] as Server[],
    emojiList: [] as { serverId: string, emojis: Emoji[] }[],
    channels: [] as Channel[],
    categories: {} as Category[],
    categoryChannels: {} as Record<string, Channel[]>,
    currentServer: {} as Server,
    currentServerId: null as string | null,
    currentChannelId: null as string | null,
  }),
  actions: {
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
  },
});
