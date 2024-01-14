import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Server, Channel } from '@/types';

export const useServerChannelStore = defineStore('serverChannel', {
  state: () => ({
    servers: [] as Server[],
    channels: [] as Channel[],
    currentServer: {} as Server,
    currentServerId: null as string | null,
    currentChannelId: null as number | null,
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
    setCurrentChannel(channelId: number) {
      this.currentChannelId = channelId;
    },
  },
});
