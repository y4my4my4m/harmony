<template>
  <div class="top-bar">
    <div class="show-left" @click="toggleSidebars">←</div>
    <div class="show-right" @click="toggleProfiles">→</div>
  </div>
  <div v-if="showNoServersSplash">
    <NoServersSplash />
  </div>
  <div v-else class="chat-layout">
    <ServerSidebar :class="{ 'open': isSidebarsVisible }" :servers="servers" />
    <ChannelSidebar :class="{ 'open': isSidebarsVisible }" :currentServer="currentServer" :channels="channels" :currentChannelId="currentChannelId" :categories="categories" :categoryChannels="categoryChannels" @channelSelected="handleChannelSelected" @createChannel="handleCreateChannel"/>
    <CreateChannel
      :serverId="currentServer.id"
      :categoryId="currentCategoryId"
      :show="showCreateChannelForm"
      @channelCreated="handleChannelCreated"
      @close="showCreateChannelForm = false"
    />
    <div :class="{ 'open': isSidebarsVisible, 'profile-open': isProfilesVisible}"  class="chat-area">
      <ChatComponent 
        :messages="chatMessages"
        @loadMoreMessages="fetchMoreMessages" 
        @update:isAtBottom="isAtBottom = $event" />
    </div>
    <UserSidebar :class="{ 'open': isProfilesVisible }"  />
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
  import { useToast } from "vue-toastification";
  import type { Channel } from "@/types";

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
      const toast = useToast();
      const notificationSound = ref(new Audio('/assets/sounds/poi1.mp3'));
      const notificationSound2 = ref(new Audio('/assets/sounds/bubble1.mp3'));

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
      const currentCategoryId = ref<string | null>(null);

      const isSidebarsVisible = ref(false);
      const isProfilesVisible = ref(false);

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

      const handleCreateChannel = (categoryId: string) => {
        currentCategoryId.value = categoryId;
        showCreateChannelForm.value = true;
      };
      const handleChannelCreated = async (channel: Channel) => {
        console.log(channel);
        await serverChannelStore.fetchCategoriesAndChannels(currentServer.value.id);
        // uncomment this to automatically go to the new channel
        // handleChannelSelected(channel.id);
      }

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
        // isAtBottom.value == false && 
        if (!chatStore.allMessagesLoaded && !chatStore.loadingOlderMessages && serverChannelStore.currentChannelId) {
          const oldestMessageId = chatMessages.value[0]?.id || '';
          await chatStore.fetchMessages(serverChannelStore.currentChannelId, oldestMessageId);
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

      const requestNotificationPermission = async () => {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          // toast.success('Notification permission granted.');
          // notificationSound2.value.play();
        } else {
          toast.error('Notification permission denied.');
        }
      };

      const showNotification = (title: string, options?: NotificationOptions) => {
        if (Notification.permission === 'granted') {
          // notificationSound.value.play();
          // new Notification(title, options);
        } else {
          toast.info('Notification permission not granted. Please allow notifications.');
        }
      };

      const toggleSidebars = () => {
        // if currently viewing chat
        if(isProfilesVisible.value == false)
        {
          isSidebarsVisible.value = !isSidebarsVisible.value;
        }
        else {
          isProfilesVisible.value = !isProfilesVisible.value;
        }
      };

      const toggleProfiles = () => {
        // if currently viewing chat
        if(isSidebarsVisible.value == false)
        {
          isProfilesVisible.value = !isProfilesVisible.value;

        }
        else {
          isSidebarsVisible.value = !isSidebarsVisible.value;
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

          await serverChannelStore.initializeUserEnvironment(userId);
          // await serverChannelStore.fetchServersForUser(userId);
          initialized = true;
          if (servers.value.length === 0) {
            showNoServersSplash.value = true;
            return;
          }
          // await serverChannelStore.fetchAllEmojis();
          await loadServerAndChannel();
          requestNotificationPermission();

          // wait 5 seconds then send a notification
          setTimeout(() => {
            showNotification('Welcome to Harmony!');
          }, 5000);
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
        showCreateChannelForm, 
        handleChannelSelected,
        fetchMoreMessages,
        isAtBottom,
        scrollToBottom,
        requestNotificationPermission,
        showNotification,
        toggleSidebars,
        isSidebarsVisible,
        toggleProfiles,
        handleCreateChannel,
        isProfilesVisible,
        currentCategoryId,
        handleChannelCreated
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
.top-bar {
  display: none;
}
/* Mobile styles */
@media (max-width: 768px) {
  .top-bar {
    position: fixed;
    top:0;
    z-index:100;
    width:100%;
    height: 40px;
    background: var(--h-chat-darker);
    display: flex;
    justify-content: space-between;
  }
  .show-left,
  .show-right {
    width: 35px;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    background: var(--h-chat-dark);
  }

  .server-sidebar, .channel-sidebar {
    width: 0;
    min-width: 0;
    overflow: hidden;
    /* Transition for smooth opening/closing */
    transition: 0.3s ease-in-out;
    margin-top: 40px;
  }

  .user-sidebar {
    overflow: hidden;
    width:0;
    transition: 0.3s ease-in-out;
    padding: 0;
    margin-top:40px;
  }
  .chat-area {
    transition: 0.3s ease-in-out;
    width: 100%;
    overflow: hidden;
    margin-top: 40px;
  }
  .chat-container {
    width: 100%;
    overflow: hidden;
  }
  .chat-area.open {
    position: absolute;
    overflow: hidden;
    left:100%;
    width:0;
  }
  .chat-area.profile-open {
    overflow: hidden;
    right:100%;
    width:0;
  }
  .server-sidebar.open {
    width: 72px;
  }
  .channel-sidebar.open {
    width: 100%;
  }
  .user-sidebar.open {
    display:block;
    width: 100%;
    padding: 10px;
  }
}
</style>
