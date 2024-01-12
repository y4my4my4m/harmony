<template>
  <div class="channel-sidebar">
    <h2>{{ currentServerName }}</h2>
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
import type { Channel } from '@/types'; // Adjust the import path as needed
import { useServerChannelStore } from '@/stores/useServerChannel';

export default defineComponent({
  name: 'ChannelSidebar',
  components: {
    UserProfileComponent,
  },
  props: {
    currentServerName: {
      type: String,
      required: true
    },
    channels: {
      type: Array as PropType<Channel[]>,
      required: true
    }
  },
  setup(_, { emit }) {
    // TODO: were using the store but maybe it should just be passed as a prop from ChatView?
    const serverChannelStore = useServerChannelStore();
    // Emit an event with the selected channelId
    const selectChannel = (selectedChannelId: number) => {
      emit('channelSelected', selectedChannelId);
    };

    return { selectChannel, serverChannelStore };
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
  margin-bottom:2px
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
