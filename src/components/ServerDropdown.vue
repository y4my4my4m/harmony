<template>
  <div class="server-dropdown" v-if="isVisible" v-click-outside="closeDropdown">
    <ul>
      <li v-if="canViewServerSettings" @click="goToServerSettings">
        {{ canManageServer ? $t('server.settings') : $t('server.overview') }}
      </li>
      <li v-if="canCreateCategories" @click="createCategory">{{ $t('server.createCategory') }}</li>
      <li v-if="canCreateChannels" @click="createChannel">{{ $t('channel.create') }}</li>
      <li @click="generateInviteLink">{{ $t('server.inviteLink') }}</li>
      <li v-if="!isOwner" class="leave-server" @click="confirmLeaveServer">
        {{ $t('server.leaveServer') }}
      </li>
    </ul>

    <ConfirmationModal
      :show="confirmDialogVisible"
      :title="confirmDialogTitle"
      :message="confirmDialogMessage"
      :confirm-button-text="confirmDialogConfirmText"
      @confirm="handleConfirm"
      @close="handleClose"
    />
  </div>
</template>
  
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
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
import ConfirmationModal from '@/components/ConfirmationModal.vue';

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

// Check if user is server owner
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

const {
  confirm,
  confirmDialogVisible,
  confirmDialogTitle,
  confirmDialogMessage,
  confirmDialogConfirmText,
  handleConfirm,
  handleClose,
} = useConfirmDialog()

const confirmLeaveServer = async () => {
  const server = serverChannelStore.currentServer;
  if (!server || !props.serverId) return;
  
  const confirmed = await confirm({
    title: 'Leave Server',
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
    
    // Check if it's a remote server (federated)
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
    
    toast.success('Left server successfully');
    await unsubscribeFromContext(props.serverId);
    emit('serverLeft');
    
    router.push('/');
  } catch (error: any) {
    console.error('Error leaving server:', error);
    toast.error(error.message || 'Failed to leave server');
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
    border-radius: 5px;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  
  .server-dropdown ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  
  .server-dropdown li {
    padding: 10px;
    cursor: pointer;
    transition: background-color 0.2s;
  }
  
  .server-dropdown li:hover {
    background-color: #424753;
  }

  .server-dropdown li.leave-server {
    color: #ed4245;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    margin-top: 4px;
    padding-top: 14px;
  }

  .server-dropdown li.leave-server:hover {
    background-color: rgba(237, 66, 69, 0.2);
    color: #ff6b6b;
  }
</style>
