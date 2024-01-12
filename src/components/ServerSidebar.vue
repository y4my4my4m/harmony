<template>
  <div class="server-sidebar">
    <div v-for="server in servers" :key="server.id" class="server-item" @click="selectServer(server.id)">
      {{ server.name }}
    </div>
  </div>
</template>

<script setup lang="ts">
  import { defineProps, defineEmits } from 'vue';
  import type { Server } from '@/types';

  defineProps({
    // make an array of type Server
    servers: {
      type: Array as () => Server[],
      required: true
    }
  });
  const emits = defineEmits(['serverSelected']);

  const selectServer = (serverId: string) => {
    emits('serverSelected', serverId);
  };
</script>

<style scoped>
.server-sidebar {
  width: 72px;
  background-color: #202225;
}
.server-item {
  width: 64px;
  height: 64px;
  background-color: #313336;
  margin: 4px;
  padding: 4px;
  border-radius: 50%;
  text-align:center;
  vertical-align: middle;
}
</style>
