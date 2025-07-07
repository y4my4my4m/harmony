<template>
  <!-- Loading Screen - Show during initial app load only -->    <!-- Edge Swipe Indicators -->
  <div v-if="isMobile && isAppReady" class="edge-indicators">
    <div class="edge-indicator left" :class="{ active: touchState.isEdgeSwipe && touchState.startX <= 25 }"></div>
    <div class="edge-indicator right" :class="{ active: touchState.isEdgeSwipe && touchState.startX >= windowWidth - 25 }"></div>
  </div>
    
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
  <div v-else class="chat-layout" :class="{ 'sidebar-open': isSidebarsVisible, 'profile-open': isProfilesVisible }">
    <!-- Mobile Overlay Backdrop -->
    <div 
      v-if="isMobile && (isSidebarsVisible || isProfilesVisible)" 
      class="mobile-overlay"
      @click="closeMobileSidebars"
    ></div>
    
    <!-- Mobile Top Navigation Bar -->
    <div v-if="isMobile" class="mobile-nav-bar">
      <button 
        class="nav-toggle-btn left-nav"
        @click="toggleLeftSidebar"
        :class="{ active: isSidebarsVisible }"
        aria-label="Toggle sidebar"
      >
        <div class="hamburger-lines">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </button>
      
      <div class="nav-title">
        <span v-if="!isDM && currentServer" class="server-name">
          {{ currentServer.name }}
        </span>
        <span v-else-if="isDM" class="dm-label">
          Direct Messages
        </span>
        <span v-else class="app-name">
          Harmony
        </span>
      </div>
      
      <button 
        class="nav-toggle-btn right-nav"
        @click="toggleRightSidebar"
        :class="{ active: isProfilesVisible }"
        aria-label="Toggle users"
      >
        <svg viewBox="0 0 24 24" class="nav-icon">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
        </svg>
      </button>
    </div>

    <!-- Left Sidebar Container -->
    <div class="left-sidebar-container" :class="{ 'mobile-open': isSidebarsVisible }">
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
    
    <!-- Main Chat Area -->
    <div class="chat-area">
      <!-- Voice Channel Scene -->
      <VoiceChannelScene 
        v-if="!isDM"
        :currentChannelId="currentChannelId"
        :serverId="currentServer?.id"
      />
      
      <!-- Chat Component -->
      <ChatComponent
        :messages="chatMessages"
        :isLoading="isLoading"
        :isDM="isDM"
        @loadMoreMessages="fetchMoreMessages" 
        @update:isAtBottom="isAtBottom = $event" 
        @sendMessage="handleSendMessage"
      />
    </div>
    
    <!-- Right Sidebar (User List) -->
    <UserSidebar class="right-sidebar" :class="{ 'mobile-open': isProfilesVisible }" />
    
    <!-- Create Channel Modal -->
    <CreateChannel
      v-if="!isDM"
      :serverId="currentServer?.id || ''"
      :categoryId="currentCategoryId"
      :show="showCreateChannelForm"
      @channelCreated="handleChannelCreated"
      @close="showCreateChannelForm = false"
    />
    
    <!-- Public Servers Modal -->
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
  import { useMobileGestures } from '@/composables/useMobileGestures'
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
      const isMobile = ref(false);

      // Computed property for window width to handle SSR and reactivity
      const windowWidth = computed(() => {
        return typeof window !== 'undefined' ? window.innerWidth : 768;
      });

      // Enhanced mobile detection and sidebar management
      const checkMobileDevice = () => {
        const wasMobile = isMobile.value;
        isMobile.value = typeof window !== 'undefined' ? window.innerWidth <= 768 : false;
        
        if (isMobile.value) {
          // On mobile: Always hide sidebars by default
          isSidebarsVisible.value = false;
          isProfilesVisible.value = false;
        } else {
          // On desktop: Show left sidebar by default, hide right sidebar
          if (!wasMobile || !isSidebarsVisible.value) {
            isSidebarsVisible.value = true;
          }
          isProfilesVisible.value = false;
        }
      };

      // Mobile sidebar controls
      const toggleLeftSidebar = () => {
        if (isMobile.value) {
          isProfilesVisible.value = false; // Close right sidebar
          isSidebarsVisible.value = !isSidebarsVisible.value;
        }
      };

      const toggleRightSidebar = () => {
        if (isMobile.value) {
          isSidebarsVisible.value = false; // Close left sidebar
          isProfilesVisible.value = !isProfilesVisible.value;
        }
      };

      const closeMobileSidebars = () => {
        if (isMobile.value) {
          isSidebarsVisible.value = false;
          isProfilesVisible.value = false;
        }
      };

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

      // Use the mobile gestures composable for cleaner touch handling
      const {
        touchState,
        handleTouchStart,
        handleTouchMove,
        handleTouchEnd
      } = useMobileGestures();

      // Wrapper functions to integrate with our component logic
      const onTouchStart = (event: TouchEvent) => {
        handleTouchStart(event, isMobile.value);
      };

      const onTouchMove = (event: TouchEvent) => {
        const hasOpenSidebars = isSidebarsVisible.value || isProfilesVisible.value;
        handleTouchMove(event, isMobile.value, hasOpenSidebars);
      };

      const onTouchEnd = (event: TouchEvent) => {
        handleTouchEnd(event, isMobile.value, {
          onSwipeRight: () => {
            if (!isSidebarsVisible.value) {
              toggleLeftSidebar();
            }
          },
          onSwipeLeft: () => {
            if (isSidebarsVisible.value) {
              toggleLeftSidebar();
            } else if (!isProfilesVisible.value) {
              toggleRightSidebar();
            }
          }
        });
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
            checkMobileDevice();
          };

          // Initial mobile check
          checkMobileDevice();
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
          // Enhanced touch event listeners for better mobile experience
          if (chatLayout) {
            chatLayout.addEventListener('touchstart', onTouchStart, { passive: false });
            chatLayout.addEventListener('touchmove', onTouchMove, { passive: false });
            chatLayout.addEventListener('touchend', onTouchEnd, { passive: false });
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
/* =====================================
   MODERN MOBILE-FIRST CHAT LAYOUT
   ===================================== */

/* Base Chat Layout */
.chat-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  position: relative;
  overflow: hidden;
  background: var(--h-chat, #313338);
}

/* =====================================
   MOBILE NAVIGATION BAR
   ===================================== */

.mobile-nav-bar {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 64px;
  background: linear-gradient(135deg, var(--h-black-dark, #1e1f22) 0%, #1a1b1e 100%);
  border-bottom: 1px solid rgba(88, 101, 242, 0.1);
  z-index: 1000;
  padding: 0 20px;
  align-items: center;
  justify-content: space-between;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 2px 16px rgba(0, 0, 0, 0.2);
}

.nav-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.nav-toggle-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(88, 101, 242, 0.2), rgba(88, 101, 242, 0.05));
  border-radius: 16px;
  opacity: 0;
  transform: scale(0.8);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.nav-toggle-btn:hover::before,
.nav-toggle-btn.active::before {
  opacity: 1;
  transform: scale(1);
}

.nav-toggle-btn:active {
  background: rgba(88, 101, 242, 0.3);
  border-color: rgba(88, 101, 242, 0.4);
  color: #5865f2;
  transform: scale(0.95);
}

.nav-toggle-btn.active {
  background: rgba(88, 101, 242, 0.2);
  border-color: rgba(88, 101, 242, 0.3);
  color: #5865f2;
  transform: scale(1.05);
}

/* Hamburger Animation */
.hamburger-lines {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 22px;
  height: 16px;
  z-index: 1;
}

.hamburger-lines span {
  width: 100%;
  height: 2px;
  background: rgba(255, 255, 255, 0.4);
  border-radius: 2px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: center;
}

.nav-toggle-btn.active .hamburger-lines span:nth-child(1) {
  transform: translateY(6.5px) rotate(45deg);
}

.nav-toggle-btn.active .hamburger-lines span:nth-child(2) {
  opacity: 0;
  transform: scaleX(0);
}

.nav-toggle-btn.active .hamburger-lines span:nth-child(3) {
  transform: translateY(-6.5px) rotate(-45deg);
}

.nav-title {
  flex: 1;
  text-align: center;
  font-weight: 700;
  font-size: 18px;
  color: #ffffff;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  margin: 0 20px;
  background: linear-gradient(135deg, #ffffff, #e3e4e6);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.nav-icon {
  width: 22px;
  height: 22px;
  fill: rgba(255, 255, 255, 0.4);
  z-index: 1;
}
.nav-toggle-btn.active .hamburger-lines span{
  background: currentColor;
}
.nav-toggle-btn.active .nav-icon {
  fill: #5865f2;
}

/* =====================================
   SIDEBAR CONTAINERS
   ===================================== */

.left-sidebar-container {
  display: flex;
  position: relative;
  width: 312px; /* 72px (server) + 240px (channel/DM) */
  min-width: 312px;
  background: var(--h-sidebar, #2b2d31);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  flex-direction: column;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 2px 0 8px rgba(0, 0, 0, 0.2);
}

.left-sidebar-container .server-sidebar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 72px;
  z-index: 1;
  background: var(--h-server-sidebar, #1e1f22);
}

.left-sidebar-container .channel-sidebar,
.left-sidebar-container .dm-sidebar {
  margin-left: 72px;
  width: 240px;
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--h-sidebar, #2b2d31);
}

.left-sidebar-container .user-profile {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 2;
  width: 100%;
  background: var(--h-black-dark, #1e1f22);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

/* =====================================
   MAIN CHAT AREA
   ===================================== */

.chat-area {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--h-chat, #313338);
  min-width: 0; /* Prevents flex item from overflowing */
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* =====================================
   RIGHT SIDEBAR (USER LIST)
   ===================================== */

.right-sidebar {
  width: 240px;
  min-width: 240px;
  background: var(--h-sidebar, #2b2d31);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.2);
}

/* =====================================
   MOBILE OVERLAY
   ===================================== */

.mobile-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 900;
  opacity: 0;
  animation: overlay-fade-in 0.3s ease-out forwards;
}

@keyframes overlay-fade-in {
  to {
    opacity: 1;
  }
}

/* =====================================
   MOBILE RESPONSIVE STYLES
   ===================================== */

@media (max-width: 768px) {
  .mobile-nav-bar {
    display: flex;
  }

  .chat-layout {
    padding-top: 64px; /* Account for mobile nav bar */
  }

  /* Left Sidebar Mobile Behavior */
  .left-sidebar-container {
    position: fixed;
    top: 64px;
    left: 0;
    bottom: 0;
    /* width: calc(85% - 20px); */
    max-width: 360px;
    min-width: 320px;
    z-index: 950;
    transform: translateX(-100%);
    transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
    box-shadow: 12px 0 32px rgba(0, 0, 0, 0.4);
    background: linear-gradient(135deg, var(--h-sidebar, #2b2d31) 0%, #252830 100%);
    border-right: 1px solid rgba(88, 101, 242, 0.2);
  }

  .left-sidebar-container.mobile-open {
    transform: translateX(0);
  }

  /* Right Sidebar Mobile Behavior */
  .right-sidebar {
    position: fixed;
    top: 64px;
    right: 0;
    bottom: 0;
    width: 85%;
    max-width: 320px;
    min-width: 280px;
    z-index: 950;
    transform: translateX(100%);
    transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.4);
    background: linear-gradient(135deg, var(--h-sidebar, #2b2d31) 0%, #252830 100%);
    border-left: 1px solid rgba(88, 101, 242, 0.2);
  }

  .right-sidebar.mobile-open {
    transform: translateX(0);
  }

  /* Chat Area Mobile Behavior */
  .chat-area {
    width: 100%;
    flex: 1;
    background: linear-gradient(135deg, var(--h-chat, #313338) 0%, #2c2f36 100%);
  }

  /* Enhanced mobile sidebar styling */
  .left-sidebar-container .server-sidebar {
    background: linear-gradient(135deg, var(--h-server-sidebar, #1e1f22) 0%, #191a1d 100%);
    border-right: 1px solid rgba(88, 101, 242, 0.15);
  }

  .left-sidebar-container .channel-sidebar,
  .left-sidebar-container .dm-sidebar {
    background: linear-gradient(135deg, var(--h-sidebar, #2b2d31) 0%, #252830 100%);
  }

  /* Mobile overlay with enhanced backdrop */
  .mobile-overlay {
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }

  /* Professional mobile spacing */
  .left-sidebar-container {
    padding-right: 0;
  }

  .left-sidebar-container .channel-sidebar,
  .left-sidebar-container .dm-sidebar {
    padding: 0;
  }
}

/* =====================================
   TABLET RESPONSIVE STYLES
   ===================================== */

@media (max-width: 1024px) and (min-width: 769px) {
  .left-sidebar-container {
    width: 280px;
    min-width: 280px;
  }

  .left-sidebar-container .channel-sidebar,
  .left-sidebar-container .dm-sidebar {
    width: 208px; /* 280 - 72 */
  }

  .right-sidebar {
    width: 200px;
    min-width: 200px;
  }
}

/* =====================================
   LARGE SCREEN OPTIMIZATIONS
   ===================================== */

@media (min-width: 1400px) {
  .left-sidebar-container {
    width: 340px;
    min-width: 340px;
  }

  .left-sidebar-container .channel-sidebar,
  .left-sidebar-container .dm-sidebar {
    width: 268px; /* 340 - 72 */
  }

  .right-sidebar {
    width: 280px;
    min-width: 280px;
  }
}

/* =====================================
   LOADING OVERLAY
   ===================================== */

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
  gap: 24px;
}

.loading-spinner p {
  color: #ffffff;
  font-size: 16px;
  font-weight: 500;
  margin: 0;
  opacity: 0.8;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 3px solid rgba(88, 101, 242, 0.2);
  border-top: 3px solid #5865f2;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* =====================================
   ACCESSIBILITY & REDUCED MOTION
   ===================================== */

@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* =====================================
   HIGH CONTRAST MODE
   ===================================== */

@media (prefers-contrast: high) {
  .left-sidebar-container,
  .right-sidebar {
    border-color: rgba(255, 255, 255, 0.3);
  }

  .mobile-nav-bar {
    border-bottom-color: rgba(255, 255, 255, 0.3);
  }

  .nav-toggle-btn:hover::before {
    background: rgba(255, 255, 255, 0.2);
  }
}

/* =====================================
   EDGE SWIPE INDICATORS
   ===================================== */

.edge-indicators {
  position: fixed;
  top: 64px; /* Below the mobile nav bar */
  left: 0;
  right: 0;
  height: calc(100% - 64px);
  pointer-events: none;
  z-index: 980;
}

.edge-indicator {
  position: absolute;
  width: 25px;
  height: 100%;
  background: transparent;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.edge-indicator.left {
  left: 0;
  background: linear-gradient(to right, rgba(88, 101, 242, 0.1), transparent);
}

.edge-indicator.right {
  right: 0;
  background: linear-gradient(to left, rgba(88, 101, 242, 0.1), transparent);
}

.edge-indicator.active {
  background: linear-gradient(to right, rgba(88, 101, 242, 0.3), rgba(88, 101, 242, 0.1));
}

.edge-indicator.right.active {
  background: linear-gradient(to left, rgba(88, 101, 242, 0.3), rgba(88, 101, 242, 0.1));
}

/* Add subtle glow effect for better visual feedback */
.edge-indicator.active::before {
  content: '';
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 60px;
  background: rgba(88, 101, 242, 0.6);
  border-radius: 2px;
  box-shadow: 0 0 12px rgba(88, 101, 242, 0.4);
  animation: edge-pulse 1s ease-in-out infinite alternate;
}

.edge-indicator.left.active::before {
  left: 2px;
}

.edge-indicator.right.active::before {
  right: 2px;
}

@keyframes edge-pulse {
  0% { opacity: 0.6; transform: translateY(-50%) scale(1); }
  100% { opacity: 1; transform: translateY(-50%) scale(1.1); }
}

/* =====================================
   ===================================== */
</style>
