<template>
    <div class="server-dropdown" v-click-outside="closeDropdown">
      <ul>
        <li @click="goToServerSettings">Server Settings</li>
        <li @click="generateInviteLink">Get Invite Link</li>
        <!-- Additional options -->
      </ul>
    </div>
  </template>
  
<script lang="ts">
  import { defineComponent, ref } from 'vue';
  import { generateInviteUrl } from '@/services/inviteService';
  import { useAuthStore } from '@/stores/auth';
  import { useToast } from "vue-toastification";
  import { useRouter } from 'vue-router';
  
  export default defineComponent({
    props: {
      serverId: String
    },
    setup(props) {
      const showDropdown = ref(false);
      const auth = useAuthStore();
      const router = useRouter();
      const toast = useToast();
  
      const closeDropdown = () => {
        showDropdown.value = false;
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
  
      return { showDropdown, goToServerSettings, generateInviteLink, closeDropdown };
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
  