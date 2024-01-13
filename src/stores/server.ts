import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Server } from '@/types';
import { ref } from 'vue';

const selectedFile = ref<File | null>(null);
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

    async updateServer(serverData: Partial<Server>): Promise<boolean> {
      try {
        if (selectedFile.value && serverData.id) {
          // Upload to Supabase
          const filePath = `server_icons/${serverData.id}/${selectedFile.value.name}`;
          const { error: uploadError } = await supabase.storage
            .from('server_icons')
            .upload(filePath, selectedFile.value);

          if (uploadError) throw uploadError;

          // Get public URL for the uploaded file
          const { data } = await supabase.storage
            .from('server_icons')
            .getPublicUrl(filePath);
          
          // TODO: error handling?

          if (data) {
            serverData.icon = data.publicUrl; // Update icon URL in serverData
          }
        }

        // Update server data
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
    }
  }
});
