import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import { useToast } from 'vue-toastification';
import { i18n } from '@/i18n';
import { immutableObjectPath, immutableUploadOptions, prepareImageUpload } from '@/utils/imageResize'
import { removeReplacedObject } from '@/utils/storageImageUtils'
import type { Server, Emoji } from '@/types';
import { debug } from '@/utils/debug'
import { invalidateServerMemberCache } from '@/services/usersService'
import { getBucketLimits, imageSourceError, validateImageUpload, humanizeUploadError } from '@/utils/uploadValidation'
import { usePublicServersStore } from '@/stores/usePublicServers'
import { pickServerSettings } from '@/utils/serverSettings'

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

        // versioned upload paths self-invalidate the CDN; capture old paths to delete after
        let oldIcon: string | null = null
        let oldBanner: string | null = null
        if ((file || bannerFile) && serverData.id) {
          const { data: existing } = await supabase
            .from('servers')
            .select('icon, banner')
            .eq('id', serverData.id)
            .single()
          oldIcon = existing?.icon ?? null
          oldBanner = existing?.banner ?? null
        }

        const sourceError = (file && imageSourceError(file)) || (bannerFile && imageSourceError(bannerFile));
        if (sourceError) {
          toast.error(sourceError);
          return false;
        }

        if (file && serverData.id) {
          const icon = await prepareImageUpload(file, 'server_icon', await getBucketLimits('server_icons'));
          const iconValidationError = await validateImageUpload(icon.file, 'server_icons');
          if (iconValidationError) {
            toast.error(iconValidationError);
            return false;
          }

          const filePath = immutableObjectPath(serverData.id, 'icon', icon.extension);

          debug.log('Uploading server icon to:', filePath);
          const { error: uploadError } = await supabase.storage
            .from('server_icons')
            .upload(filePath, icon.file, immutableUploadOptions(icon));

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
          const banner = await prepareImageUpload(bannerFile, 'server_banner', await getBucketLimits('server_banners'));
          const bannerValidationError = await validateImageUpload(banner.file, 'server_banners');
          if (bannerValidationError) {
            toast.error(bannerValidationError);
            return false;
          }

          const filePath = immutableObjectPath(serverData.id, 'banner', banner.extension);

          debug.log('Uploading server banner to:', filePath);
          const { error: uploadError } = await supabase.storage
            .from('server_banners')
            .upload(filePath, banner.file, immutableUploadOptions(banner));

          if (uploadError) {
            toast.error(humanizeUploadError(uploadError, 'server_banners'));
            return false;
          }

          dataToUpdate.banner = filePath;
        } else if (dataToUpdate.banner && dataToUpdate.banner.startsWith('blob:')) {
          delete dataToUpdate.banner;
        }

        const serverId = dataToUpdate.id;
        if (!serverId) {
          throw new Error('Server ID is required to update');
        }

        // update_server raises for a caller it refuses; the servers UPDATE policy would
        // match no row for a non-owner and report success.
        const { error } = await supabase.rpc('update_server', {
          p_server_id: serverId,
          p_changes: pickServerSettings(dataToUpdate),
        });

        if (error) throw error;
        usePublicServersStore().markStale();

        if (file && dataToUpdate.icon) {
          await removeReplacedObject('server_icons', oldIcon, dataToUpdate.icon, serverId)
        }
        if (bannerFile && dataToUpdate.banner) {
          await removeReplacedObject('server_banners', oldBanner, dataToUpdate.banner, serverId)
        }

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

    /** Joins a server from the public directory through join_public_server. */
    async joinServer(serverId: string): Promise<boolean> {
      const toast = useToast();
      
      try {
        const { data, error } = await supabase.rpc('join_public_server', { p_server_id: serverId });

        if (error) {
          if ((error.message || '').includes('BANNED_FROM_SERVER')) {
            toast.error(i18n.global.t('server.bannedFromServer'));
            return false;
          }
          if ((error.message || '').includes('SERVER_NOT_PUBLIC')) {
            toast.error(i18n.global.t('server.joinRequiresInvite'));
            return false;
          }
          throw error;
        }

        if ((data as { joined?: boolean } | null)?.joined === false) {
          toast.info("You're already a member of this server!");
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
            
            const { data: deleted, error: deleteError } = await supabase
              .from('servers')
              .delete()
              .eq('id', serverId)
              .eq('owner', userId)
              .select('id');

            if (deleteError) throw deleteError;
            if (!deleted?.length) throw new Error('Server delete matched no row');
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
