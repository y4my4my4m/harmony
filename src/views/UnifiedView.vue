<!-- 
  DEPRECATED: This file has been refactored into a proper layout system.
  
  New architecture:
  - BaseLayout.vue: Root app layout with server sidebar
  - ChatLayout.vue: Chat-specific layout with channel sidebar  
  - SocialLayout.vue: Social-specific layout with social sidebar
  - Individual view components: ChatView, TimelineView, ExploreView, etc.
  
  See VIEW_REFACTORING_SUMMARY.md for full details.
-->
<template>
  <div class="deprecated-unified-view">
    <p>This component has been deprecated. Please use the new layout system.</p>
  </div>
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
        :current-view="currentView"
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
          @switch-to-activitypub="handleSwitchToActivityPub"
          @switch-to-chat="handleSwitchToChat"
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
        />
      </div>

      <!-- User Profile at Bottom -->
      <div class="user-profile-section">
        <UserProfileComponent />
      </div>
    </div>

    <!-- Main Content Area -->
    <div class="main-content-area">
      <MainContentAreaHeader 
        :mode="currentMode" 
        :current-view="currentView" 
        :is-mobile="isMobile" 
        :current-channel="currentChannel"
        :view-type="currentViewType"
        @switch-feed="handleSwitchFeed"
      />
      <div class="main-content-area-content">
        <UnifiedContentArea
          :mode="currentMode"
          :chat-messages="chatMessages"
          :is-loading="isDM ? dmStore.loadingMessages : isLoading"
          :is-d-m="isDM"
          :view-type="currentViewType"
          :current-view="currentView"
          :posts="posts"
          :is-loading-feed="isLoadingFeed"
          :has-more-posts="hasMorePosts"
          :profile-user="profileUser"
          :profile-handle="props.profileHandle"
          :special-view-data="specialViewData"
          :has-more-special-data="hasMoreSpecialData"
          :post-id="props.postId"
          @load-more-messages="fetchMoreMessages"
          @update:is-at-bottom="isAtBottom = $event"
          @send-message="handleSendMessage"
          @refresh-timeline="handleRefreshTimeline"
          @post-created="handlePostCreated"
          @switch-feed="handleSwitchFeed"
          @reply-to-post="handleReplyToPost"
          @favorite-post="handleFavoritePost"
          @reblog-post="handleReblogPost"
          @bookmark-post="handleBookmarkPost"
          @delete-post="handleDeletePost"
          @show-user-profile="handleShowUserProfile"
          @load-more-posts="handleLoadMorePosts"
          @follow-user="handleFollow"
          @unfollow-user="handleUnfollow"
          @clear-all-bookmarks="handleClearAllBookmarks"
          @load-more-special-data="handleLoadMoreSpecialData"
          @back-to-timeline="handleBackToTimeline"
        />
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
                  @click="handleUserCardClick"
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
      :show="!!selectedUser"
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
    
    <!-- Temporary Debug Panel -->
    <PresenceDebugPanel />
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
import MainContentAreaHeader from '@/components/MainContentAreaHeader.vue';

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

// Debug Components
import PresenceDebugPanel from '@/components/debug/PresenceDebugPanel.vue';

// Stores
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useChatStore } from '@/stores/useChat';
import { useDMStore } from '@/stores/useDM';
import { useAuthStore } from '@/stores/auth';
import { useProfileStore } from '@/stores/useProfile';
import { useActivityPubStore } from '@/stores/useActivityPub';

// Composables
import { useChannelSelection } from '@/composables/useUserProfile';
import { useMobileGestures } from '@/composables/useMobileGestures';

// Services
import { statePersistence } from '@/services/StatePersistence';
import { viewContextTracker } from '@/services/ViewContextTracker';
import { unifiedAppService } from '@/services/unifiedAppService';

import type { Channel, FederatedUser, TimelinePost, Post } from "@/types";
import { 
  ViewMode, 
  ViewType, 
  CurrentView, 
  type RouterViewProps,
  type ViewState,
  createTimelineView,
  createExploreView,
  createProfileView,
  createPostView,
  createChatView,
  createDMView,
  isTimelineView,
  isExploreView,
  isChatMode,
  isActivityPubMode,
  getViewPath,
  isActivityPubRoute
} from '@/types/viewTypes';

interface Props extends RouterViewProps {
  // Additional legacy props for backward compatibility
  timeline?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isDM: false,
  mode: ViewMode.CHAT,
  viewType: ViewType.TIMELINE,
  currentView: CurrentView.HOME,
  timeline: 'home',
  profileHandle: undefined
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

// State Management - Professional type-safe view state
const currentViewState = ref<ViewState>({
  mode: props.mode || ViewMode.CHAT,
  viewType: props.viewType || ViewType.TIMELINE,
  currentView: props.currentView || 
    (props.timeline === 'local' ? CurrentView.LOCAL :
     props.timeline === 'public' ? CurrentView.PUBLIC :
     CurrentView.HOME),
  serverId: props.serverId,
  channelId: props.channelId,
  conversationId: props.conversationId,
  profileHandle: props.profileHandle,
  postId: props.postId,
  isDM: props.isDM
});

// Computed accessors for backward compatibility
const currentMode = computed(() => currentViewState.value.mode);
const currentView = computed(() => currentViewState.value.currentView);
const currentViewType = computed(() => currentViewState.value.viewType);
const profileUser = ref<FederatedUser | null>(null);
const specialViewData = ref<TimelinePost[]>([]);
const hasMoreSpecialData = ref(false);
const specialViewCursor = ref<string | null>(null);

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
const instanceDomain = ref('har.mony.lol');

// Mobile gestures
const { touchState, handleTouchStart, handleTouchMove, handleTouchEnd, resetTouchState } = useMobileGestures();

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
const posts = computed(() => activityPubStore.getTimelinePosts(currentView.value));
const isLoadingFeed = computed(() => activityPubStore.isLoadingFeed);
const hasMorePosts = computed(() => {
  switch (currentView.value) {
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

// Professional mode switching with proper view state management  
const handleSwitchMode = async (mode: ViewMode) => {
  let newViewState: ViewState;
  
  if (mode === ViewMode.CHAT) {
    // Create chat view state
    if (currentServer.value?.id && currentChannelId.value) {
      newViewState = createChatView(currentServer.value.id, currentChannelId.value);
    } else {
      newViewState = createChatView();
    }
    
    // Update state and navigate
    currentViewState.value = newViewState;
    await router.push({ name: 'Chat' });
  } else {
    // ActivityPub mode - preserve current view if already in ActivityPub mode
    if (isActivityPubMode(currentViewState.value)) {
      // Already in ActivityPub mode, no navigation needed
      return;
    }
    
    // Switch to default ActivityPub view (home timeline)
    newViewState = createTimelineView(CurrentView.HOME);
    currentViewState.value = newViewState;
    
    await router.push({ name: 'Social', params: { timeline: 'home' } });
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
  
  // Update both view context and presence context
  const contextInfo = {
    type: 'server' as const,
    serverId: currentServer.value?.id,
    channelId: channelId,
    conversationId: undefined
  };
  
  viewContextTracker.updateContext({
    server_id: currentServer.value?.id,
    channel_id: channelId,
    conversation_id: undefined,
    view_type: 'server_channel'
  });
  
  try {
    const { presenceContextManager } = await import('@/services/presenceContextManager');
    await presenceContextManager.updateContext(contextInfo);
  } catch (error) {
    console.error('Failed to update presence context:', error);
  }
  
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
    console.log('🔄 DM conversation selected:', conversationId);
    
    // Ensure DM environment is initialized (smart - won't refetch if already loaded)
    const userId = authStore.session?.user?.id;
    if (userId) {
      await dmStore.initializeDMEnvironmentForDirectAccess(userId, conversationId);
    }
    
    viewContextTracker.updateContext({
      server_id: undefined,
      channel_id: undefined,
      conversation_id: conversationId,
      view_type: 'dm'
    });
    
    // Use smart conversation switching
    const loadedFromCache = await dmStore.switchToConversation(conversationId);
    
    if (loadedFromCache) {
      // Messages loaded instantly from cache
      scrollToBottom();
    } else {
      // Need to fetch from server - show loading only in message area
      isLoading.value = true;
      try {
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

const handleSendMessage = async (content: MessagePart[], replyTo?: string) => {
  try {
    // Handle message sending based on current mode
    if (currentMode.value === ViewMode.CHAT) {
      // For DMs, we need conversation ID and user ID
      if (isDM.value && dmStore.currentConversationId && authStore.session?.user) {
        console.log('🔄 Sending DM message via UnifiedView:', {
          conversationId: dmStore.currentConversationId,
          userId: authStore.session.user.id,
          content,
          replyTo
        });
        
        const success = await dmStore.sendDMMessage(
          dmStore.currentConversationId,
          authStore.session.user.id,
          content,
          replyTo
        );
        
        if (!success) {
          console.error('❌ Failed to send DM message');
          toast.error('Failed to send message');
        } else {
          console.log('✅ DM message sent successfully');
        }
      } else {
        console.warn('❌ Cannot send DM: missing conversation ID or user session');
        toast.error('Cannot send message: no conversation selected');
      }
    }
    // For ActivityPub mode, handle differently if needed
    // TODO: Implement ActivityPub message handling if required
  } catch (error) {
    console.error('❌ Error in handleSendMessage:', error);
    toast.error('Failed to send message');
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

// Professional handlers for mode switching from ServerSidebar
const handleSwitchToActivityPub = async () => {
  await handleSwitchMode(ViewMode.ACTIVITYPUB);
};

const handleSwitchToChat = async () => {
  await handleSwitchMode(ViewMode.CHAT);
};

// Watch route changes to update view state for direct URL navigation
watch(() => route.name, (newRouteName) => {
  if (newRouteName) {
    const activityPubRoutes = ['Social', 'SocialTrending', 'SocialInstances', 'Explore', 'UserProfile', 'PostDetail', 'Bookmarks', 'Notifications', 'Lists'];
    const chatRoutes = ['Chat', 'DM', 'DMHome'];
    
    if (activityPubRoutes.includes(newRouteName as string) && currentMode.value === ViewMode.CHAT) {
      currentViewState.value.mode = ViewMode.ACTIVITYPUB;
    } else if (chatRoutes.includes(newRouteName as string) && currentMode.value === ViewMode.ACTIVITYPUB) {
      currentViewState.value.mode = ViewMode.CHAT;
    }
  }
}, { immediate: true });

// ActivityPub event handlers
// Professional type-safe feed switching with proper view state management
const handleSwitchFeed = async (feedType: string) => {
  let newViewState: ViewState;
  
  // Create appropriate view state based on feed type
  switch (feedType) {
    case 'home':
      newViewState = createTimelineView(CurrentView.HOME);
      break;
    case 'local':
      newViewState = createTimelineView(CurrentView.LOCAL);
      break;
    case 'public':
      newViewState = createTimelineView(CurrentView.PUBLIC);
      break;
    case 'trending':
      newViewState = createExploreView(CurrentView.TRENDING);
      break;
    case 'instances':
      newViewState = createExploreView(CurrentView.INSTANCES);
      break;
    default:
      newViewState = createTimelineView(CurrentView.HOME);
  }
  
  // Update view state
  currentViewState.value = { ...currentViewState.value, ...newViewState };
  
  // Navigate to appropriate route
  const path = getViewPath(newViewState);
  await router.push(path);
  
  // Load content if needed
  if (isTimelineView(newViewState)) {
    // await loadTimeline();
  }
};

const loadTimeline = async () => {
  switch (currentView.value) {
    case 'home':
      await activityPubStore.loadHomeFeed();
      break;
    case 'public':
      await activityPubStore.loadPublicFeed();
      break;
    case 'local':
      await activityPubStore.loadLocalFeed();
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
    replyTo: post.id,
    content: `@${post.author.username}${post.author.domain !== 'har.mony.lol' ? '@' + post.author.domain : ''}`
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
  try {
    await activityPubStore.toggleReblog(postId);
  } catch (error) {
    console.error('Failed to reblog post:', error);
  }
};

const handleDeletePost = async (postId: string) => {
  console.log('Delete post:', postId);
};

const handleBookmarkPost = async (postId: string) => {
  try {
    await activityPubStore.toggleBookmark(postId);
    // If we're in bookmarks view, refresh the data
    if (currentViewType.value === 'bookmarks') {
      await loadSpecialViewData();
    }
  } catch (error) {
    console.error('Failed to toggle bookmark:', error);
  }
};

const handleClearAllBookmarks = async () => {
  try {
    await activityPubStore.clearAllBookmarks();
    specialViewData.value = [];
    hasMoreSpecialData.value = false;
    specialViewCursor.value = null;
    toast.success('All bookmarks cleared');
  } catch (error) {
    console.error('Failed to clear bookmarks:', error);
    toast.error('Failed to clear bookmarks');
  }
};

const handleLoadMoreSpecialData = async () => {
  try {
    if (currentViewType.value === 'bookmarks') {
      const result = await activityPubStore.getBookmarks({
        limit: 20,
        cursor: specialViewCursor.value
      });
      
      specialViewData.value.push(...result.posts);
      specialViewCursor.value = result.cursor;
      hasMoreSpecialData.value = result.hasMore;
    }
    // TODO: Add handlers for other view types (lists, notifications, etc.)
  } catch (error) {
    console.error('Failed to load more special data:', error);
  }
};

const loadSpecialViewData = async () => {
  try {
    if (currentViewType.value === 'bookmarks') {
      const result = await activityPubStore.getBookmarks({ limit: 20 });
      specialViewData.value = result.posts;
      specialViewCursor.value = result.cursor;
      hasMoreSpecialData.value = result.hasMore;
    }
    // TODO: Add handlers for other view types (lists, notifications, etc.)
  } catch (error) {
    console.error('Failed to load special view data:', error);
  }
};

const handleLoadMorePosts = async () => {
  const currentPosts = posts.value;
  const lastPost = currentPosts[currentPosts.length - 1];
  
  switch (currentView.value) {
    case 'home':
      await activityPubStore.loadHomeFeed(lastPost?.id);
      break;
    case 'public':
      await activityPubStore.loadPublicFeed(lastPost?.id);
      break;
    case 'local':
      await activityPubStore.loadLocalFeed(lastPost?.id);
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
      content_warning: activityPubStore.composerState.contentWarning,
      in_reply_to: activityPubStore.composerState.replyTo,
      media_attachments: [], // Convert MediaAttachment[] to File[] when implementing file upload
      is_sensitive: activityPubStore.composerState.sensitive
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

// Add a method to handle opening user profiles from any context
const handleShowUserProfile = (user: any) => {
  selectedUser.value = user;
};

// Add handlers for profile interactions from different contexts
const handleProfileClick = (user: any) => {
  // Instead of navigating to a profile route, open the modal
  handleShowUserProfile(user);
};

const handleUserCardClick = (user: any) => {
  // Handle clicks from UserCard components
  handleShowUserProfile(user);
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

const handleBackToTimeline = () => {
  // Navigate back to timeline from post detail
  router.push({ name: 'Social', params: { timeline: currentView.value } });
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
        console.log('🔄 Loading DM conversation directly:', props.conversationId);
        
        // Use the specialized method for direct DM access to ensure conversation is loaded
        const conversation = await dmStore.initializeDMEnvironmentForDirectAccess(
          authStore.session?.user?.id || '', 
          props.conversationId
        );
        
        if (!conversation) {
          console.error('❌ Failed to load conversation for direct access:', props.conversationId);
          toast.error('Failed to load conversation');
          return;
        }
        
        console.log('✅ Conversation loaded for direct access:', conversation.id);
        
        // Use smart conversation switching for optimal loading
        const loadedFromCache = await dmStore.switchToConversation(props.conversationId);
        
        if (loadedFromCache) {
          console.log('📂 Messages loaded instantly from cache for direct access');
          scrollToBottom();
        } else {
          console.log('🔄 Fetching fresh messages for direct access');
          // Note: isLoading.value is already managed by fetchConversationMessages
          await dmStore.fetchConversationMessages(props.conversationId);
          scrollToBottom();
        }
      } else {
        console.warn('⚠️ DM mode but no conversation ID provided');
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

// Load profile data when profileHandle is provided
const loadProfileUser = async () => {
  if (!props.profileHandle) return;
  
  try {
    const user = await activityPubStore.resolveUserByHandle(props.profileHandle);
    if (user) {
      profileUser.value = user;
    }
  } catch (error) {
    console.error('Failed to load profile user:', error);
  }
};


// Watch route changes to update mode and load data
watch(route, async () => {
  if (isAppInitialized.value) {
    // Update mode based on route using our professional ViewMode system
    if (isActivityPubRoute(route.name as string)) {
      // Update the underlying view state instead of computed properties
      currentViewState.value = {
        ...currentViewState.value,
        mode: ViewMode.ACTIVITYPUB
      };
      
      // Update viewType and currentView based on route
      if (route.name === 'UserProfile') {
        currentViewState.value.viewType = ViewType.PROFILE;
        currentViewState.value.currentView = CurrentView.PROFILE;
      } else if (route.name === 'Bookmarks') {
        currentViewState.value.viewType = ViewType.BOOKMARKS;
        currentViewState.value.currentView = CurrentView.BOOKMARKS;
      } else if (route.name === 'Notifications') {
        currentViewState.value.viewType = ViewType.NOTIFICATIONS;
        currentViewState.value.currentView = CurrentView.NOTIFICATIONS;
      } else if (route.name === 'Lists') {
        currentViewState.value.viewType = ViewType.LISTS;
        currentViewState.value.currentView = CurrentView.LISTS;
      } else if (route.name === 'Explore') {
        currentViewState.value.viewType = ViewType.EXPLORE;
        currentViewState.value.currentView = CurrentView.TRENDING; // Default to trending
      } else if (route.name === 'SocialTrending') {
        currentViewState.value.viewType = ViewType.EXPLORE;
        currentViewState.value.currentView = CurrentView.TRENDING;
      } else if (route.name === 'SocialInstances') {
        currentViewState.value.viewType = ViewType.EXPLORE;
        currentViewState.value.currentView = CurrentView.INSTANCES;
      } else if (route.name === 'PostDetail') {
        currentViewState.value.viewType = ViewType.POST;
        currentViewState.value.currentView = CurrentView.POST;
      } else {
        // Default to timeline view for Social routes
        currentViewState.value.viewType = ViewType.TIMELINE;
        if (route.params.timeline) {
          const timeline = route.params.timeline as string;
          currentViewState.value.currentView = timeline === 'home' ? CurrentView.HOME :
            timeline === 'local' ? CurrentView.LOCAL :
            timeline === 'public' ? CurrentView.PUBLIC :
            CurrentView.HOME;
        }
      }
      
      // Load appropriate data based on viewType
      if (currentViewState.value.viewType === ViewType.TIMELINE) {
        await loadTimeline();
      } else if (currentViewState.value.viewType === ViewType.PROFILE) {
        await loadProfileUser();
      } else if (currentViewState.value.viewType === ViewType.EXPLORE) {
        // Explore content will handle its own data loading
        console.log('Switched to explore view');
      } else {
        await loadSpecialViewData();
      }
    } else {
      // Update to chat mode
      currentViewState.value = {
        ...currentViewState.value,
        mode: ViewMode.CHAT,
        viewType: ViewType.TIMELINE
      };
    }
    
    // Load server/channel data for chat routes only
    if (currentViewState.value.mode === ViewMode.CHAT) {
      await loadServerAndChannel();
    }
  }
}, { immediate: false });

// Watch for mode changes from props (when component is created with specific mode)
watch(() => props.mode, (newMode) => {
  currentViewState.value = {
    ...currentViewState.value,
    mode: newMode
  };
}, { immediate: true });

// Watch for timeline changes from props
watch(() => props.timeline, (newTimeline) => {
  // Only apply timeline changes if we're actually in a timeline view, not explore views
  if (newTimeline && currentViewState.value.viewType === ViewType.TIMELINE) {
    const currentView = newTimeline === 'home' ? CurrentView.HOME :
      newTimeline === 'local' ? CurrentView.LOCAL :
      newTimeline === 'public' ? CurrentView.PUBLIC :
      CurrentView.HOME;
    
    currentViewState.value = {
      ...currentViewState.value,
      currentView
    };
  }
}, { immediate: true });

// Watch for viewType changes from props
watch(() => props.viewType, (newViewType) => {
  if (newViewType) {
    currentViewState.value = {
      ...currentViewState.value,
      viewType: newViewType
    };
  }
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

// Watch for profile handle changes
watch(() => props.profileHandle, async (newHandle) => {
  if (newHandle) {
    currentViewType.value = 'profile';
    await loadProfileUser();
  } else {
    profileUser.value = null;
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
    
    // DM environment will be initialized as needed by initializeDMEnvironmentForDirectAccess
    // when accessing DMs directly, or by user navigation
    
    // Mark both initialization flags as complete
    isAppInitialized.value = true;
    hasServersLoaded.value = true;
    
    // Initialize professional presence system and context subscriptions
    const userProfile = profileStore.profile || serverUsersStore.userProfiles[userId];
    const username = userProfile?.display_name || userProfile?.username || 
                    authStore.session?.user?.user_metadata?.username || 'Unknown User';
    const avatar = userProfile?.avatar_url;
    
    // Professional presence system is already initialized in BaseLayout
    // Now we need to set up context subscriptions
    try {
      const { useProfessionalPresence } = await import('@/composables/useProfessionalPresence');
      const presence = useProfessionalPresence();
      
      // Subscribe to current server context if we have one
      if (currentServer.value?.id) {
        const { getUserIdsForServer } = await import('@/services/usersService');
        const memberIds = await getUserIdsForServer(currentServer.value.id);
        
        await presence.subscribeToServer(currentServer.value.id, memberIds);
        console.log(`✅ Subscribed to server presence: ${currentServer.value.name} (${memberIds.length} members)`);
      }
      
      console.log('✅ Professional presence context subscriptions initialized');
      
    } catch (error) {
      console.error('Failed to initialize presence context subscriptions:', error);
      
      // Fallback to old system if professional system fails
      console.log('🔄 Falling back to old server-specific presence system...');
      if (userProfile && currentServer.value?.id) {
        serverUsersStore.initializePresence(
          currentServer.value.id, 
          userId, 
          username, 
          avatar
        );
      }
      serverUsersStore.subscribeToUserStatuses();
      serverUsersStore.subscribeToOfflineBroadcasts();
    }
    
    // Load initial server and channel state
    await loadServerAndChannel();
  }
  
  checkMobileDevice();
  window.addEventListener('resize', handleResize);
  
  if (isMobile.value) {
    // Mobile gestures are already initialized, just set up event listeners if needed
    // The gesture handlers are available directly from the composable
  }
  
  // Load initial data based on mode
  if (currentMode.value === 'activitypub') {
    if (currentViewType.value === 'timeline') {
      await loadTimeline();
    } else if (currentViewType.value === 'profile') {
      await loadProfileUser();
    } else {
      await loadSpecialViewData();
    }
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

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border-color);
  border-top: 3px solid #5865f2;
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
    "servers channels content content";
  grid-template-columns: 72px 295px 1fr;
  grid-template-rows: 36px 1fr;
  height: 100vh;
  background: transparent;
}
.main-content-area-content {
  display: grid;
  grid-template-areas: "content rightbar";
  grid-template-columns: 1fr 240px;
  grid-template-rows: 1fr;
  overflow: hidden;
}
.context-bar-container {
  grid-area: context;
  z-index: 100;
}

.sidebar-container {
  display: flex;
  flex-direction: row;
  background: var(--background-tertiary);
}

.server-sidebar-container {
  grid-area: servers;
}

.channel-sidebar-container {
  grid-area: channels;
  background: var(--background-tertiary);
}
.user-profile-section {
  position: fixed;
  left: 10px;
  bottom: 10px;
}

.main-content-area {
  grid-area: content;
  background: var(--background-primary);
  overflow: hidden;
  border-top: 1px solid var(--border-color);
}

.right-sidebar-container {
  grid-area: rightbar;
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
  border-left: 1px solid var(--border-color);
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