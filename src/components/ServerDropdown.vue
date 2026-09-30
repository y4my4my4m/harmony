<template>
  <div class="server-dropdown" v-if="isVisible" v-click-outside="closeDropdown">
    <ul role="menu" @keydown.esc.stop="closeDropdown">
      <li v-if="canViewServerSettings" role="none">
        <button type="button" role="menuitem" class="dropdown-item" @click="goToServerSettings">
          {{ canManageServer ? $t('server.settings') : $t('server.overview') }}
        </button>
      </li>
      <li v-if="canCreateCategories" role="none">
        <button type="button" role="menuitem" class="dropdown-item" @click="createCategory">
          {{ $t('server.createCategory') }}
        </button>
      </li>
      <li v-if="canCreateChannels" role="none">
        <button type="button" role="menuitem" class="dropdown-item" @click="createChannel">
          {{ $t('channel.create') }}
        </button>
      </li>
      <li role="none">
        <button type="button" role="menuitem" class="dropdown-item" @click="generateInviteLink">
          {{ $t('server.inviteLink') }}
        </button>
      </li>
      <li v-if="!isOwner" role="none" class="leave-server">
        <button type="button" role="menuitem" class="dropdown-item" @click="confirmLeaveServer">
          {{ $t('server.leaveServer') }}
        </button>
      </li>
    </ul>
  </div>
</template>
  
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useConfirmDialog } from '@/composables/useConfirmDialog';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useChatStore } from '@/stores/useChat';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/supabase';
import { useToast } from 'vue-toastification';
import { federationServerService } from '@/services/federation/FederationServerService';
import { useUserData } from '@/composables/useUserData';

interface Props {
  serverId?: string
  isVisible?: boolean
}

const props = defineProps<Props>();

const emit = defineEmits<{
  toggle: []
  showCategoryCreator: [value: boolean]
  createChannel: [value?: string]
  openInviteModal: []
  serverLeft: []
}>();

const router = useRouter();
const { t } = useI18n();
const toast = useToast();
const authStore = useAuthStore();
const serverChannelStore = useServerChannelStore();
const { unsubscribeFromContext } = useUserData();
const { serverSettingsPermissions, channelPermissions } = useServerPermissions();

// Computed permissions
const canViewServerSettings = computed(() => serverSettingsPermissions.value.canViewSettings);
const canManageServer = computed(() => serverSettingsPermissions.value.canEditBasicInfo);
const canCreateCategories = computed(() => channelPermissions.value.canCreateCategories);
const canCreateChannels = computed(() => channelPermissions.value.canCreateChannels);

const isOwner = computed(() => {
  const server = serverChannelStore.currentServer;
  const userId = authStore.session?.user?.id;
  return server?.owner === userId;
});

const isLeaving = ref(false);

const createChannel = () => {
  emit('createChannel', undefined);
  closeDropdown();
};

const closeDropdown = () => {
  emit('toggle');
};

const createCategory = () => {
  emit('showCategoryCreator', true);
  closeDropdown();
};

const goToServerSettings = () => {
  // Navigate to server settings page
  router.push(`/server/${props.serverId}`);
  closeDropdown();
};

const generateInviteLink = () => {
  emit('openInviteModal');
  closeDropdown();
};

const { confirm } = useConfirmDialog()

const confirmLeaveServer = async () => {
  const server = serverChannelStore.currentServer;
  if (!server || !props.serverId) return;
  
  const confirmed = await confirm({
    title: t('server.leaveServer'),
    message: `Are you sure you want to leave "${server.name}"? You will lose access to all channels and messages.`,
    confirmButtonText: 'Leave',
    dangerAction: true,
  });
  
  if (!confirmed) {
    closeDropdown();
    return;
  }
  
  await leaveServer();
};

const leaveServer = async () => {
  const userId = authStore.session?.user?.id;
  if (!userId || !props.serverId) return;
  
  isLeaving.value = true;
  
  try {
    // Proactively disconnect voice chat if connected to this server
    const voiceStore = useUnifiedVoiceChannelStore();
    if (voiceStore.effectiveServerId === props.serverId) {
      await voiceStore.leaveVoiceChannel();
    }
    
    // Unsubscribe from message channel before leaving
    const chatStore = useChatStore();
    if (serverChannelStore.currentServerId === props.serverId) {
      chatStore.unsubscribeFromMessages();
      chatStore.clearMessages();
    }
    
    const server = serverChannelStore.currentServer;
    
    if (server && !server.is_local_server) {
      const result = await federationServerService.leaveServer(props.serverId, userId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to leave server');
      }
    } else {
      const { error } = await supabase
        .from('user_servers')
        .delete()
        .eq('server_id', props.serverId)
        .eq('user_id', userId);
      
      if (error) throw error;
    }
    
    toast.success('Left server');
    await unsubscribeFromContext(props.serverId);
    emit('serverLeft');
    
    router.push('/');
  } catch (error: any) {
    console.error('Error leaving server:', error);
    toast.error(error.message || "Couldn't leave server");
  } finally {
    isLeaving.value = false;
    closeDropdown();
  }
};
</script>
  
<style scoped>
  .server-dropdown {
    position: absolute;
    top: 100%;
    left: 8px;
    right: 0;
    z-index: 100;
    width: 226px;
    background-color: var(--background-secondary);
    color: var(--text-primary);
    border-radius: var(--radius-base);
    box-shadow: var(--shadow-medium);
    border: 1px solid var(--border-primary);
  }
  
  .server-dropdown ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  
  .dropdown-item {
    display: block;
    width: 100%;
    padding: 10px;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .dropdown-item:hover,
  .dropdown-item:focus-visible {
    background-color: var(--background-modifier-hover);
  }

  .dropdown-item:focus-visible {
    outline: none;
  }

  .server-dropdown li.leave-server {
    border-top: 1px solid var(--border-primary);
    margin-top: 4px;
    padding-top: 4px;
  }

  .leave-server .dropdown-item {
    color: var(--error);
  }

  .leave-server .dropdown-item:hover,
  .leave-server .dropdown-item:focus-visible {
    background-color: color-mix(in srgb, var(--error) 20%, transparent);
  }
</style>
