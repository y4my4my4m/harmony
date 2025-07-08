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
      @open-search="handleOpenSearch"
      @open-composer="handleOpenComposer"
    />
    
    <!-- Left Sidebar Container -->
    <div class="left-sidebar-container" :class="{ 'mobile-open': isSidebarsVisible }">
      <UnifiedSidebar
        :mode="currentMode"
        :mobile-open="isSidebarsVisible"
        :is-mobile="isMobile"
        :servers="servers"
        :current-server="currentServer"
        :channels="channels"
        :current-channel-id="currentChannelId"
        :categories="categories"
        :category-channels="categoryChannels"
        :is-d-m="isDM"
        :following-count="followingCount"
        :followers-count="followersCount"
        @show-public-servers="handleShowPublicServers"
        @channel-selected="handleChannelSelected"
        @create-channel="handleCreateChannel"
        @conversation-selected="handleDMConversationSelected"
        @switch-mode="handleSwitchMode"
      />
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
import UnifiedSidebar from '@/components/common/UnifiedSidebar.vue';
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue';

// Chat Components
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
  return currentMode.value === 'chat' && isAppReady.value && servers.value.length === 0 && !showPublicServers.value;
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

const chatMessages = computed(() => {
  return props.isDM ? dmStore.currentDMMessages : chatStore.messages;
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

// Watch route changes to update mode and state
watch(() => route.name, (newRouteName) => {
  if (newRouteName === 'Social') {
    currentMode.value = 'activitypub';
    if (route.params.timeline) {
      currentFeed.value = route.params.timeline as 'home' | 'local' | 'public';
    }
  } else {
    currentMode.value = 'chat';
  }
}, { immediate: true });

// Lifecycle hooks
onMounted(async () => {
  checkMobileDevice();
  window.addEventListener('resize', handleResize);
  
  if (isMobile.value) {
    initializeMobileGestures();
  }
  
  // Initialize app
  isAppInitialized.value = true;
  hasServersLoaded.value = true; // Simplified for this example
  
  // Load initial data based on mode
  if (currentMode.value === 'activitypub') {
    await loadTimeline();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
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
    "context context context"
    "sidebar content rightbar";
  grid-template-columns: 240px 1fr 240px;
  grid-template-rows: 48px 1fr;
  height: 100vh;
  background: var(--background-primary);
}

.left-sidebar-container {
  grid-area: sidebar;
  background: var(--background-primary);
  border-right: 1px solid var(--border-color);
}

.main-content-area {
  grid-area: content;
  background: var(--background-primary);
  overflow: hidden;
}

.right-sidebar-container {
  grid-area: rightbar;
  background: var(--background-primary);
  border-left: 1px solid var(--border-color);
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
  
  .left-sidebar-container {
    position: fixed;
    left: 0;
    top: 48px;
    bottom: 0;
    width: 280px;
    z-index: 200;
    transform: translateX(-100%);
    transition: transform 0.3s ease;
  }
  
  .left-sidebar-container.mobile-open {
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
  }
  
  .right-sidebar-container.mobile-open {
    transform: translateX(0);
  }
  
  .activitypub-right-sidebar {
    padding: 12px;
  }
}
</style>