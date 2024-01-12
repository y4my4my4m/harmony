<template>
  <div v-if="showNoServersSplash">
    <NoServersSplash />
  </div>
  <div v-else class="chat-layout">
    <ServerSidebar :servers="servers" @serverSelected="handleServerSelected" />
    <ChannelSidebar :channels="channels" @channelSelected="handleChannelSelected" />
    <div class="chat-area">
      <ChatComponent :channelId="currentChannelId" :messages="chatMessages" />
    </div>
    <UserSidebar />
  </div>
</template>

<script lang="ts">
  import { defineComponent, computed, onMounted, ref } from 'vue';
  import ServerSidebar from '@/components/ServerSidebar.vue';
  import ChannelSidebar from '@/components/ChannelSidebar.vue';
  import ChatComponent from '@/components/ChatComponent.vue';
  import UserSidebar from '@/components/UserSidebar.vue';
  import NoServersSplash from '@/components/NoServersSplash.vue';
  import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useServerChannelStore } from '@/stores/useServerChannel';
  import { useChatStore } from '@/stores/useChat';
  import { useAuthStore } from '@/stores/auth';

  export default defineComponent({
    components: {
      ServerSidebar,
      ChannelSidebar,
      ChatComponent,
      UserSidebar,
      NoServersSplash
    },
    setup() {
      const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      const chatStore = useChatStore();
      const authStore = useAuthStore();

      const showNoServersSplash = ref(false);

      const servers = computed(() => serverChannelStore.servers);
      const channels = computed(() => serverChannelStore.channels);
      const chatMessages = computed(() => chatStore.messages);
      const currentChannelId = computed(() => serverChannelStore.currentChannelId || null);

      onMounted(async () => {
        const userId = authStore.session?.user?.id;
        if (userId) {
          await serverChannelStore.fetchServersForUser(userId);
          if (serverChannelStore.servers.length > 0) {
            handleServerSelected(serverChannelStore.servers[0].id);
          }
          else {
            showNoServersSplash.value = true;
          }
        }
      });

      const handleServerSelected = async (serverId: string) => {
        serverChannelStore.setCurrentServer(serverId);
        serverUsersStore.subscribeToUserStatuses();
        chatStore.clearMessages();
        await serverChannelStore.fetchChannels(serverId);
        if (serverChannelStore.channels.length > 0) {
          handleChannelSelected(serverChannelStore.channels[0].id);
        }
      };

      const handleChannelSelected = async (channelId: number) => {
        serverChannelStore.setCurrentChannel(channelId);
        await chatStore.fetchMessages(channelId);
        chatStore.subscribeToMessages(channelId);
      };

      return { servers, channels, chatMessages, currentChannelId, showNoServersSplash, handleServerSelected, handleChannelSelected };
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
