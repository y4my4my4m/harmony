<template>
  <div class="chat-layout">
    <ServerSidebar :servers="servers" @serverSelected="handleServerSelected" />
    <ChannelSidebar :channels="channels" @channelSelected="handleChannelSelected" />
    <div class="chat-area">
      <ChatComponent :channelId="currentChannelId" :messages="chatMessages" />
    </div>
    <UserSidebar />
  </div>
</template>

<script lang="ts">
  import { defineComponent, computed, onMounted } from 'vue';
  import ServerSidebar from '../components/ServerSidebar.vue';
  import ChannelSidebar from '../components/ChannelSidebar.vue';
  import ChatComponent from '../components/ChatComponent.vue';
  import UserSidebar from '../components/UserSidebar.vue';
  // import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useServerChannelStore } from '@/stores/useServerChannel';
  import { useChatStore } from '@/stores/useChat';
  import { useAuthStore } from '@/stores/auth';

  export default defineComponent({
    components: {
      ServerSidebar,
      ChannelSidebar,
      ChatComponent,
      UserSidebar
    },
    setup() {
      // const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      const chatStore = useChatStore();
      const authStore = useAuthStore();

      const servers = computed(() => serverChannelStore.servers);
      const channels = computed(() => serverChannelStore.channels);
      const chatMessages = computed(() => chatStore.messages);
      const currentChannelId = computed(() => serverChannelStore.currentChannelId || null);

      onMounted(() => {
        const userId = authStore.session?.user?.id;
        if (userId) {
          serverChannelStore.fetchServersForUser(userId);
        }
      });

      const handleServerSelected = (serverId: string) => {
        serverChannelStore.setCurrentServer(serverId);
        chatStore.clearMessages();
      };

      const handleChannelSelected = async (channelId: number) => {
        serverChannelStore.setCurrentChannel(channelId);
        await chatStore.fetchMessages(channelId);
        chatStore.subscribeToMessages(channelId);
      };

      return { servers, channels, chatMessages, currentChannelId, handleServerSelected, handleChannelSelected };
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
