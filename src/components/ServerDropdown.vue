<template>
  <div class="server-dropdown" v-if="isVisible" v-click-outside="closeDropdown">
    <ul>
      <li v-if="canViewServerSettings" @click="goToServerSettings">
        {{ canManageServer ? 'Server Settings' : 'View Server Info' }}
      </li>
      <li v-if="canCreateCategories" @click="createCategory">Create Category</li>
      <li v-if="canCreateChannels" @click="createChannel">Create Channel</li>
      <li @click="generateInviteLink">Get Invite Link</li>
    </ul>
  </div>
</template>
  
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useServerPermissions } from '@/composables/useServerPermissions';

interface Props {
  serverId?: string
  isVisible?: boolean
}

const props = defineProps<Props>();

const emit = defineEmits<{
  toggle: []
  showCategoryCreator: [value: boolean]
  createChannel: [value: null]
  openInviteModal: []
}>();

const router = useRouter();
const { serverSettingsPermissions, channelPermissions } = useServerPermissions();

// Computed permissions
const canViewServerSettings = computed(() => serverSettingsPermissions.value.canViewSettings);
const canManageServer = computed(() => serverSettingsPermissions.value.canEditBasicInfo);
const canCreateCategories = computed(() => channelPermissions.value.canCreateCategories);
const canCreateChannels = computed(() => channelPermissions.value.canCreateChannels);

const createChannel = () => {
  emit('createChannel', null);
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
</script>
  
<style scoped>
  .server-dropdown {
    position: absolute;
    top: 100%;
    left: 8px;
    right: 0;
    z-index: 100;
    width: 226px;
    background-color: var(--vt-c-black-soft);
    color: white;
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
</style>
