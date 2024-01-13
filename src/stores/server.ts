import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Server } from '@/types';

export const useServerStore = defineStore('server', {
  actions: {
    async getServer(serverId: string): Promise<Server | null> {
      const { data, error } = await supabase
        .from('servers')
        .select('*')
        .eq('id', serverId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    async updateServer(serverId: string, serverData: Partial<Server>): Promise<void> {
      const { error } = await supabase
        .from('servers')
        .update(serverData)
        .eq('id', serverId);

      if (error) throw error;
    }
  }
});
