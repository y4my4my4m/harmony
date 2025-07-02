<template>
  <PublicServers 
    v-if="showPublicServers"
    @showPublicServers="handleShowPublicServers"
  />
  <NoServersSplash 
    v-if="showNoServersSplash"
    @showPublicServers="handleShowPublicServers"
  />
  <div v-else class="chat-layout">
    <ServerSidebar
      :class="{ 'open': isSidebarsVisible }"
      :servers="servers"
      @showPublicServers="handleShowPublicServers"
    />
    <ChannelSidebar
      :class="{ 'open': isSidebarsVisible }"
      :currentServer="currentServer"
      :channels="channels"
      :currentChannelId="currentChannelId"
      :categories="categories"
      :categoryChannels="categoryChannels"
      @channelSelected="handleChannelSelected"
      @createChannel="handleCreateChannel"
    />
    <CreateChannel
      :serverId="currentServer.id"
      :categoryId="currentCategoryId"
      :show="showCreateChannelForm"
      @channelCreated="handleChannelCreated"
      @close="showCreateChannelForm = false"
    />
    <div :class="{ 'open': isSidebarsVisible, 'profile-open': isProfilesVisible}" class="chat-area">
      <VoiceChannelScene 
        :currentChannelId="currentChannelId"
      />
      <ChatComponent
        :messages="chatMessages"
        @loadMoreMessages="fetchMoreMessages" 
        @update:isAtBottom="isAtBottom = $event" 
      />
    </div>
    <UserSidebar :class="{ 'open': isProfilesVisible }"  />
  </div>
</template>

<script lang="ts">
  import { defineComponent, computed, onMounted, onBeforeUnmount, ref, nextTick, watch } from 'vue';
  import ServerSidebar from '@/components/ServerSidebar.vue';
  import ChannelSidebar from '@/components/ChannelSidebar.vue';
  import ChatComponent from '@/components/ChatComponent.vue';
  import UserSidebar from '@/components/UserSidebar.vue';
  import NoServersSplash from '@/components/NoServersSplash.vue';
  import VoiceChannelScene from '@/components/VoiceChannelScene.vue';
  import CreateChannel from '@/components/CreateChannel.vue';
  import PublicServers from '@/components/PublicServers.vue';
  import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useServerChannelStore } from '@/stores/useServerChannel';
  import { useChatStore } from '@/stores/useChat';
  import { useAuthStore } from '@/stores/auth';
  import { useRoute, useRouter } from 'vue-router';
  import { useProfileStore } from '@/stores/useProfile';
  import { useToast } from "vue-toastification";
  import type { Channel } from "@/types";
  import { useChannelSelection } from '@/composables/useUserProfile'

  export default defineComponent({
    components: {
      ServerSidebar,
      ChannelSidebar,
      ChatComponent,
      UserSidebar,
      NoServersSplash,
      VoiceChannelScene,
      CreateChannel,
      PublicServers,
    },
    setup() {
      const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      const chatStore = useChatStore();
      const authStore = useAuthStore();
      const profileStore = useProfileStore();
      const toast = useToast();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const notificationSound = ref(new Audio('/assets/sounds/poi1.mp3'));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const notificationSound2 = ref(new Audio('/assets/sounds/bubble1.mp3'));

      const route = useRoute();
      const router = useRouter();
      let initialized = false;

      const showNoServersSplash = ref(false);
      const showPublicServers = ref(false);
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
      const currentCategoryId = ref<string | undefined>();

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
      
      const { getDefaultChannel } = useChannelSelection()

      const handleServerSelected = async (serverId: string) => {
        serverChannelStore.setCurrentServer(serverId);
        serverUsersStore.subscribeToUserStatuses();
        chatStore.clearMessages();
        await serverChannelStore.fetchCategoriesAndChannels(serverId);
        
        // Improved default channel selection
        if (serverChannelStore.channels.length > 0) {
          const defaultChannelId = getDefaultChannel(
            serverChannelStore.channels, 
            serverChannelStore.categories, 
            serverChannelStore.categoryChannels
          )
          if (defaultChannelId) {
            handleChannelSelected(defaultChannelId)
          }
        }
      };

      // Enhanced channel creation handler
      const handleChannelCreated = async (channel: Channel) => {
        await serverChannelStore.fetchCategoriesAndChannels(currentServer.value.id);
        showCreateChannelForm.value = false
        // Automatically navigate to the newly created channel
        handleChannelSelected(channel.id);
      }

      const handleChannelSelected = async (channelId: string) => {
        serverChannelStore.setCurrentChannel(channelId);
        // chatStore.clearMessages(); // Clear messages right when the channel is changed
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
          await handleServerSelected(serverId.toString());
          if (channelId) {
            await handleChannelSelected(channelId.toString());
          }
          else {
            // Let handleServerSelected handle default channel selection
            // The logic is now in handleServerSelected
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const showNotification = (title: string, options?: NotificationOptions) => {
        if (Notification.permission === 'granted') {
          // notificationSound.value.play();
          // new Notification(title, options);
        } else {
          toast.info('Notification permission not granted. Please allow notifications.');
        }
      };

      const handleShowPublicServers = (toggleState: boolean) => {
        showPublicServers.value = toggleState;
      };

      const startX = ref(0);
      const startY = ref(0);
      const endX = ref(0);
      const endY = ref(0);
      const swipeThreshold = 150; // Increase swipe threshold
      const verticalMovementThreshold = 150; // Adjust vertical movement threshold

      const handleTouchStart = (touchEvent: Event) => {
        const event = touchEvent as TouchEvent;
        startX.value = event.touches[0].clientX;
        startY.value = event.touches[0].clientY;
      };

      // const handleTouchMove = (touchEvent: Event) => {
      //   touchEvent.preventDefault();

      //   const event = touchEvent as TouchEvent;
      //   let deltaX = event.touches[0].clientX - startX.value;

      //   // Constrain deltaX to within the expected range
      //   deltaX = Math.max(Math.min(deltaX, swipeThreshold), -swipeThreshold);

      //   const sidebarElement = document.querySelector('.server-sidebar') as HTMLElement;
      //   const profileSidebarElement = document.querySelector('.user-sidebar') as HTMLElement;

      //   // Assuming a left swipe reveals the right (profile) sidebar and vice versa
      //   if (sidebarElement && deltaX > 0) { // Adjust for revealing server sidebar
      //     sidebarElement.style.transform = `translateX(${deltaX}px)`;
      //   } else if (profileSidebarElement && deltaX < 0) { // Adjust for revealing profile sidebar
      //     profileSidebarElement.style.transform = `translateX(${deltaX}px)`;
      //   }
      // };

      const handleTouchEnd = (touchEvent: Event) => {
        const event = touchEvent as TouchEvent;
        endX.value = event.changedTouches[0].clientX;
        endY.value = event.changedTouches[0].clientY;

        const deltaX = endX.value - startX.value;
        const deltaY = endY.value - startY.value;

        // Check for a horizontal swipe and limited vertical movement
        if (Math.abs(deltaX) > swipeThreshold && Math.abs(deltaY) < verticalMovementThreshold) {
          event.preventDefault(); // Prevent default behavior if it's clearly a swipe
          if (deltaX > 0) {
            // Swipe right
            toggleSidebars();
          } else {
            // Swipe left
            toggleProfiles();
          }
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
      
      // const usersInCurrentVoiceChannel = computed(() => {
      //   return serverUsersStore.getUsersInChannel(currentChannelId.value);
      // });

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

          initialized = true;
          if (servers.value.length === 0) {
            showNoServersSplash.value = true;
            return;
          }

          await loadServerAndChannel();
          requestNotificationPermission();

          const chatLayout = document.querySelector('#app');
          if (chatLayout)
          {
            chatLayout.addEventListener('touchstart', handleTouchStart);
            // chatLayout.addEventListener('touchmove', handleTouchMove);
            chatLayout.addEventListener('touchend', handleTouchEnd);
          }
          // wait 5 seconds then send a notification
          setTimeout(() => {
            showNotification('Welcome to Harmony!');
          }, 5000);
        }
      });

      onBeforeUnmount(() => {
        const chatLayout = document.querySelector('#app');
        if (chatLayout)
        {
          chatLayout.removeEventListener('touchstart', handleTouchStart);
          // chatLayout.removeEventListener('touchmove', handleTouchMove);
          chatLayout.removeEventListener('touchend', handleTouchEnd);
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
        handleChannelCreated,
        showPublicServers,
        handleShowPublicServers,
      };
  }
});
</script>

<style scoped>
.chat-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  position: relative;
}

.chat-area {
  position: relative;
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
  .server-sidebar, .channel-sidebar {
    width: 0;
    min-width: 0;
    overflow: hidden;
    /* Transition for smooth opening/closing */
    transition: 0.3s ease-in-out;
    /* margin-top: 40px; */
  }

  .user-sidebar {
    overflow: hidden;
    width:0;
    transition: 0.3s ease-in-out;
    padding: 0;
    /* margin-top:40px; */
  }
  .chat-area {
    transition: 0.3s ease-in-out;
    width: 100%;
    overflow: hidden;
    /* margin-top: 40px; */
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
