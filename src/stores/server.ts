import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import { useToast } from 'vue-toastification';
import type { Server, Emoji } from '@/types';
import { debug } from '@/utils/debug'
import { invalidateServerMemberCache } from '@/services/usersService'
import { validateImageUpload, humanizeUploadError } from '@/utils/uploadValidation'

export const useServerStore = defineStore('server', {
  actions: {
    async getServer(serverId: string): Promise<Server | null> {
      const { data, error } = await supabase
        .from('servers')
        .select('*')
        .eq('id', serverId)
        .single();

      if (error) throw error;
      return data;
    },

    async updateServer(serverData: Partial<Server>, file?: File, bannerFile?: File): Promise<boolean> {
      const toast = useToast();
      try {
        const dataToUpdate = { ...serverData }
        
        if (file && serverData.id) {
          const ext = file.name.split('.').pop();
          if (!ext) throw new Error('File must have an extension');

          const iconValidationError = await validateImageUpload(file, 'server_icons');
          if (iconValidationError) {
            toast.error(iconValidationError);
            return false;
          }

          const filePath = `${serverData.id}/${serverData.id}.${ext}`;

          debug.log('Uploading server icon to:', filePath);
          const { error: uploadError } = await supabase.storage
            .from('server_icons')
            .upload(filePath, file, {
              upsert: true
            });

          if (uploadError) {
            toast.error(humanizeUploadError(uploadError, 'server_icons'));
            return false;
          }

          dataToUpdate.icon = filePath;
        } else if (dataToUpdate.icon && dataToUpdate.icon.startsWith('blob:')) {
          delete dataToUpdate.icon;
        } else if (dataToUpdate.icon === '') {
          dataToUpdate.icon = '';
        }

        if (bannerFile && serverData.id) {
          const ext = bannerFile.name.split('.').pop();
          if (!ext) throw new Error('Banner file must have an extension');

          const bannerValidationError = await validateImageUpload(bannerFile, 'server_banners');
          if (bannerValidationError) {
            toast.error(bannerValidationError);
            return false;
          }

          const filePath = `${serverData.id}/${serverData.id}_banner.${ext}`;

          debug.log('Uploading server banner to:', filePath);
          const { error: uploadError } = await supabase.storage
            .from('server_banners')
            .upload(filePath, bannerFile, {
              upsert: true
            });

          if (uploadError) {
            toast.error(humanizeUploadError(uploadError, 'server_banners'));
            return false;
          }

          dataToUpdate.banner = filePath;
        } else if (dataToUpdate.banner && dataToUpdate.banner.startsWith('blob:')) {
          delete dataToUpdate.banner;
        }

        const { id: serverId, ...patch } = dataToUpdate;
        if (!serverId) {
          throw new Error('Server ID is required to update');
        }

        // Use PATCH update - not upsert. Chaining .eq() after .upsert() does not
        // reliably apply row filters on POST/merge in PostgREST, so privacy flags
        // (e.g. public) and other fields could fail to persist.
        const { error } = await supabase
          .from('servers')
          .update(patch)
          .eq('id', serverId);

        if (error) throw error;

        debug.log("Server updated successfully");
        return true;
      } catch (error) {
        debug.error('Error updating server:', error);
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
      const toast = useToast();
      
      try {
        const { error } = await supabase
          .from('user_servers')
          .insert([{ server_id: serverId, user_id: userId }]);

        if (error) {
          if (error.code === '23505') { // unique constraint: already a member
            debug.log("User is already a member of this server");
            toast.info("You're already a member of this server!");
            return true;
          }
          throw error;
        }

        invalidateServerMemberCache(serverId);
        return true;
      } catch (error) {
        debug.error('Error joining server:', error);
        toast.error("Failed to join server. Please try again.");
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

        invalidateServerMemberCache(serverId);
        debug.log("Server left successfully", data);
        return true;
      } catch (error) {
        debug.error('Error leaving server:', error);
        return false;
      }
    },

    async deleteServer(serverId: string, userId: string): Promise<boolean> {
      try {
        const server = await this.getServer(serverId);
        if (!server || server.owner !== userId) {
          throw new Error('Only the server owner can delete the server');
        }

        const { error } = await supabase.rpc('delete_server_with_cleanup', {
          p_server_id: serverId,
          p_owner_id: userId
        });

        if (error) {
          if (error.code === '42883') { // delete_server_with_cleanup RPC not deployed
            debug.warn('Server cleanup function not found, using fallback deletion');
            
            const { error: deleteError } = await supabase
              .from('servers')
              .delete()
              .eq('id', serverId)
              .eq('owner', userId);

            if (deleteError) throw deleteError;
          } else {
            throw error;
          }
        }

        if (server.icon && server.icon !== '/default_server.webp') {
          try {
            const iconPath = server.icon.split('/').pop();
            if (iconPath) {
              await supabase.storage
                .from('server_icons')
                .remove([`${serverId}/${iconPath}`]);
            }
          } catch (iconError) {
            debug.warn('Failed to delete server icon:', iconError);
            // Icon cleanup failure shouldn't fail the whole delete.
          }
        }

        debug.log("Server deleted successfully");
        return true;
      } catch (error) {
        debug.error('Error deleting server:', error);
        throw error;
      }
    }
  }
});
