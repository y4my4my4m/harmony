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
          .upsert(serverData)
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

    async joinServer(serverId: string, userId: string): Promise<boolean> {
      try {
        const { data, error } = await supabase
          .from('user_servers')
          .insert([{ server_id: serverId, user_id: userId }]);

        if (error) throw error;

        console.log("Server joined successfully", data);
        return true;
      } catch (error) {
        console.error('Error joining server:', error);
        return false;
      }
    },
    async leaveServer(serverId: string, userId: string): Promise<boolean> {
      try {
        const { data, error } = await supabase
          .from('user_servers')
          .delete()
          .eq('server_id', serverId)
          .eq('user_id', userId);

        if (error) throw error;

        console.log("Server left successfully", data);
        return true;
      } catch (error) {
        console.error('Error leaving server:', error);
        return false;
      }
    },

    async deleteServer(serverId: string, userId: string): Promise<boolean> {
      try {
        // First verify the user is the owner
        const server = await this.getServer(serverId);
        if (!server || server.owner !== userId) {
          throw new Error('Only the server owner can delete the server');
        }

        // Use a transaction to ensure all deletions happen atomically
        const { error } = await supabase.rpc('delete_server_with_cleanup', {
          p_server_id: serverId,
          p_owner_id: userId
        });

        if (error) {
          // If the RPC function doesn't exist, fall back to the original method
          if (error.code === '42883') { // function does not exist
            console.warn('Server cleanup function not found, using fallback deletion');
            
            // Delete the server (this will cascade delete related data due to foreign key constraints)
            const { error: deleteError } = await supabase
              .from('servers')
              .delete()
              .eq('id', serverId)
              .eq('owner', userId); // Double check ownership in the query

            if (deleteError) throw deleteError;
          } else {
            throw error;
          }
        }

        // Also delete server icon from storage if it exists
        if (server.icon && server.icon !== '/default_server_icon.png') {
          try {
            const iconPath = server.icon.split('/').pop();
            if (iconPath) {
              await supabase.storage
                .from('server_icons')
                .remove([`${serverId}/${iconPath}`]);
            }
          } catch (iconError) {
            console.warn('Failed to delete server icon:', iconError);
            // Don't fail the entire operation if icon deletion fails
          }
        }

        console.log("Server deleted successfully");
        return true;
      } catch (error) {
        console.error('Error deleting server:', error);
        throw error; // Re-throw to allow proper error handling in the component
      }
    }
  }
});
