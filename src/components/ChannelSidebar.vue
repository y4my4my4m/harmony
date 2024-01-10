<template>
  <div class="channel-sidebar">
    <div v-for="channel in channels" :key="channel.id" class="channel-item">
      {{ channel.name }}
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';
import type { Channel } from '../types';

export default defineComponent({
  name: 'ChannelSidebar',
  setup() {
    const channels = ref<Channel[]>([
      { id: 1, name: 'General', type: 'text', messages: [] },
      { id: 2, name: 'Random', type: 'text', messages: [] },
      { id: 3, name: 'Voice 1', type: 'voice', messages: [] }
      // Add more mock channels as needed
    ]);

    return { channels };
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
