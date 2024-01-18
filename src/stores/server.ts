import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Server, Emoji } from '@/types';

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

    async updateServer(serverData: Partial<Server>, file?: File): Promise<boolean> {
      try {
        if (file && serverData.id) {
          // Define file path
          const filePath = `${serverData.id}/${file.name}`;
          
          // Upload to Supabase storage
          const { error: uploadError } = await supabase.storage
            .from('server_icons')
            .upload(filePath, file);

          if (uploadError) throw uploadError;

          // Construct public URL for the uploaded file
          const response = supabase.storage.from('server_icons').getPublicUrl(filePath);

          // Update serverData with the new icon URL
          serverData.icon = response.data.publicUrl;
        }

        // Update server data in database
        const { error } = await supabase
          .from('servers')
          .update(serverData)
          .eq('id', serverData.id);

        if (error) throw error;

        console.log("Server updated successfully");
        return true;
      } catch (error) {
        console.error('Error updating server:', error);
        return false;
      }
    },

    async fetchEmojis(serverId: string): Promise<Emoji[]> {
      const { data, error } = await supabase
        .from('emojis')
        .select('*')
        .eq('server_id', serverId);

      if (error) throw error;
      return data;
    },
  }
});
