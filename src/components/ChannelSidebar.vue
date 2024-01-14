<template>
  <div class="channel-sidebar">
    <div class="server-name" @click="toggleDropdown">
      {{ currentServer.name }}
    </div>
    <ServerDropdown :serverId="currentServer.id" v-show="showDropdown" />
    <div class="create-channel" @click="emitCreateChannel">+ Create Channel</div>
    <div v-for="channel in channels" :key="channel.id" :class="['channel-item', { 'selected': channel.id === serverChannelStore.currentChannelId }]" @click="selectChannel(channel.id)">
      # {{ channel.name }}
    </div>
    <UserProfileComponent />
  </div>
</template>
<script lang="ts">
import { defineComponent, ref } from 'vue';
import type { PropType } from 'vue';
import type { Channel } from '@/types';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useRouter } from 'vue-router';

import UserProfileComponent from './UserProfileComponent.vue';
import ServerDropdown from './ServerDropdown.vue';

export default defineComponent({
  name: 'ChannelSidebar',
  components: {
    UserProfileComponent,
    ServerDropdown,
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
    const showDropdown = ref(false);
    // TODO: were using the store but maybe it should just be passed as a prop from ChatView?
    const serverChannelStore = useServerChannelStore();
    const router = useRouter();

    const selectChannel = (channelId: number) => {
      router.push({ name: 'Chat', params: { serverId: props.currentServer.id, channelId: channelId } });
    };

    const emitCreateChannel = () => {
      emit('createChannel');
    }

    const toggleDropdown = () => {
      showDropdown.value = !showDropdown.value;
    };

    return { selectChannel, serverChannelStore, showDropdown, emitCreateChannel, toggleDropdown };
  }
});
</script>

<style scoped>
.channel-sidebar {
  width: 240px;
  background-color: var(--h-sidebar);
  color: white;
  overflow-y: auto;
}

.server-name {
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


.server-name:hover {
  background: rgba(0,0,0,0.1);
}
.channel-item {
  padding: 6px 10px;
  cursor: pointer;
  transition: 0.2s ease-in-out;
  &:hover {
    background-color: var(--h-sidebar-light);
  }
}
.channel-item.selected {
  /* padding-left:25px; */
  position: relative;
  background-color: var(--h-sidebar-light);
}
.create-channel {
  cursor:pointer;
  padding: 2px 10px;
  transition: 0.2s ease-in-out;
  font-size: 12px;
  background: var(--vt-c-divider-dark-2);
}
.create-channel:hover {
  background: var(--vt-c-divider-dark-1);
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
