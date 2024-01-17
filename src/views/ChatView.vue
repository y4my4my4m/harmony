<template>
  <div v-if="showNoServersSplash">
    <NoServersSplash />
  </div>
  <div v-else class="chat-layout">
    <ServerSidebar :servers="servers" />
    <ChannelSidebar :currentServer="currentServer" :channels="channels" :currentChannelId="currentChannelId" :categories="categories" :categoryChannels="categoryChannels" @channelSelected="handleChannelSelected" @createChannel="showCreateChannelForm = true"/>
    <CreateChannel
      :serverId="currentServer.id"
      :show="showCreateChannelForm"
      @close="showCreateChannelForm = false"
    />
    <div class="chat-area">
      <ChatComponent 
        :messages="chatMessages"
        @loadMoreMessages="fetchMoreMessages" 
        @update:isAtBottom="isAtBottom = $event" />
    </div>
    <UserSidebar />
  </div>
</template>

<script lang="ts">
  import { defineComponent, computed, onMounted, ref, nextTick, watch } from 'vue';
  import ServerSidebar from '@/components/ServerSidebar.vue';
  import ChannelSidebar from '@/components/ChannelSidebar.vue';
  import ChatComponent from '@/components/ChatComponent.vue';
  import UserSidebar from '@/components/UserSidebar.vue';
  import NoServersSplash from '@/components/NoServersSplash.vue';
  import CreateChannel from '@/components/CreateChannel.vue';
  import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useServerChannelStore } from '@/stores/useServerChannel';
  import { useChatStore } from '@/stores/useChat';
  import { useAuthStore } from '@/stores/auth';
  import { useRoute, useRouter } from 'vue-router';
  import { useProfileStore } from '@/stores/useProfile';

  export default defineComponent({
    components: {
      ServerSidebar,
      ChannelSidebar,
      ChatComponent,
      UserSidebar,
      NoServersSplash,
      CreateChannel,
    },
    setup() {
      const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      const chatStore = useChatStore();
      const authStore = useAuthStore();
      const profileStore = useProfileStore();

      const route = useRoute();
      const router = useRouter();
      let initialized = false;

      const showNoServersSplash = ref(false);
      const isAtBottom = ref(true); // Default to true for initial load

      const servers = computed(() => serverChannelStore.servers);
      const channels = computed(() => serverChannelStore.channels);
      const categories = computed(() => serverChannelStore.categories);
      const categoryChannels = computed(() => serverChannelStore.categoryChannels);
      const chatMessages = computed(() => chatStore.messages);
      const currentServerName = computed(() => serverChannelStore.currentServer.name || '');
      const currentChannelId = computed(() => serverChannelStore.currentChannelId || '');
      const currentServer = computed(() => serverChannelStore.currentServer);
      const showCreateChannelForm = ref(false);

      // Method to manually scroll to the bottom
      const scrollToBottom = () => {
        isAtBottom.value = true;
        // Use nextTick to wait for the DOM to update
        nextTick(() => {
          const chatArea = document.querySelector('.message-display');
          if (chatArea) {
            chatArea.scrollTop = chatArea.scrollHeight;
          }
        });
      };

      const handleChannelCreated = (newChannel:any) => {
        console.log('New channel created:', newChannel);
        // Add logic to update the channels list or perform other actions
        // Example: serverChannelStore.addChannel(newChannel);
        showCreateChannelForm.value = false; // Hide the form after successful creation
      };
      
      const handleServerSelected = async (serverId: string) => {
        serverChannelStore.setCurrentServer(serverId);
        serverUsersStore.subscribeToUserStatuses();
        chatStore.clearMessages();
        await serverChannelStore.fetchCategoriesAndChannels(serverId);
        // await serverChannelStore.fetchChannels(serverId);
        // if (serverChannelStore.channels.length > 0) {
        //   handleChannelSelected(serverChannelStore.channels[0].id);
        // }
      };

      const handleChannelSelected = async (channelId: string) => {
        serverChannelStore.setCurrentChannel(channelId);
        await chatStore.fetchMessages(channelId);
        chatStore.subscribeToMessages(channelId);
        scrollToBottom();
      };

      const fetchMoreMessages = async () => {
        if (!chatStore.allMessagesLoaded && !chatStore.loadingOlderMessages && serverChannelStore.currentChannelId) {
          const oldestMessageId = chatMessages.value[0]?.id || 0;
          await chatStore.fetchMessages(serverChannelStore.currentChannelId, Number(oldestMessageId));
        }
      };

      const loadServerAndChannel = async () => {
        const serverId = route.params.serverId;
        const channelId = route.params.channelId;
        if (serverId) {
          // console.log('Loading server and channel:', serverId, channelId);
          await handleServerSelected(serverId.toString());
          if (channelId) {
            await handleChannelSelected(channelId.toString());
          }
          else {
            if (serverChannelStore.channels.length > 0) {
              handleChannelSelected(serverChannelStore.channels[0].id);
            }
          }
        } else if (serverChannelStore.servers.length > 0) {
          const firstServerId = serverChannelStore.servers[0].id;
          router.replace({ name: 'Chat', params: { serverId: firstServerId } });
        }
      };

      onMounted(async () => {
        const userId = authStore.session?.user?.id;
        if (userId) {
          try {
            // make sure this is only checked once?
            await profileStore.checkProfileCompletion(userId);
          } catch (error: any) {
            console.log(error);
            router.push('/new-profile');
          }
          await serverChannelStore.fetchServersForUser(userId);
          initialized = true;
          if (servers.value.length === 0) {
            showNoServersSplash.value = true;
            return;
          }
          await loadServerAndChannel();
        }
      });

      watch(route, () => {
        if (initialized) loadServerAndChannel();
      }, { immediate: true });

      return { 
        servers, 
        channels, 
        categories,
        categoryChannels,
        chatMessages, 
        currentServerName, 
        currentServer, 
        currentChannelId, 
        showNoServersSplash, 
        handleServerSelected, 
        handleChannelCreated, 
        showCreateChannelForm, 
        handleChannelSelected,
        fetchMoreMessages,
        isAtBottom,
        scrollToBottom
      };
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
  background: var(--h-chat);
  padding-top: 6px;
}

</style>
