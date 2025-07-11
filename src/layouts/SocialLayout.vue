<template>
  <div class="social-layout">
    <!-- Context Bar -->
    <div class="context-bar-container">
      <UnifiedContextBar
        mode="activitypub"
        :is-mobile="isMobile"
        :left-sidebar-open="leftSidebarOpen"
        :right-sidebar-open="rightSidebarOpen"
        :voice-panel-open="voicePanelOpen"
        :current-view="currentView"
        :instance-domain="instanceDomain"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-right-sidebar="$emit('toggleRightSidebar')"
        @toggle-voice-panel="$emit('toggleVoicePanel')"
        @toggle-search="handleToggleSearch"
        @switch-feed="handleSwitchFeed"
        @refresh-timeline="$emit('refreshTimeline')"
        @open-search="handleOpenSearch"
        @open-composer="handleOpenComposer"
      />
    </div>

    <!-- Social Layout Content (Flex Row) -->
    <div class="social-layout-content">
      <!-- Social Sidebar -->
      <div class="social-sidebar-container" :class="{ 'mobile-open': leftSidebarOpen }">
        <AdaptiveChannelSidebar
          mode="activitypub"
          :following-count="followingCount"
          :followers-count="followersCount"
          :instance-domain="instanceDomain"
          :instance-user-count="instanceUserCount"
          :instance-post-count="instancePostCount"
        />
      </div>

      <!-- Main Content Area -->
      <div class="main-content-area">        
        <!-- Social Content (RouterView for nested social views) -->
        <div class="social-content-area">
          <RouterView 
            :current-view="currentView"
            :posts="posts"
            :is-loading-feed="isLoadingFeed"
            :has-more-posts="hasMorePosts"
            :profile-user="profileUser"
            :profile-handle="profileHandle"
            :special-view-data="specialViewData"
            :has-more-special-data="hasMoreSpecialData"
            :post-id="postId"
            @refresh-timeline="$emit('refreshTimeline')"
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
        </div>
      </div>

      <!-- Right Sidebar (Trending & Suggestions) -->
      <div class="right-sidebar-container" :class="{ 'mobile-open': rightSidebarOpen }">
        <div class="activitypub-right-sidebar">
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
    
    <!-- Social Modals -->
    <MonyComposer
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
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import UnifiedContextBar from '@/components/common/UnifiedContextBar.vue'
import AdaptiveChannelSidebar from '@/components/common/AdaptiveChannelSidebar.vue'
import MonyComposer from '@/components/activitypub/MonyComposer.vue'
import UserCard from '@/components/activitypub/UserCard.vue'
import UserSearchModal from '@/components/activitypub/UserSearchModal.vue'
import UserProfileModal from '@/components/UserProfileModal.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import type { FederatedUser, TimelinePost } from '@/types'

// Props
interface Props {
  leftSidebarOpen: boolean
  rightSidebarOpen: boolean
  isMobile: boolean
  voicePanelOpen: boolean
  currentView: string
  viewType: string
  posts?: TimelinePost[]
  isLoadingFeed?: boolean
  hasMorePosts?: boolean
  profileUser?: FederatedUser | null
  profileHandle?: string
  specialViewData?: TimelinePost[]
  hasMoreSpecialData?: boolean
  postId?: string
  followingCount?: number
  followersCount?: number
  instanceDomain?: string
  instanceUserCount?: number
  instancePostCount?: number
}

const props = withDefaults(defineProps<Props>(), {
  posts: () => [],
  isLoadingFeed: false,
  hasMorePosts: false,
  profileUser: null,
  specialViewData: () => [],
  hasMoreSpecialData: false,
  followingCount: 0,
  followersCount: 0,
  instanceDomain: 'har.mony.lol',
  instanceUserCount: 0,
  instancePostCount: 0
})

// Emits
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  toggleVoicePanel: []
  refreshTimeline: []
}>()

// Store
const activityPubStore = useActivityPubStore()

// State
const showSearchModal = ref(false)
const selectedUser = ref<FederatedUser | null>(null)
const trendingTopics = ref([
  { tag: 'harmony', count: 1234 },
  { tag: 'social', count: 567 },
  { tag: 'federation', count: 234 }
])
const suggestedUsers = ref<FederatedUser[]>([])

// Event handlers
const handleToggleSearch = () => {
  showSearchModal.value = !showSearchModal.value
}

const handleSwitchFeed = (feed: string) => {
  // Emit to parent or handle routing
}

const handleOpenSearch = () => {
  showSearchModal.value = true
}

const handleOpenComposer = () => {
  activityPubStore.openComposer()
}

const handlePostCreated = () => {
  // Handle post creation
}

const handleReplyToPost = (post: TimelinePost) => {
  // Handle reply
}

const handleFavoritePost = (post: TimelinePost) => {
  // Handle favorite
}

const handleReblogPost = (post: TimelinePost) => {
  // Handle reblog
}

const handleBookmarkPost = (post: TimelinePost) => {
  // Handle bookmark
}

const handleDeletePost = (post: TimelinePost) => {
  // Handle delete
}

const handleShowUserProfile = (user: FederatedUser) => {
  selectedUser.value = user
}

const handleLoadMorePosts = () => {
  // Handle load more
}

const handleFollow = (user: FederatedUser) => {
  // Handle follow
}

const handleUnfollow = (user: FederatedUser) => {
  // Handle unfollow
}

const handleClearAllBookmarks = () => {
  // Handle clear bookmarks
}

const handleLoadMoreSpecialData = () => {
  // Handle load more special data
}

const handleBackToTimeline = () => {
  // Handle back to timeline
}

const handleComposerSubmit = () => {
  // Handle composer submit
}

const updateComposerContent = (content: string) => {
  // Update composer content
}

const updateComposerVisibility = (visibility: string) => {
  // Update composer visibility
}

const closeSearch = () => {
  showSearchModal.value = false
}

const closeUserProfile = () => {
  selectedUser.value = null
}

const handleUserCardClick = (user: FederatedUser) => {
  handleShowUserProfile(user)
}

// Utility functions
const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}
</script>

<style scoped>
.social-layout {
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  position: relative;
}

.context-bar-container {
  height: 48px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  z-index: 50;
}

.social-layout-content {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.social-sidebar-container {
  width: 295px;
  flex-shrink: 0;
  background: var(--background-tertiary);
  border-right: 1px solid var(--border-color);
  position: relative;
  z-index: 40;
}

.main-content-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.social-content-area {
  flex: 1;
  overflow: hidden;
}

.right-sidebar-container {
  width: 320px;
  flex-shrink: 0;
  background: var(--background-tertiary);
  border-left: 1px solid var(--border-color);
  z-index: 40;
}

.activitypub-right-sidebar {
  padding: 16px;
  height: 100%;
  overflow-y: auto;
}

.sidebar-section {
  margin-bottom: 24px;
  background: var(--background-secondary);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid var(--border-color);
}

.section-title {
  font-size: 18px;
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
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color);
}

.trending-item:last-child {
  border-bottom: none;
}

.trending-tag {
  font-weight: 600;
  color: var(--accent-primary);
}

.trending-count {
  font-size: 12px;
  color: var(--text-secondary);
}

.suggested-users {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.instance-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.instance-domain {
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.instance-users,
.instance-posts {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .social-layout {
    flex-direction: row;
  }
  
  .social-sidebar-container,
  .right-sidebar-container {
    position: fixed;
    top: 48px;
    height: calc(100vh - 48px);
    z-index: 200;
    transform: translateX(-100%);
    transition: transform 0.3s ease;
  }
  
  .social-sidebar-container.mobile-open {
    transform: translateX(0);
    left: 72px;
  }
  
  .right-sidebar-container.mobile-open {
    transform: translateX(0);
    right: 0;
  }
  
  .main-content-area {
    width: 100%;
  }
}
</style>