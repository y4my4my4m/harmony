<template>
  <div class="channel-sidebar">
    <h2 @click="generateInvite">{{ currentServer.name }}</h2>
    <div v-for="channel in channels" :key="channel.id" :class="['channel-item', { 'selected': channel.id === serverChannelStore.currentChannelId }]" @click="selectChannel(channel.id)">
      # {{ channel.name }}
    </div>
    <UserProfileComponent />
  </div>
</template>
<script lang="ts">
import { defineComponent } from 'vue';
import type { PropType } from 'vue';
import UserProfileComponent from './UserProfileComponent.vue';
import type { Channel } from '@/types';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { generateInviteUrl } from '@/services/inviteService';
import { useAuthStore } from '@/stores/auth';
import { useToast } from "vue-toastification";

export default defineComponent({
  name: 'ChannelSidebar',
  components: {
    UserProfileComponent,
  },
  props: {
    currentServer: {
      type: Object,
      required: true
    },
    channels: {
      type: Array as PropType<Channel[]>,
      required: true
    }
  },
  setup(props, { emit }) {
    const toast = useToast();
    // TODO: were using the store but maybe it should just be passed as a prop from ChatView?
    const serverChannelStore = useServerChannelStore();
    const auth = useAuthStore();
    // Emit an event with the selected channelId
    const selectChannel = (selectedChannelId: number) => {
      emit('channelSelected', selectedChannelId);
    };

    const generateInvite = async () => {
      const userId = auth.session?.user?.id;
      const inviteUrl = await generateInviteUrl(props.currentServer.id, userId);
      if (inviteUrl) {
        console.log('Invite URL:', inviteUrl);
        navigator.clipboard.writeText(inviteUrl); // Copy to clipboard
        toast.success('Invite URL copied to clipboard'); // Show toast
      }
    };

    return { selectChannel, serverChannelStore, generateInvite };
  }
});
</script>

<style scoped>
.channel-sidebar {
  width: 240px;
  background-color: #2f3136;
  color: white;
  overflow-y: auto;
}

h2 {
  padding: 10px;
  font-size: 1.2rem;
  font-weight: 500;
  background: var(--vt-c-divider-light-2);
  position:relative;
  z-index:1;
  box-shadow: 0 1px 5px 0px rgba(0,0,0,0.25);
  margin-bottom:2px;
  cursor:pointer;
}

h2:hover {
  background: rgba(0,0,0,0.1);
}
.channel-item {
  padding: 10px;
  cursor: pointer;
  transition: 0.2s ease-in-out;
  &:hover {
    background-color: #36393f;
  }
}
.channel-item.selected {
  /* padding-left:25px; */
  position: relative;
  background-color: #36393f;
}
/* .channel-item::before {
  opacity:0;
  content: "";
  transition: 0.3s ease-in-out;
  left:0;
}
.channel-item.selected::before {
  content: "";
  position: absolute;
  left:8px;
  top:17px;
  opacity:1;
  border-radius: 50%;
  width: 8px;
  height: 8px;
  background-color: var(--vt-c-divider-dark-1);
} */
</style>
