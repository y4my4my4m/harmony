<template>
  <!-- Loading Screen -->
  <div v-if="!isAppReady" class="loading-overlay">
    <div class="loading-spinner">
      <div class="spinner"></div>
      <p>Loading Harmony...</p>
    </div>
  </div>
  
  <!-- No Servers Splash - Only show if no servers and in chat mode -->
  <NoServersSplash 
    v-else-if="shouldShowNoServersSplash"
    @showPublicServers="handleShowPublicServers"
  />
  
  <!-- Main Unified Layout -->
  <div v-else class="unified-layout" :class="{ 'sidebar-open': isSidebarsVisible, 'profile-open': isProfilesVisible }">
    <!-- Mobile Overlay Backdrop -->
    <div 
      v-if="isMobile && (isSidebarsVisible || isProfilesVisible)" 
      class="mobile-overlay"
      @click="closeMobileSidebars"
    ></div>
    
    <!-- Edge Swipe Indicators -->
    <div v-if="isMobile && isAppReady" class="edge-indicators">
      <div class="edge-indicator left" :class="{ active: touchState.isEdgeSwipe && touchState.startX <= 25 }"></div>
      <div class="edge-indicator right" :class="{ active: touchState.isEdgeSwipe && touchState.startX >= windowWidth - 25 }"></div>
    </div>
    
    <!-- Unified Context Bar -->
    <div class="context-bar-container">
      <UnifiedContextBar
        :mode="currentMode"
        :is-mobile="isMobile"
        :left-sidebar-open="isSidebarsVisible"
        :right-sidebar-open="isProfilesVisible"
        :voice-panel-open="voicePanelOpen"
        :current-server="currentServer"
        :current-channel="currentChannel"
        :is-d-m="isDM"
        :current-feed="currentFeed"
        :instance-domain="instanceDomain"
        @toggle-left-sidebar="toggleLeftSidebar"
        @toggle-right-sidebar="toggleRightSidebar"
        @toggle-voice-panel="toggleVoicePanel"
        @toggle-search="handleToggleSearch"
        @switch-feed="handleSwitchFeed"
        @refresh-timeline="handleRefreshTimeline"
        @open-search="handleOpenSearch"
        @open-composer="handleOpenComposer"
      />
    </div>
    
    <!-- Server List Sidebar (Always Visible) -->
    <div class="sidebar-container">
      <div class="server-sidebar-container">
        <ServerSidebar
          :servers="servers"
          @showPublicServers="handleShowPublicServers"
        />
      </div>
      
      <!-- Adaptive Channel Sidebar -->
      <div class="channel-sidebar-container" :class="{ 'mobile-open': isSidebarsVisible }">
        <AdaptiveChannelSidebar
          :mode="currentMode"
          :current-server="currentServer"
          :channels="channels"
          :current-channel-id="currentChannelId"
          :categories="categories"
          :category-channels="categoryChannels"
          :is-d-m="isDM"
          :following-count="followingCount"
          :followers-count="followersCount"
          :instance-domain="instanceDomain"
          :instance-user-count="instanceUserCount"
          :instance-post-count="instancePostCount"
          @channel-selected="handleChannelSelected"
          @create-channel="handleCreateChannel"
          @conversation-selected="handleDMConversationSelected"
          @switch-mode="handleSwitchMode"
        />
      </div>

      <!-- User Profile at Bottom -->
      <div class="user-profile-section">
        <UserProfileComponent />
      </div>
    </div>

    <!-- Main Content Area -->
    <div class="main-content-area">
      <UnifiedContentArea
        :mode="currentMode"
        :chat-messages="chatMessages"
        :is-loading="isLoading"
        :is-d-m="isDM"
        :current-feed="currentFeed"
        :posts="posts"
        :is-loading-feed="isLoadingFeed"
        :has-more-posts="hasMorePosts"
        @load-more-messages="fetchMoreMessages"
        @update:is-at-bottom="isAtBottom = $event"
        @send-message="handleSendMessage"
        @refresh-timeline="handleRefreshTimeline"
        @post-created="handlePostCreated"
        @switch-feed="handleSwitchFeed"
        @reply-to-post="handleReplyToPost"
        @favorite-post="handleFavoritePost"
        @reblog-post="handleReblogPost"
        @delete-post="handleDeletePost"
        @show-user-profile="handleShowUserProfile"
        @load-more-posts="handleLoadMorePosts"
      />
    </div>
    
    <!-- Right Sidebar -->
    <div class="right-sidebar-container" :class="{ 'mobile-open': isProfilesVisible }">
      <!-- Chat Mode: User List -->
      <UserSidebar v-if="currentMode === 'chat'" />
      
      <!-- ActivityPub Mode: Trending & Suggestions -->
      <div v-else-if="currentMode === 'activitypub'" class="activitypub-right-sidebar">
        <!-- Trending Section -->
        <div class="sidebar-section">
          <h3 class="section-title">Trending</h3>
          <div class="trending-list">
            <div 
              v-for="trend in trendingTopics"
              :key="trend.tag"
              class="trending-item"
            >
              <span class="trending-tag">#{{ trend.tag }}</span>
              <span class="trending-count">{{ formatNumber(trend.count) }} posts</span>
            </div>
          </div>
        </div>

        <!-- Suggested Users -->
        <div class="sidebar-section">
          <h3 class="section-title">Suggested Follows</h3>
          <div class="suggested-users">
            <UserCard
              v-for="user in suggestedUsers"
              :key="user.id"
              :user="user"
              :show-follow-btn="true"
              @follow="handleFollow"
              @unfollow="handleUnfollow"
            />
          </div>
        </div>

        <!-- Instance Info -->
        <div class="sidebar-section">
          <h3 class="section-title">Instance Info</h3>
          <div class="instance-info">
            <p class="instance-domain">{{ instanceDomain }}</p>
            <p class="instance-users">{{ instanceUserCount }} users</p>
            <p class="instance-posts">{{ instancePostCount }} posts</p>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Modals and Overlays -->
    <!-- Chat Mode Modals -->
    <CreateChannel
      v-if="currentMode === 'chat' && !isDM"
      :serverId="currentServer?.id || ''"
      :categoryId="currentCategoryId"
      :show="showCreateChannelForm"
      @channelCreated="handleChannelCreated"
      @close="showCreateChannelForm = false"
    />
    
    <!-- ActivityPub Mode Modals -->
    <MonyComposer
      v-if="currentMode === 'activitypub'"
      :is-open="activityPubStore.isComposerOpen"
      :composer-state="activityPubStore.composerState"
      :is-posting="activityPubStore.isPosting"
      @close="activityPubStore.closeComposer"
      @submit="handleComposerSubmit"
      @update-content="updateComposerContent"
      @update-visibility="updateComposerVisibility"
    />

    <UserSearchModal
      v-if="showSearchModal"
      @close="closeSearch"
      @user-selected="handleShowUserProfile"
    />

    <UserProfileModal
      v-if="selectedUser"
      :user="selectedUser"
      @close="closeUserProfile"
      @follow="handleFollow"
      @unfollow="handleUnfollow"
    />
    
    <!-- Shared Modals -->
    <PublicServers 
      v-if="showPublicServers"
      :force-refresh="shouldForceRefreshPublicServers"
      @close="handleClosePublicServers"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToast } from "vue-toastification";

// Unified Components
import UnifiedContextBar from '@/components/common/UnifiedContextBar.vue';
import AdaptiveChannelSidebar from '@/components/common/AdaptiveChannelSidebar.vue';
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue';

// User Profile Components
import UserProfileComponent from '@/components/UserProfileComponent.vue';

// Chat Components
import ServerSidebar from '@/components/ServerSidebar.vue';
import UserSidebar from '@/components/UserSidebar.vue';
import NoServersSplash from '@/components/NoServersSplash.vue';
import CreateChannel from '@/components/CreateChannel.vue';
import PublicServers from '@/components/PublicServers.vue';

// ActivityPub Components
import MonyComposer from '@/components/activitypub/MonyComposer.vue';
import UserCard from '@/components/activitypub/UserCard.vue';
import UserSearchModal from '@/components/activitypub/UserSearchModal.vue';
import UserProfileModal from '@/components/UserProfileModal.vue';

// Stores
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useChatStore } from '@/stores/useChat';
import { useDMStore } from '@/stores/useDM';
import { useAuthStore } from '@/stores/auth';
import { useProfileStore } from '@/stores/useProfile';
import { useActivityPubStore } from '@/stores/activitypub';

// Composables
import { useChannelSelection } from '@/composables/useUserProfile';
import { useMobileGestures } from '@/composables/useMobileGestures';

// Services
import { statePersistence } from '@/services/StatePersistence';
import { viewContextTracker } from '@/services/ViewContextTracker';

import type { Channel, FederatedUser, TimelinePost, Post } from "@/types";

interface Props {
  // Route params that determine initial state
  serverId?: string;
  channelId?: string;
  isDM?: boolean;
  conversationId?: string;
  mode?: 'chat' | 'activitypub';
  timeline?: 'home' | 'local' | 'public';
}

const props = withDefaults(defineProps<Props>(), {
  isDM: false,
  mode: 'chat',
  timeline: 'home'
});

// Stores
const serverUsersStore = useServerUsersStore();
const serverChannelStore = useServerChannelStore();
const chatStore = useChatStore();
const dmStore = useDMStore();
const authStore = useAuthStore();
const profileStore = useProfileStore();
const activityPubStore = useActivityPubStore();
const toast = useToast();

const route = useRoute();
const router = useRouter();

// State Management
const currentMode = ref<'chat' | 'activitypub'>(props.mode);
const currentFeed = ref<'home' | 'local' | 'public'>(props.timeline);

// App initialization state
const isAppInitialized = ref(false);
const hasServersLoaded = ref(false);
const isLoading = ref(false);

// Professional async state management
const currentRequestId = ref(0);
let currentAbortController: AbortController | null = null;

// UI State
const isSidebarsVisible = ref(false);
const isProfilesVisible = ref(false);
const isMobile = ref(false);
const voicePanelOpen = ref(false);
const isAtBottom = ref(true);

// Chat State
const showCreateChannelForm = ref(false);
const currentCategoryId = ref<string | undefined>();
const showPublicServers = ref(false);
const shouldForceRefreshPublicServers = ref(false);

// ActivityPub State
const showSearchModal = ref(false);
const selectedUser = ref<FederatedUser | null>(null);
const followingCount = ref(0);
const followersCount = ref(0);
const trendingTopics = ref([
  { tag: 'harmony', count: 1234 },
  { tag: 'social', count: 567 },
  { tag: 'federation', count: 234 }
]);
const suggestedUsers = ref<FederatedUser[]>([]);
const instanceUserCount = ref(0);
const instancePostCount = ref(0);
const instanceDomain = ref('harmony.com');

// Mobile gestures
const { touchState, initializeMobileGestures } = useMobileGestures();

// Computed properties
const isAppReady = computed(() => {
  return isAppInitialized.value && hasServersLoaded.value;
});

const shouldShowNoServersSplash = computed(() => {
  return currentMode.value === 'chat' && 
         !isDM.value && 
         isAppReady.value && 
         servers.value.length === 0 && 
         !showPublicServers.value;
});

const windowWidth = computed(() => {
  return typeof window !== 'undefined' ? window.innerWidth : 768;
});

// Chat computed properties
const servers = computed(() => serverChannelStore.servers);
const channels = computed(() => serverChannelStore.channels);
const categories = computed(() => serverChannelStore.categories);
const categoryChannels = computed(() => serverChannelStore.categoryChannels);
const currentChannelId = computed(() => serverChannelStore.currentChannelId || '');
const currentServer = computed(() => serverChannelStore.currentServer);
const currentChannel = computed(() => {
  return channels.value.find(c => c.id === currentChannelId.value);
});

// Route-based state
const isDM = computed(() => props.isDM || route.name === 'DM');

const chatMessages = computed(() => {
  return isDM.value ? dmStore.currentDMMessages : chatStore.messages;
});

// ActivityPub computed properties
const posts = computed(() => activityPubStore.getTimelinePosts(currentFeed.value));
const isLoadingFeed = computed(() => activityPubStore.isLoadingFeed);
const hasMorePosts = computed(() => {
  switch (currentFeed.value) {
    case 'home':
      return activityPubStore.homeFeed.has_more;
    case 'public':
      return activityPubStore.publicFeed.has_more;
    case 'local':
      return activityPubStore.localFeed.has_more;
    default:
      return false;
  }
});

// Mobile detection and sidebar management
const checkMobileDevice = () => {
  const wasMobile = isMobile.value;
  isMobile.value = typeof window !== 'undefined' ? window.innerWidth <= 768 : false;
  
  if (isMobile.value) {
    isSidebarsVisible.value = false;
    isProfilesVisible.value = false;
  } else {
    if (!wasMobile || !isSidebarsVisible.value) {
      isSidebarsVisible.value = true;
    }
    isProfilesVisible.value = false;
  }
};

const handleResize = () => {
  checkMobileDevice();
};

// Mode switching
const handleSwitchMode = async (mode: 'chat' | 'activitypub') => {
  currentMode.value = mode;
  
  if (mode === 'chat') {
    // Navigate to chat route
    if (currentServer.value?.id && currentChannelId.value) {
      await router.push({ 
        name: 'Chat', 
        params: { 
          serverId: currentServer.value.id, 
          channelId: currentChannelId.value 
        } 
      });
    } else {
      await router.push({ name: 'Chat' });
    }
  } else {
    // Navigate to ActivityPub route
    await router.push({ 
      name: 'Social', 
      params: { timeline: currentFeed.value } 
    });
    
    // Load ActivityPub data if needed
    await loadTimeline();
  }
};

// Mobile sidebar controls
const toggleLeftSidebar = () => {
  if (isMobile.value) {
    isProfilesVisible.value = false;
    isSidebarsVisible.value = !isSidebarsVisible.value;
  }
};

const toggleRightSidebar = () => {
  if (isMobile.value) {
    isSidebarsVisible.value = false;
    isProfilesVisible.value = !isProfilesVisible.value;
  }
};

const toggleVoicePanel = () => {
  voicePanelOpen.value = !voicePanelOpen.value;
};

const closeMobileSidebars = () => {
  if (isMobile.value) {
    isSidebarsVisible.value = false;
    isProfilesVisible.value = false;
  }
};

// Chat event handlers
const { getDefaultChannel } = useChannelSelection();

const handleChannelSelected = async (channelId: string) => {
  serverChannelStore.setCurrentChannel(channelId);
  
  viewContextTracker.updateContext({
    server_id: currentServer.value?.id,
    channel_id: channelId,
    conversation_id: undefined,
    view_type: 'server_channel'
  });
  
  const isCached = chatStore.isMessageCached(channelId);
  
  if (isCached) {
    const isValidCache = await chatStore.isChannelCacheValid(channelId);
    if (isValidCache) {
      chatStore.loadCachedMessages(channelId);
    } else {
      chatStore.clearMessages();
      await chatStore.fetchMessages(channelId);
    }
  } else {
    chatStore.clearMessages();
    await chatStore.fetchMessages(channelId);
  }
  chatStore.subscribeToMessages(channelId);
  scrollToBottom();
};

const handleDMConversationSelected = async (conversationId: string) => {
  if (props.isDM) {
    viewContextTracker.updateContext({
      server_id: undefined,
      channel_id: undefined,
      conversation_id: conversationId,
      view_type: 'dm'
    });
    
    const isCached = dmStore.isCacheValid(conversationId);
    dmStore.setCurrentConversation(conversationId);
    
    if (isCached) {
      dmStore.loadCachedMessages(conversationId);
      scrollToBottom();
    } else {
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
    
    await router.push({ name: 'DM', params: { conversationId } });
  }
};

const handleCreateChannel = (categoryId: string) => {
  currentCategoryId.value = categoryId;
  showCreateChannelForm.value = true;
};

const handleChannelCreated = async (channel: Channel) => {
  await serverChannelStore.fetchCategoriesAndChannels(currentServer.value!.id);
  showCreateChannelForm.value = false;
  await handleChannelSelected(channel.id);
};

const handleSendMessage = async (message: any) => {
  // Handle message sending based on current mode
  if (currentMode.value === 'chat') {
    // Existing chat message logic
  }
};

const fetchMoreMessages = async () => {
  // Handle loading more messages based on current mode
  if (currentMode.value === 'chat') {
    // Existing chat message loading logic
  }
};

const handleShowPublicServers = () => {
  showPublicServers.value = true;
  shouldForceRefreshPublicServers.value = true;
};

const handleClosePublicServers = () => {
  showPublicServers.value = false;
  shouldForceRefreshPublicServers.value = false;
};

// ActivityPub event handlers
const handleSwitchFeed = async (feedType: 'home' | 'local' | 'public') => {
  currentFeed.value = feedType;
  await router.push(`/social/${feedType}`);
  await loadTimeline();
};

const loadTimeline = async () => {
  switch (currentFeed.value) {
    case 'home':
      await activityPubStore.loadHomeFeed();
      break;
    case 'public':
      await activityPubStore.loadPublicFeed();
      break;
    case 'local':
      // TODO: Implement local timeline
      break;
  }
};

const handleRefreshTimeline = async () => {
  await loadTimeline();
};

const handlePostCreated = (post: TimelinePost) => {
  console.log('New post created:', post.id);
};

const handleReplyToPost = (post: TimelinePost) => {
  activityPubStore.openComposer({
    in_reply_to: post.id,
    content: `@${post.author.handle} `
  });
};

const handleFavoritePost = async (postId: string) => {
  try {
    await activityPubStore.toggleFavorite(postId);
  } catch (error) {
    console.error('Failed to toggle favorite:', error);
  }
};

const handleReblogPost = async (postId: string) => {
  console.log('Reblog post:', postId);
};

const handleDeletePost = async (postId: string) => {
  console.log('Delete post:', postId);
};

const handleLoadMorePosts = async () => {
  const currentPosts = posts.value;
  const lastPost = currentPosts[currentPosts.length - 1];
  
  switch (currentFeed.value) {
    case 'home':
      await activityPubStore.loadHomeFeed(lastPost?.id);
      break;
    case 'public':
      await activityPubStore.loadPublicFeed(lastPost?.id);
      break;
    case 'local':
      // TODO: Implement local timeline pagination
      break;
  }
};

const handleOpenComposer = () => {
  activityPubStore.openComposer();
};

const handleComposerSubmit = async () => {
  try {
    await activityPubStore.createPost({
      content: activityPubStore.composerState.content,
      visibility: activityPubStore.composerState.visibility,
      content_warning: activityPubStore.composerState.content_warning,
      in_reply_to: activityPubStore.composerState.in_reply_to,
      media_attachments: activityPubStore.composerState.media_attachments,
      is_sensitive: activityPubStore.composerState.is_sensitive
    });
  } catch (error) {
    console.error('Failed to create post:', error);
  }
};

const updateComposerContent = (content: string) => {
  activityPubStore.updateComposer({ content });
};

const updateComposerVisibility = (visibility: Post['visibility']) => {
  activityPubStore.updateComposer({ visibility });
};

const handleFollow = async (userId: string) => {
  try {
    await activityPubStore.followUser(userId);
    followingCount.value++;
  } catch (error) {
    console.error('Failed to follow user:', error);
  }
};

const handleUnfollow = async (userId: string) => {
  try {
    await activityPubStore.unfollowUser(userId);
    followingCount.value--;
  } catch (error) {
    console.error('Failed to unfollow user:', error);
  }
};

const handleShowUserProfile = (user: FederatedUser) => {
  selectedUser.value = user;
};

const closeUserProfile = () => {
  selectedUser.value = null;
};

const handleToggleSearch = () => {
  // Handle search toggle based on current mode
};

const handleOpenSearch = () => {
  showSearchModal.value = true;
};

const closeSearch = () => {
  showSearchModal.value = false;
};

const scrollToBottom = () => {
  isAtBottom.value = true;
  nextTick(() => {
    const chatArea = document.querySelector('.message-display');
    if (chatArea) {
      chatArea.scrollTop = chatArea.scrollHeight;
    }
  });
};

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

// Navigation and state loading
const loadServerAndChannel = async () => {
  if (isLoading.value) return;
  
  try {
    isLoading.value = true;
    
    const requestId = ++currentRequestId.value;
    if (currentAbortController) {
      currentAbortController.abort();
    }
    currentAbortController = new AbortController();
    
    if (props.isDM || isDM.value) {
      // DM mode handling
      if (props.conversationId) {
        // Set current conversation first to establish subscription
        dmStore.setCurrentConversation(props.conversationId);
        
        // Check cache first for instant loading
        const isCached = dmStore.isCacheValid(props.conversationId);
        
        if (isCached) {
          dmStore.loadCachedMessages(props.conversationId);
          scrollToBottom();
        } else {
          dmStore.clearDMMessages();
          await dmStore.fetchConversationMessages(props.conversationId);
          scrollToBottom();
        }
      }
    } else {
      // Regular chat mode
      if (props.serverId) {
        // Set the server first
        serverChannelStore.setCurrentServer(props.serverId);
        
        // Fetch categories and channels for this server
        await serverChannelStore.fetchCategoriesAndChannels(props.serverId);
        
        if (props.channelId) {
          // Set specific channel and load messages
          serverChannelStore.setCurrentChannel(props.channelId);
          
          // Check if messages are cached
          const isCached = chatStore.isMessageCached(props.channelId);
          
          if (isCached) {
            const isValidCache = await chatStore.isChannelCacheValid(props.channelId);
            if (isValidCache) {
              chatStore.loadCachedMessages(props.channelId);
            } else {
              chatStore.clearMessages();
              await chatStore.fetchMessages(props.channelId);
            }
          } else {
            chatStore.clearMessages();
            await chatStore.fetchMessages(props.channelId);
          }
          chatStore.subscribeToMessages(props.channelId);
          scrollToBottom();
          
        } else {
          // Set first available channel
          const defaultChannel = getDefaultChannel(channels.value, categories.value, categoryChannels.value);
          if (defaultChannel) {
            serverChannelStore.setCurrentChannel(defaultChannel);
            
            // Load messages for default channel
            const isCached = chatStore.isMessageCached(defaultChannel);
            if (isCached) {
              const isValidCache = await chatStore.isChannelCacheValid(defaultChannel);
              if (isValidCache) {
                chatStore.loadCachedMessages(defaultChannel);
              } else {
                chatStore.clearMessages();
                await chatStore.fetchMessages(defaultChannel);
              }
            } else {
              chatStore.clearMessages();
              await chatStore.fetchMessages(defaultChannel);
            }
            chatStore.subscribeToMessages(defaultChannel);
            scrollToBottom();
          }
        }
      } else {
        // No server specified, set first server
        const firstServer = servers.value[0];
        if (firstServer) {
          serverChannelStore.setCurrentServer(firstServer.id);
          
          // Fetch categories and channels for this server
          await serverChannelStore.fetchCategoriesAndChannels(firstServer.id);
          
          const defaultChannel = getDefaultChannel(channels.value, categories.value, categoryChannels.value);
          if (defaultChannel) {
            serverChannelStore.setCurrentChannel(defaultChannel);
            
            // Load messages for default channel
            const isCached = chatStore.isMessageCached(defaultChannel);
            if (isCached) {
              const isValidCache = await chatStore.isChannelCacheValid(defaultChannel);
              if (isValidCache) {
                chatStore.loadCachedMessages(defaultChannel);
              } else {
                chatStore.clearMessages();
                await chatStore.fetchMessages(defaultChannel);
              }
            } else {
              chatStore.clearMessages();
              await chatStore.fetchMessages(defaultChannel);
            }
            chatStore.subscribeToMessages(defaultChannel);
            scrollToBottom();
          }
        }
      }
    }
    
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Error loading server and channel:', error);
      toast.error('Failed to load chat data');
    }
  } finally {
    isLoading.value = false;
    currentAbortController = null;
  }
};



// Watch route changes to update mode and load data
watch(route, async () => {
  if (isAppInitialized.value) {
    // Update mode based on route
    if (route.name === 'Social' || route.name === 'Monyverse') {
      currentMode.value = 'activitypub';
      if (route.params.timeline) {
        currentFeed.value = route.params.timeline as 'home' | 'local' | 'public';
      }
      await loadTimeline();
    } else {
      currentMode.value = 'chat';
    }
    
    // Load server/channel data for chat routes only
    if (currentMode.value === 'chat') {
      await loadServerAndChannel();
    }
  }
}, { immediate: false });

// Watch for mode changes from props (when component is created with specific mode)
watch(() => props.mode, (newMode) => {
  currentMode.value = newMode;
}, { immediate: true });

// Watch for timeline changes from props
watch(() => props.timeline, (newTimeline) => {
  currentFeed.value = newTimeline;
}, { immediate: true });

// Watch for server list changes to automatically navigate to new servers
watch(() => servers.value.length, (newLength, oldLength) => {
  // If servers were added (user joined a new server)
  if (newLength > (oldLength || 0) && shouldShowNoServersSplash.value) {
    showPublicServers.value = false; // Also close the public servers modal
    
    // Navigate to the newly joined server (last server in the list)
    const newServer = servers.value[servers.value.length - 1];
    if (newServer && !isDM.value) {
      router.push({ name: 'Chat', params: { serverId: newServer.id } });
    }
  }
}, { immediate: true });

// Lifecycle hooks
onMounted(async () => {
  const userId = authStore.session?.user?.id;
  if (userId) {
    try {
      // Initialize state persistence early
      await statePersistence.initialize();
      
      // Check profile completion
      await profileStore.checkProfileCompletion(userId);
    } catch (error: any) {
      console.log(error);
      router.push('/new-profile');
      return;
    }

    // Initialize the user environment which includes server loading
    await serverChannelStore.initializeUserEnvironment(userId);
    
    // Mark both initialization flags as complete
    isAppInitialized.value = true;
    hasServersLoaded.value = true;
    
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
    
    // Load initial server and channel state
    await loadServerAndChannel();
  }
  
  checkMobileDevice();
  window.addEventListener('resize', handleResize);
  
  if (isMobile.value) {
    initializeMobileGestures();
  }
  
  // Load initial data based on mode
  if (currentMode.value === 'activitypub') {
    await loadTimeline();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  
  // Clean up presence when component unmounts
  serverUsersStore.cleanup();
  
  // Clean up DM subscriptions if in DM mode
  if (props.isDM) {
    dmStore.cleanup();
  }
});
</script>

<style scoped>
.loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--background-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.loading-spinner {
  text-align: center;
  color: var(--text-secondary);
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border-color);
  border-top: 3px solid var(--brand-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 16px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.unified-layout {
  display: grid;
  grid-template-areas: 
    "context context context context"
    "servers channels content rightbar";
  grid-template-columns: 72px 240px 1fr 240px;
  grid-template-rows: 48px 1fr;
  height: 100vh;
  background: var(--background-primary);
}

.context-bar-container {
  grid-area: context;
  z-index: 100;
}

.sidebar-container {
  display: flex;
  flex-direction: row;
  background: var(--background-primary);
}

.server-sidebar-container {
  grid-area: servers;
  background: var(--background-tertiary);
}

.channel-sidebar-container {
  grid-area: channels;
  background: var(--background-secondary);
  border-top-left-radius: 10px;
  border-left: 1px solid var(--border-color);
  border-top: 1px solid var(--border-color);
}
.user-profile-section {
  position: fixed;
  left:0;
  bottom:0;
}

.main-content-area {
  grid-area: content;
  background: var(--background-primary);
  overflow: hidden;
  border-top: 1px solid var(--border-color);
}

.right-sidebar-container {
  grid-area: rightbar;
  background: var(--background-primary);
}

.mobile-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 150;
}

.edge-indicators {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  pointer-events: none;
  z-index: 300;
}

.edge-indicator {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--brand-primary);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.edge-indicator.left {
  left: 0;
}

.edge-indicator.right {
  right: 0;
}

.edge-indicator.active {
  opacity: 0.6;
}

/* ActivityPub Right Sidebar Styles */
.activitypub-right-sidebar {
  padding: 16px;
  overflow-y: auto;
  height: 100%;
}

.sidebar-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 16px;
  font-weight: 700;
  margin: 0 0 12px 0;
  color: var(--text-primary);
}

.trending-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trending-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--background-secondary);
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.trending-tag {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.trending-count {
  font-size: 12px;
  color: var(--text-secondary);
}

.suggested-users {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.instance-info {
  padding: 12px;
  background: var(--background-secondary);
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.instance-domain {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.instance-users,
.instance-posts {
  font-size: 12px;
  margin: 4px 0;
  color: var(--text-secondary);
}

/* Mobile Styles */
@media (max-width: 768px) {
  .unified-layout {
    grid-template-areas: 
      "context"
      "content";
    grid-template-columns: 1fr;
    grid-template-rows: 48px 1fr;
  }
  
  .server-sidebar-container {
    display: none; /* Hide server sidebar on mobile */
  }
  
  .channel-sidebar-container {
    position: fixed;
    left: 0;
    top: 48px;
    bottom: 0;
    width: 280px;
    z-index: 200;
    transform: translateX(-100%);
    transition: transform 0.3s ease;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.15);
  }
  
  .channel-sidebar-container.mobile-open {
    transform: translateX(0);
  }
  
  .right-sidebar-container {
    position: fixed;
    right: 0;
    top: 48px;
    bottom: 0;
    width: 280px;
    z-index: 200;
    transform: translateX(100%);
    transition: transform 0.3s ease;
    box-shadow: -2px 0 8px rgba(0, 0, 0, 0.15);
  }
  
  .right-sidebar-container.mobile-open {
    transform: translateX(0);
  }
  
  .activitypub-right-sidebar {
    padding: 12px;
  }
}
</style>