<template>
  <div class="server-sidebar">
    <div v-for="server in servers" :key="server.id" class="server-item" @click="selectServer(server.id)">
      {{ server.name }}
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed, watch } from 'vue';
  import { useAuthStore } from '@/stores/auth';
  import { useServerChannelStore } from '@/stores/useServerChannel';

  const authStore = useAuthStore();
  const userId = computed(() => authStore.session?.user?.id);
  const serverChannelStore = useServerChannelStore();
  const servers = serverChannelStore.servers;


  watch(userId, (newUserId) => {
    if (newUserId) {
      serverChannelStore.fetchServersForUser(newUserId);
    }
  }, { immediate: true });

  const selectServer = (serverId: string) => {
    serverChannelStore.setCurrentServer(serverId);
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
