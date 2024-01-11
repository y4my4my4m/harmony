<template>
  <div class="chat-layout">
    <ServerSidebar />
    <ChannelSidebar />
    <div class="chat-area">
      <ChatComponent :channelId="currentChannelId" />
    </div>
    <UserSidebar />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';
import ServerSidebar from '../components/ServerSidebar.vue';
import ChannelSidebar from '../components/ChannelSidebar.vue';
import ChatComponent from '../components/ChatComponent.vue';
import UserSidebar from '../components/UserSidebar.vue';
import { useServerChannelStore } from '@/stores/useServerChannel';

export default defineComponent({
  components: {
    ServerSidebar,
    ChannelSidebar,
    ChatComponent,
    UserSidebar
  },
  setup() {
    const serverChannelStore = useServerChannelStore();
    const currentChannelId = computed(() => serverChannelStore.currentChannelId);
    return { currentChannelId };
  }
});
</script>

<style scoped>
.chat-layout {
  display: flex;
  height: 100vh;
  width: 100vw; /* Ensure it takes the full viewport width */
  position: relative;
}

.chat-area {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
}

</style>
