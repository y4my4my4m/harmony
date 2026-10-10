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
      <li role="none">
        <button type="button" role="menuitem" class="dropdown-item" data-testid="server-notification-settings" @click="openNotificationSettings">
          {{ $t('notificationSettings.menuEntry') }}
        </button>
      </li>
      <li v-if="showWelcomeEntry" role="none">
        <button type="button" role="menuitem" class="dropdown-item" data-testid="server-welcome-entry" @click="openWelcome">
          {{ $t('serverWelcome.menuEntry') }}
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
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useServerWelcomeStore } from '@/stores/useServerWelcome';
import { useLeaveServer } from '@/composables/useLeaveServer';
import { useServerNotificationSettingsStore } from '@/stores/useServerNotificationSettings';

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
const serverChannelStore = useServerChannelStore();
const { serverSettingsPermissions, channelPermissions } = useServerPermissions();

// Computed permissions
const canViewServerSettings = computed(() => serverSettingsPermissions.value.canViewSettings);
const canManageServer = computed(() => serverSettingsPermissions.value.canEditBasicInfo);
const canCreateCategories = computed(() => channelPermissions.value.canCreateCategories);
const canCreateChannels = computed(() => channelPermissions.value.canCreateChannels);

const isOwner = computed(() => isServerOwner(serverChannelStore.currentServer));

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

const notificationSettingsStore = useServerNotificationSettingsStore();

const openNotificationSettings = () => {
  if (props.serverId) notificationSettingsStore.openModal(props.serverId);
  closeDropdown();
};

const welcomeStore = useServerWelcomeStore();
const showWelcomeEntry = computed(() => welcomeStore.hasScreen(props.serverId));

const openWelcome = () => {
  if (props.serverId) void welcomeStore.open(props.serverId);
  closeDropdown();
};

const { leaveServer, isOwner: isServerOwner } = useLeaveServer();

const confirmLeaveServer = async () => {
  if (!props.serverId) return;
  const left = await leaveServer(props.serverId);
  if (left) emit('serverLeft');
  closeDropdown();
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
