<template>
  <!-- Loading Screen - Show during initial app load only -->
  <div v-if="!isAppReady" class="loading-overlay">
    <div class="loading-spinner">
      <div class="spinner"></div>
      <p>Loading Harmony...</p>
    </div>
  </div>
  
  <!-- No Servers Splash - Only show if no servers and not in DM mode -->
  <NoServersSplash 
    v-else-if="shouldShowNoServersSplash"
    @showPublicServers="handleShowPublicServers"
  />
  
  <!-- Main Chat Layout -->
  <div v-else class="chat-layout">
    <!-- Left sidebar container that holds both server and channel/DM sidebars -->
    <div class="left-sidebar-container" :class="{ 'open': isSidebarsVisible }">
      <ServerSidebar
        :servers="servers"
        @showPublicServers="handleShowPublicServers"
      />
      <ChannelSidebar
        v-if="!isDM"
        :currentServer="currentServer"
        :channels="channels"
        :currentChannelId="currentChannelId"
        :categories="categories"
        :categoryChannels="categoryChannels"
        @channelSelected="handleChannelSelected"
        @createChannel="handleCreateChannel"
      />
      <DMSidebar
        v-else
        @conversationSelected="handleDMConversationSelected"
      />
      
      <!-- User Profile spanning the full width of both sidebars -->
      <UserProfileComponent />
    </div>
    
    <CreateChannel
      v-if="!isDM"
      :serverId="currentServer?.id || ''"
      :categoryId="currentCategoryId"
      :show="showCreateChannelForm"
      @channelCreated="handleChannelCreated"
      @close="showCreateChannelForm = false"
    />
    <div :class="{ 'open': isSidebarsVisible, 'profile-open': isProfilesVisible}" class="chat-area">
      <VoiceChannelScene 
        v-if="!isDM"
        :currentChannelId="currentChannelId"
        :serverId="currentServer?.id"
      />
      <ChatComponent
        :messages="chatMessages"
        :isLoading="isLoading"
        :isDM="isDM"
        @loadMoreMessages="fetchMoreMessages" 
        @update:isAtBottom="isAtBottom = $event" 
        @sendMessage="handleSendMessage"
      />
    </div>
    <UserSidebar :class="{ 'open': isProfilesVisible }"  />
    
    <PublicServers 
      v-if="showPublicServers"
      :force-refresh="shouldForceRefreshPublicServers"
      @close="handleClosePublicServers"
    />
  </div>
</template>

<script setup lang="ts">
  import { computed, onMounted, onBeforeUnmount, ref, nextTick, watch } from 'vue';
  import ServerSidebar from '@/components/ServerSidebar.vue';
  import ChannelSidebar from '@/components/ChannelSidebar.vue';
  import DMSidebar from '@/components/DMSidebar.vue';
  import ChatComponent from '@/components/ChatComponent.vue';
  import UserSidebar from '@/components/UserSidebar.vue';
  import UserProfileComponent from '@/components/UserProfileComponent.vue';
  import NoServersSplash from '@/components/NoServersSplash.vue';
  import VoiceChannelScene from '@/components/VoiceChannelScene.vue';
  import CreateChannel from '@/components/CreateChannel.vue';
  import PublicServers from '@/components/PublicServers.vue';
  import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useServerChannelStore } from '@/stores/useServerChannel';
  import { useChatStore } from '@/stores/useChat';
  import { useDMStore } from '@/stores/useDM';
  import { useAuthStore } from '@/stores/auth';
  import { useRoute, useRouter } from 'vue-router';
  import { useProfileStore } from '@/stores/useProfile';
  import { useToast } from "vue-toastification";
  import type { Channel } from "@/types";
  import { useChannelSelection } from '@/composables/useUserProfile'
  import { statePersistence } from '@/services/StatePersistence'
  import { viewContextTracker } from '@/services/ViewContextTracker'

  interface Props {
    serverId?: string;
    channelId?: string;
    isDM?: boolean;
    conversationId?: string;
  }

  const props = withDefaults(defineProps<Props>(), {
    isDM: false,
  });

  const serverUsersStore = useServerUsersStore();
  const serverChannelStore = useServerChannelStore();
  const chatStore = useChatStore();
  const dmStore = useDMStore();
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
      
      // Professional async state management
      const currentRequestId = ref(0);
      let currentAbortController: AbortController | null = null;
      
      // Simplified state management for cleaner UX
      const isAppInitialized = ref(false);
      const hasServersLoaded = ref(false);
      const isLoading = ref(false); // For async operations
      
      // Computed properties for clean template logic
      const isAppReady = computed(() => {
        // App is ready when initialized AND servers have been loaded (even if 0 servers)
        return isAppInitialized.value && hasServersLoaded.value;
      });
      
      const shouldShowNoServersSplash = computed(() => {
        // Only show splash if app is fully ready, has no servers, and public servers not shown
        return isAppReady.value && servers.value.length === 0 && !showPublicServers.value;
      });

      // State management 
      const showPublicServers = ref(false);
      const shouldForceRefreshPublicServers = ref(false);
      const isAtBottom = ref(true); // Default to true for initial load

      const servers = computed(() => serverChannelStore.servers);
      const channels = computed(() => serverChannelStore.channels);
      const categories = computed(() => serverChannelStore.categories);
      const categoryChannels = computed(() => serverChannelStore.categoryChannels);
      
      // Use DM messages when in DM mode, otherwise use chat messages
      const chatMessages = computed(() => {
        return props.isDM ? dmStore.currentDMMessages : chatStore.messages;
      });

      const currentChannelId = computed(() => serverChannelStore.currentChannelId || '');
      const currentServer = computed(() => serverChannelStore.currentServer);
      const showCreateChannelForm = ref(false);
      const currentCategoryId = ref<string | undefined>();

      const isSidebarsVisible = ref(false);
      const isProfilesVisible = ref(false);

      // Method to sync URL with restored state after initialization
      const syncUrlWithRestoredState = async () => {
        // Only sync if we're on the base chat route without specific server/channel
        const isBaseRoute = route.name === 'Chat' && !route.params.serverId;
        
        if (isBaseRoute && currentServer.value?.id && currentChannelId.value && !isNavigatingRoute.value) {
          console.log('🔄 Syncing URL with restored state:', currentServer.value.id, currentChannelId.value);
          isNavigatingRoute.value = true;
          try {
            await router.replace({ 
              name: 'Chat', 
              params: { 
                serverId: currentServer.value.id, 
                channelId: currentChannelId.value 
              } 
            });
          } finally {
            isNavigatingRoute.value = false;
          }
        }
      };

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

      const cancelCurrentRequest = () => {
        if (currentAbortController) {
          currentAbortController.abort();
          currentAbortController = null;
        }
      };

      const createRequestContext = () => {
        cancelCurrentRequest();
        currentAbortController = new AbortController();
        const requestId = ++currentRequestId.value;
        return { signal: currentAbortController.signal, requestId };
      };

      const isRequestStale = (requestId: number) => {
        return requestId !== currentRequestId.value;
      };

      // Add loading state tracking to prevent concurrent server selections
      const isSelectingServer = ref(false);

      const handleServerSelected = async (serverId: string) => {
        console.log(`handleServerSelected called with serverId: ${serverId}`);
        
        // Prevent concurrent server selections
        if (isSelectingServer.value) {
          console.log('Server selection already in progress, skipping to prevent conflicts');
          return;
        }
        
        isSelectingServer.value = true;
        
        try {
          // Immediate UI update for responsiveness
          serverChannelStore.setCurrentServer(serverId);
          isLoading.value = true;
          
          const { signal, requestId } = createRequestContext();
          
          try {
            serverUsersStore.subscribeToUserStatuses();
            chatStore.clearMessages();
            
            // Initialize membership tracking for real-time user list updates
            await serverUsersStore.initializeMembershipTracking(serverId);
            
            // Fetch data with cancellation support
            await serverChannelStore.fetchCategoriesAndChannels(serverId, signal);
            
            // Check if request is still current
            if (isRequestStale(requestId)) return;
            
            // Only select default channel if no specific channel is in the route
            if (!route.params.channelId && serverChannelStore.channels.length > 0) {
              const defaultChannelId = getDefaultChannel(
                serverChannelStore.channels, 
                serverChannelStore.categories, 
                serverChannelStore.categoryChannels
              )
              if (defaultChannelId && !isRequestStale(requestId)) {
                await handleChannelSelected(defaultChannelId);
              }
            }
          } catch (error: any) {
            if (error.name === 'AbortError') return; // Request was cancelled
            console.error('Error loading server:', error);
            toast.error('Failed to load server');
          } finally {
            if (!isRequestStale(requestId)) {
              isLoading.value = false;
            }
          }
        } finally {
          isSelectingServer.value = false;
        }
      };

      // Enhanced channel creation handler
      const handleChannelCreated = async (channel: Channel) => {
        await serverChannelStore.fetchCategoriesAndChannels(currentServer.value.id);
        showCreateChannelForm.value = false
        // Automatically navigate to the newly created channel
        await handleChannelSelected(channel.id);
      }

      const handleChannelSelected = async (channelId: string) => {
        serverChannelStore.setCurrentChannel(channelId);
        
        // 🎯 UPDATE VIEW CONTEXT - Server Channel
        viewContextTracker.updateContext({
          server_id: currentServer.value?.id,
          channel_id: channelId,
          conversation_id: undefined,
          view_type: 'server_channel'
        });
        
        // Check if messages are cached with enhanced validation
        const isCached = chatStore.isMessageCached(channelId);
        
        if (isCached) {
          // For potentially cached channels, validate against server modifications
          const isValidCache = await chatStore.isChannelCacheValid(channelId);
          if (isValidCache) {
            // Cache is truly valid - load instantly
            chatStore.loadCachedMessages(channelId);
          } else {
            // Cache is stale due to message modifications - refetch
            console.log(`Cache invalidated due to message modifications: ${channelId}`);
            chatStore.clearMessages();
            await chatStore.fetchMessages(channelId);
          }
        } else {
          // For non-cached channels: Clear first, then fetch
          chatStore.clearMessages();
          await chatStore.fetchMessages(channelId);
        }
        chatStore.subscribeToMessages(channelId);
        scrollToBottom();
      };

      // DM-specific handlers
      const handleDMConversationSelected = async (conversationId: string) => {
        if (props.isDM) {
          // 🎯 UPDATE VIEW CONTEXT - DM Conversation
          viewContextTracker.updateContext({
            server_id: undefined,
            channel_id: undefined,
            conversation_id: conversationId,
            view_type: 'dm'
          });
          
          // Check if messages are cached for instant loading
          const isCached = dmStore.isCacheValid(conversationId);
          
          // ALWAYS set current conversation first to establish subscription
          dmStore.setCurrentConversation(conversationId);
          
          if (isCached) {
            // Load cached messages instantly
            dmStore.loadCachedMessages(conversationId);
            scrollToBottom();
          } else {
            // Load fresh messages
            isLoading.value = true;
            try {
              dmStore.clearDMMessages();
              await dmStore.fetchConversationMessages(conversationId);
              scrollToBottom();
            } catch (error) {
              console.error('Error loading DM conversation:', error);
              toast.error('Failed to load conversation');
            } finally {
              isLoading.value = false;
            }
          }
          
          if (!isNavigatingRoute.value) {
            isNavigatingRoute.value = true;
            router.push({ name: 'DM', params: { conversationId } }).finally(() => {
              isNavigatingRoute.value = false;
            });
          }
        }
      };

      const loadDMConversation = async () => {
        if (props.isDM && props.conversationId) {
          // 🎯 UPDATE VIEW CONTEXT - DM Conversation (direct load)
          viewContextTracker.updateContext({
            server_id: undefined,
            channel_id: undefined,
            conversation_id: props.conversationId,
            view_type: 'dm'
          });
          
          // ALWAYS set current conversation first to establish subscription
          dmStore.setCurrentConversation(props.conversationId);
          
          // Check cache first for instant loading
          const isCached = dmStore.isCacheValid(props.conversationId);
          
          if (isCached) {
            dmStore.loadCachedMessages(props.conversationId);
            scrollToBottom();
          } else {
            isLoading.value = true;
            try {
              dmStore.clearDMMessages();
              await dmStore.fetchConversationMessages(props.conversationId);
              scrollToBottom();
            } catch (error) {
              console.error('Error loading DM conversation:', error);
              toast.error('Failed to load conversation');
            } finally {
              isLoading.value = false;
            }
          }
        }
      };

      const fetchMoreMessages = async () => {
        if (props.isDM) {
          // Handle DM message loading with proper loading state check
          if (!dmStore.loadingMessages && !dmStore.allMessagesLoaded && dmStore.currentConversationId) {
            const oldestMessage = dmStore.currentDMMessages[0];
            const oldestMessageId = oldestMessage?.id;
            if (oldestMessageId) {
              await dmStore.fetchConversationMessages(dmStore.currentConversationId, oldestMessageId);
            }
          }
        } else {
          // Handle server message loading
          if (!chatStore.allMessagesLoaded && !chatStore.loadingOlderMessages && serverChannelStore.currentChannelId) {
            const oldestMessageId = chatMessages.value[0]?.id || '';
            await chatStore.fetchMessages(serverChannelStore.currentChannelId, oldestMessageId);
          }
        }
      };

      // Add loading state tracking to prevent recursive calls
      const isLoadingServerAndChannel = ref(false);

      const loadServerAndChannel = async () => {
        console.log(`loadServerAndChannel called - isDM: ${props.isDM}, route params:`, route.params);
        
        // Prevent recursive calls
        if (isLoadingServerAndChannel.value) {
          console.log('loadServerAndChannel already in progress, skipping to prevent recursion');
          return;
        }
        
        isLoadingServerAndChannel.value = true;
        
        try {
          if (props.isDM) {
          // For DM mode, use enhanced initialization that handles direct access
          const userId = authStore.session?.user?.id;
          if (userId) {
            try {
              isLoading.value = true;
              
              // Use the enhanced initialization that handles conversation details and user profiles
              const conversation = await dmStore.initializeDMEnvironmentForDirectAccess(userId, props.conversationId);
              
              if (props.conversationId) {
                if (conversation) {
                  // Conversation loaded successfully, now load messages
                  await loadDMConversation();
                } else {
                  // Conversation not found, attempt to create it
                  try {
                    // Use createOrGetConversation with current user and other user ID
                    const created = await dmStore.createOrGetConversation(userId, props.conversationId);
                    if (created) {
                      await loadDMConversation();
                    } else {
                      toast.error('Failed to create conversation');
                      if (!isNavigatingRoute.value) {
                        isNavigatingRoute.value = true;
                        router.push({ name: 'DMHome' }).finally(() => {
                          isNavigatingRoute.value = false;
                        });
                      }
                    }
                  } catch (err) {
                    console.error('Error creating conversation:', err);
                    toast.error('Failed to create conversation');
                    if (!isNavigatingRoute.value) {
                      isNavigatingRoute.value = true;
                      router.push({ name: 'DMHome' }).finally(() => {
                        isNavigatingRoute.value = false;
                      });
                    }
                  }
                }
              }
            } catch (error) {
              console.error('Error initializing DM environment:', error);
              toast.error('Failed to load DM');
            } finally {
              isLoading.value = false;
            }
          }
        } else {
          // For server mode, use existing logic
          const serverId = route.params.serverId;
          const channelId = route.params.channelId;
          if (serverId) {
            await handleServerSelected(serverId.toString());
            if (channelId) {
              await handleChannelSelected(channelId.toString());
            }
          } else if (serverChannelStore.servers.length > 0 && !isNavigatingRoute.value) {
            const firstServerId = serverChannelStore.servers[0].id;
            isNavigatingRoute.value = true;
            router.replace({ name: 'Chat', params: { serverId: firstServerId } }).finally(() => {
              isNavigatingRoute.value = false;
            });
          }
        }
        } finally {
          isLoadingServerAndChannel.value = false;
        }
      };

      // Handle messages sent from ChatComponent
      const handleSendMessage = async (content: any, replyTo?: string) => {
        if (props.isDM) {
          const currentUserId = authStore.session?.user?.id;
          const conversationId = dmStore.currentConversationId;
          
          if (!currentUserId || !conversationId) return;

          try {
            const success = await dmStore.sendDMMessage(conversationId, currentUserId, content, replyTo);
            if (!success) {
              console.error('Failed to send DM message');
              toast.error('Failed to send message');
            }
            // Scroll to bottom after sending message
            scrollToBottom();
          } catch (error) {
            console.error('Error sending DM message:', error);
            toast.error('Error sending message');
          }
        }
        // For server messages, ChatComponent handles them directly
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
        
        // Force refresh if this is the first time opening or if no servers are loaded
        if (toggleState) {
          shouldForceRefreshPublicServers.value = servers.value.length === 0;
        }
      };

      const handleClosePublicServers = () => {
        showPublicServers.value = false;
        shouldForceRefreshPublicServers.value = false;
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
            // Initialize state persistence early and check if app was previously initialized
            await statePersistence.initialize();
            
            // Don't skip loading screen on first load - let the full initialization process handle it
            // This prevents the flash of "no servers" before servers are actually loaded
            
            // make sure this is only checked once?
            await profileStore.checkProfileCompletion(userId);
          } catch (error: any) {
            console.log(error);
            router.push('/new-profile');
          }

          // Initialize the user environment which includes server loading
          await serverChannelStore.initializeUserEnvironment(userId);
          
          // Mark both initialization flags as complete
          isAppInitialized.value = true;
          hasServersLoaded.value = true;
          
          // Sync URL with restored state if needed
          await syncUrlWithRestoredState();
          
          // No need to manually manage splash state - computed property handles this
          
          // Initialize presence for current user
          const userProfile = serverUsersStore.userProfiles[userId];
          if (userProfile && currentServer.value?.id) {
            serverUsersStore.initializePresence(
              currentServer.value.id, 
              userId, 
              userProfile.display_name || userProfile.username || 'Unknown User', 
              userProfile.avatar_url
            );
          }
          serverUsersStore.subscribeToUserStatuses();
          
          // Subscribe to offline broadcast notifications
          serverUsersStore.subscribeToOfflineBroadcasts();

          const handleResize = () => {
            // Adjust chat area and sidebars on resize
            if (window.innerWidth > 768) {
              isSidebarsVisible.value = true;
              isProfilesVisible.value = false;
            } else {
              isSidebarsVisible.value = false;
              isProfilesVisible.value = false;
            }
          };

          window.addEventListener('resize', handleResize);

          initialized = true;

          
          // Mark app as initialized to prevent future splash flashes
          await statePersistence.setAppInitialized(true);
          
          await loadServerAndChannel();
          requestNotificationPermission();

          // After initialization, if there was a route that wasn't processed, trigger it
          if (route.params.serverId && route.params.serverId !== serverChannelStore.currentServerId) {
            isInitialRouteLoad.value = false; // Allow route processing
            // Trigger route watcher manually for the current route
            if (!isNavigatingRoute.value) {
              isNavigatingRoute.value = true;
              try {
                await loadServerAndChannel();
              } finally {
                isNavigatingRoute.value = false;
              }
            }
          }

          const chatLayout = document.querySelector('#app');
          // Event listeners
          if (chatLayout) {
            chatLayout.addEventListener('touchstart', handleTouchStart as EventListener);
            chatLayout.addEventListener('touchend', handleTouchEnd as EventListener);
          }
        }
      });

      onBeforeUnmount(() => {
        // Clean up presence when component unmounts
        serverUsersStore.cleanup();
        
        // Clean up DM subscriptions if in DM mode
        if (props.isDM) {
          dmStore.cleanup();
        }
      });

      // Track route navigation to prevent recursive updates
      const isNavigatingRoute = ref(false);
      const isInitialRouteLoad = ref(true);

      watch(route, async () => {
        
        // Prevent recursive route updates
        if (isNavigatingRoute.value) {
          // console.log('Route navigation already in progress, skipping to prevent recursion');
          return;
        }
        
        // For initial route load, only proceed if we're initialized
        if (isInitialRouteLoad.value) {
          isInitialRouteLoad.value = false;
          if (!initialized) {
            // console.log('Initial route load but not initialized yet, skipping');
            return;
          }
        }
        
        
        isNavigatingRoute.value = true;
        
        try {
          // Always try to load server and channel when route changes
          // regardless of initialization state, but with proper checks
          if (initialized) {
            // console.log('Loading server and channel for route change');
            await loadServerAndChannel();
          } else {
            // If not initialized yet, just log and continue
            // console.log('Route change detected before initialization complete');
          }
        } finally {
          isNavigatingRoute.value = false;
        }
      }, { immediate: true }); // Re-enable immediate but with smarter logic

      // Watch for conversation changes in DM mode
      watch(() => props.conversationId, async (newConversationId) => {
        if (props.isDM && newConversationId) {
          await loadDMConversation();
        }
      });

      // Watch for server list changes to automatically navigate to new servers
      watch(() => servers.value.length, (newLength, oldLength) => {
        // console.log('Server list changed:', oldLength || 0, '->', newLength)
        
        // If servers were added (user joined a new server)
        if (newLength > (oldLength || 0) && shouldShowNoServersSplash.value) {
          // console.log('New server joined! Hiding splash and navigating...')
          showPublicServers.value = false; // Also close the public servers modal
          
          // Navigate to the newly joined server (last server in the list)
          const newServer = servers.value[servers.value.length - 1];
          if (newServer && !props.isDM && !isNavigatingRoute.value) {
            // console.log('Navigating to new server:', newServer.name, '(' + newServer.id + ')')
            isNavigatingRoute.value = true;
            router.push({ name: 'Chat', params: { serverId: newServer.id } }).finally(() => {
              isNavigatingRoute.value = false;
            });
          }
        }
        
        // No need to manually set splash state - computed property handles this
      }, { immediate: true });


</script>

<style scoped>
.chat-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  position: relative;
}

.left-sidebar-container {
  display: flex;
  position: relative;
  width: 312px; /* 72px (server) + 240px (channel/DM) */
  min-width: 312px;
  background: var(--h-sidebar);
  transition: width 0.3s ease;
  flex-direction: column;
}

.left-sidebar-container .server-sidebar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 72px;
  z-index: 1;
}

.left-sidebar-container .channel-sidebar,
.left-sidebar-container .dm-sidebar {
  margin-left: 72px;
  width: 240px;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.left-sidebar-container .user-profile {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 2;
  width: 100%;
}

.notification-section {
  position: absolute;
  bottom: 72px; /* Height of user profile */
  left: 72px; /* Offset from server sidebar */
  right: 0;
  padding: 12px 16px;
  background: var(--h-sidebar);
  border-top: 1px solid var(--h-chat-light);
  z-index: 2;
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
  .left-sidebar-container {
    width: 0;
    min-width: 0;
    overflow: hidden;
    transition: 0.3s ease-in-out;
  }
  
  .left-sidebar-container.open {
    width: 100%;
  }

  .user-sidebar {
    overflow: hidden;
    width: 0;
    transition: 0.3s ease-in-out;
    padding: 0;
  }
  
  .chat-area {
    transition: 0.3s ease-in-out;
    width: 100%;
    overflow: hidden;
  }
  
  .chat-container {
    width: 100%;
    overflow: hidden;
  }
  
  .chat-area.open {
    position: absolute;
    overflow: hidden;
    left: 100%;
    width: 0;
  }
  
  .chat-area.profile-open {
    overflow: hidden;
    right: 100%;
    width: 0;
  }
  
  .user-sidebar.open {
    display: block;
    width: 100%;
    padding: 10px;
  }
}

.loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--h-black, #1e1f22);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.loading-spinner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.loading-spinner p {
  color: #ffffff;
  font-size: 16px;
  margin: 0;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top: 3px solid #5865f2;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
</style>
