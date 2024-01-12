<template>
  <div class="channel-sidebar">
    <!-- Iterate over channels and emit event when a channel is clicked -->
    <div v-for="channel in channels" :key="channel.id" class="channel-item" @click="selectChannel(channel.id)">
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
  setup(_, { emit }) {
    const serverChannelStore = useServerChannelStore();
    const channels = computed(() => serverChannelStore.channels);

    // Emit an event with the selected channelId
    const selectChannel = (channelId: number) => {
      emit('channelSelected', channelId);
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
