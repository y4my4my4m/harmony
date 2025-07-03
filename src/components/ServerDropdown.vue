<template>
  <div class="server-dropdown" v-if="isVisible" v-click-outside="closeDropdown">
    <ul>
      <li v-if="canViewServerSettings" @click="goToServerSettings">
        {{ canManageServer ? 'Server Settings' : 'View Server Info' }}
      </li>
      <li v-if="canCreateCategories" @click="createCategory">Create Category</li>
      <li v-if="canCreateChannels" @click="createChannel">Create channel</li>
      <li @click="generateInviteLink">Get Invite Link</li>
    </ul>
  </div>
</template>
  
<script lang="ts">
  import { defineComponent, computed } from 'vue';
  import { generateInviteUrl } from '@/services/inviteService';
  import { useAuthStore } from '@/stores/auth';
  import { useToast } from "vue-toastification";
  import { useRouter } from 'vue-router';
  import { useServerPermissions } from '@/composables/useServerPermissions';
  
  export default defineComponent({
    props: {
      serverId: String,
      isVisible: Boolean,
    },
    emits: ['toggle', 'showCategoryCreator', 'createChannel'],
    setup(props, { emit }) {
      const auth = useAuthStore();
      const router = useRouter();
      const toast = useToast();
      const { serverSettingsPermissions, channelPermissions } = useServerPermissions();

      // Computed permissions
      const canViewServerSettings = computed(() => serverSettingsPermissions.value.canViewSettings);
      const canManageServer = computed(() => serverSettingsPermissions.value.canEditBasicInfo);
      const canCreateCategories = computed(() => channelPermissions.value.canCreateCategories);
      const canCreateChannels = computed(() => channelPermissions.value.canCreateChannels);

      const createChannel = () => {
        emit('createChannel', null);
      };

      const closeDropdown = () => {
        emit('toggle');
      };

      const createCategory = async () => {
        emit('showCategoryCreator', true);
        closeDropdown();
      };

      const goToServerSettings = () => {
        // Navigate to server settings page
        router.push(`/server/${props.serverId}`);
        closeDropdown();
      };
      const generateInviteLink = async () => {
        const userId = auth.session?.user?.id;
        const inviteUrl = await generateInviteUrl(props.serverId || '', userId);
        if (inviteUrl) {
            console.log('Invite URL:', inviteUrl);
            navigator.clipboard.writeText(inviteUrl); // Copy to clipboard
            toast.success('Invite URL copied to clipboard'); // Show toast
        }
        closeDropdown();
      };
  
      return { 
        goToServerSettings, 
        createCategory,
        generateInviteLink,
        closeDropdown,
        createChannel,
        canViewServerSettings,
        canManageServer,
        canCreateCategories,
        canCreateChannels
      };
    }
  });
</script>
  
<style scoped>
  .server-dropdown {
    z-index: 20;
    position: absolute;
    left:82px;
    width:220px;
    background-color: var(--vt-c-black-soft);
    color: white;
    border-radius: 5px;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    display:block;
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
