import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Server, Channel } from '@/types';

export const useServerChannelStore = defineStore('serverChannel', {
  state: () => ({
    servers: [] as Server[],
    channels: [] as Channel[],
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

      // Assuming server_id is a foreign key to the servers table
      const serverIds = data.map(us => us.server_id);
      if (serverIds.length > 0) {
        const { data: serversData, error: serversError } = await supabase
          .from('servers')
          .select('*')
          .in('id', serverIds);

        if (serversError) {
          console.error('Error fetching server details:', serversError);
        } else {
          this.servers = serversData;
        }
      }
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
    setCurrentServer(serverId: string) {
      this.currentServerId = serverId;
      this.fetchChannels(serverId);
    },
    setCurrentChannel(channelId: number) {
      this.currentChannelId = channelId;
    },
  },
});
