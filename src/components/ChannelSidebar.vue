<template>
  <div class="channel-sidebar">
    <div v-for="channel in channels" :key="channel.id" class="channel-item" @click="selectChannel(channel.id.toString())">
      {{ channel.name }}
    </div>
    <UserProfileComponent />
  </div>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue';
import UserProfileComponent from './UserProfileComponent.vue';
import { useServerChannelStore } from '@/stores/useServerChannel';

export default defineComponent({
  name: 'ChannelSidebar',
  components: {
    UserProfileComponent,
  },
  setup() {
    const serverChannelStore = useServerChannelStore();
    const channels = computed(() => serverChannelStore.channels);

    const selectChannel = (channelId: string) => {
      serverChannelStore.setCurrentChannel(channelId);
    };

    return { channels, selectChannel };
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

.channel-item {
  padding: 10px;
  cursor: pointer;
  &:hover {
    background-color: #36393f;
  }
}
</style>
