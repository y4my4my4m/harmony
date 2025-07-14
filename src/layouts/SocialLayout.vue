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
          :channels="[]"
          :categories="[]"
          :category-channels="{}"
          :following-count="followingCount"
          :followers-count="followersCount"
          :instance-domain="instanceDomain"
          :instance-user-count="instanceUserCount"
          :instance-post-count="instancePostCount"
        />
      </div>

      <!-- Main + Right Sidebar Container -->
      <div class="main-and-right-container">
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
import { useRouter, useRoute } from 'vue-router'
import UnifiedContextBar from '@/components/common/UnifiedContextBar.vue'
import AdaptiveChannelSidebar from '@/components/common/AdaptiveChannelSidebar.vue'
import MonyComposer from '@/components/activitypub/MonyComposer.vue'
import UserCard from '@/components/activitypub/UserCard.vue'
import UserSearchModal from '@/components/activitypub/UserSearchModal.vue'
import UserProfileModal from '@/components/UserProfileModal.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import type { FederatedUser, TimelinePost } from '@/types'

// Props - Made view props optional since we extract from route
interface Props {
  leftSidebarOpen: boolean
  rightSidebarOpen: boolean
  isMobile: boolean
  voicePanelOpen: boolean
  currentView?: string // Optional - extracted from route if not provided
  viewType?: string // Optional - extracted from route if not provided
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
  currentView: undefined, // Will be extracted from route
  viewType: undefined, // Will be extracted from route
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
const router = useRouter()
const route = useRoute()

// Route-aware props extraction - Professional approach
// Extract view information from current route with comprehensive mapping
const routeBasedProps = computed(() => {
  const routeName = route.name as string
  const routePath = route.path
  
  // Comprehensive route to view mapping - covers all social routes
  const routeViewMap: Record<string, { currentView: string; viewType: string }> = {
    // Timeline routes
    'SocialHome': { currentView: 'home', viewType: 'timeline' },
    'SocialLocal': { currentView: 'local', viewType: 'timeline' },
    'SocialPublic': { currentView: 'public', viewType: 'timeline' },
    
    // Special view routes
    'Notifications': { currentView: 'notifications', viewType: 'notifications' },
    'Bookmarks': { currentView: 'bookmarks', viewType: 'bookmarks' },
    'Lists': { currentView: 'lists', viewType: 'lists' },
    
    // Profile routes
    'UserProfile': { currentView: 'profile', viewType: 'profile' },
    'Followers': { currentView: 'followers', viewType: 'profile' },
    'Following': { currentView: 'following', viewType: 'profile' },
    
    // Explore routes
    'SocialTrending': { currentView: 'trending', viewType: 'explore' },
    'SocialInstances': { currentView: 'instances', viewType: 'explore' },
    
    // Post routes
    'PostDetail': { currentView: 'post', viewType: 'post' },
    'ConversationThread': { currentView: 'conversation', viewType: 'conversation' },
    
    // Legacy routes
    'Social': { currentView: 'home', viewType: 'timeline' },
    'Explore': { currentView: 'trending', viewType: 'explore' }
  }
  
  // Check exact route name first, then try path-based detection
  if (routeViewMap[routeName]) {
    return routeViewMap[routeName]
  }
  
  // Fallback: extract from path
  if (routePath.includes('/social/home')) return { currentView: 'home', viewType: 'timeline' }
  if (routePath.includes('/social/local')) return { currentView: 'local', viewType: 'timeline' }
  if (routePath.includes('/social/public')) return { currentView: 'public', viewType: 'timeline' }
  if (routePath.includes('/social/notifications')) return { currentView: 'notifications', viewType: 'notifications' }
  if (routePath.includes('/social/bookmarks')) return { currentView: 'bookmarks', viewType: 'bookmarks' }
  if (routePath.includes('/social/trending')) return { currentView: 'trending', viewType: 'explore' }
  if (routePath.includes('/social/profile/')) return { currentView: 'profile', viewType: 'profile' }
  
  // Ultimate fallback
  return { currentView: 'home', viewType: 'timeline' }
})

// Computed with intelligent fallback to route-based props
const currentView = computed(() => {
  // Priority: explicit props > route-based > default
  if (props.currentView) return props.currentView
  return routeBasedProps.value.currentView
})

const viewType = computed(() => {
  // Priority: explicit props > route-based > default  
  if (props.viewType) return props.viewType
  return routeBasedProps.value.viewType
})

const currentViewData = computed(() => {
  if (viewType.value === 'timeline') {
    return props.posts
  }
  return props.specialViewData
})
const specialViewData = computed(() => props.specialViewData)

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

const handleSwitchFeed = async (feed: string) => {
  console.log(`🔄 Switching to ${feed} feed`)
  
  // Navigate to the appropriate route
  switch (feed) {
    case 'home':
      await router.push({ name: 'SocialHome' })
      break
    case 'local':
      await router.push({ name: 'SocialLocal' })
      break
    case 'public':
      await router.push({ name: 'SocialPublic' })
      break
    case 'trending':
      await router.push({ name: 'SocialTrending' })
      break
    case 'instances':
      await router.push({ name: 'SocialInstances' })
      break
    default:
      await router.push({ name: 'SocialHome' })
      break
  }
  
  // Only load feed data if not already loaded or loading
  if (activityPubStore.isLoadingFeed) {
    console.log(`⏳ Feed is already loading, skipping duplicate load`)
    return
  }

  try {
    switch (feed) {
      case 'home':
        if (activityPubStore.homeFeed.posts.length === 0) {
          await activityPubStore.loadHomeFeed()
        }
        break
      case 'local':
        if (activityPubStore.localFeed.posts.length === 0) {
          await activityPubStore.loadLocalFeed()
        }
        break
      case 'public':
        if (activityPubStore.publicFeed.posts.length === 0) {
          await activityPubStore.loadPublicFeed()
        }
        break
      case 'trending':
        // Trending data would be loaded by ExploreView
        console.log('🔥 Navigating to trending view')
        break
      case 'instances':
        // Instance data would be loaded by ExploreView  
        console.log('🌐 Navigating to instances view')
        break
    }
  } catch (error) {
    console.error(`Failed to load ${feed} feed:`, error)
  }
}

const handleOpenSearch = () => {
  showSearchModal.value = true
}

const handleOpenComposer = () => {
  activityPubStore.openComposer()
}

const handlePostCreated = async () => {
  // Refresh the current feed after creating a post
  switch (currentView.value) {
    case 'home':
      await activityPubStore.loadHomeFeed()
      break
    case 'public':
      await activityPubStore.loadPublicFeed()
      break
    case 'local':
      await activityPubStore.loadLocalFeed()
      break
  }
}

const handleReplyToPost = (post: TimelinePost) => {
  activityPubStore.openComposer({ replyTo: post.id })
}

const handleFavoritePost = async (post: TimelinePost) => {
  try {
    await activityPubStore.favoritePost(post.id)
  } catch (error) {
    console.error('Failed to favorite post:', error)
  }
}

const handleReblogPost = async (post: TimelinePost) => {
  try {
    await activityPubStore.reblogPost(post.id)
  } catch (error) {
    console.error('Failed to reblog post:', error)
  }
}

const handleBookmarkPost = async (post: TimelinePost) => {
  try {
    await activityPubStore.bookmarkPost(post.id)
  } catch (error) {
    console.error('Failed to bookmark post:', error)
  }
}

const handleDeletePost = async (post: TimelinePost) => {
  try {
    await activityPubStore.deletePost(post.id)
  } catch (error) {
    console.error('Failed to delete post:', error)
  }
}

const handleShowUserProfile = (user: FederatedUser) => {
  selectedUser.value = user
  router.push({ name: 'UserProfile', params: { handle: user.handle.replace('@', '') } })
}

const handleLoadMorePosts = async () => {
  // Prevent duplicate loading - this is handled by TimelineView
  console.log('⚠️ Load more handled by TimelineView component');
}

const handleFollow = async (user: FederatedUser | string) => {
  try {
    // Handle both userId string and FederatedUser object
    const userId = typeof user === 'string' ? user : user?.id
    
    if (!userId) {
      console.error('❌ handleFollow: Invalid user ID:', user)
      return
    }
    
    await activityPubStore.followUser(userId)
    console.log(`✅ Successfully followed user: ${userId}`)
  } catch (error) {
    console.error('Failed to follow user:', error)
  }
}

const handleUnfollow = async (user: FederatedUser | string) => {
  try {
    // Handle both userId string and FederatedUser object
    const userId = typeof user === 'string' ? user : user?.id
    
    if (!userId) {
      console.error('❌ handleUnfollow: Invalid user ID:', user)
      return
    }
    
    await activityPubStore.unfollowUser(userId)
    console.log(`✅ Successfully unfollowed user: ${userId}`)
  } catch (error) {
    console.error('Failed to unfollow user:', error)
  }
}

const handleClearAllBookmarks = async () => {
  try {
    await activityPubStore.clearAllBookmarks()
    console.log('All bookmarks cleared')
    // TODO: Refresh bookmarks view if/when bookmark loading is implemented
  } catch (error) {
    console.error('Failed to clear bookmarks:', error)
  }
}

const handleLoadMoreSpecialData = async () => {
  try {
    console.log('Loading more special data for view:', currentView.value)
    // TODO: Implement specific loading methods for bookmarks, notifications, etc.
    // For now, just log the action
  } catch (error) {
    console.error('Failed to load more special data:', error)
  }
}

const handleBackToTimeline = () => {
  router.push({ name: 'Social', params: { timeline: 'home' } })
}

const handleComposerSubmit = async () => {
  // The composer submission is handled by the activity pub store
  // Just close the composer after successful submission
  activityPubStore.closeComposer()
}

const updateComposerContent = (content: string) => {
  activityPubStore.updateComposerContent(content)
}

const updateComposerVisibility = (visibility: string) => {
  activityPubStore.updateComposerVisibility(visibility)
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
  height: 36px;
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

.main-and-right-container {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
  border-top: 1px solid var(--border-color);
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
  
  .social-sidebar-container,
  .right-sidebar-container {
    position: fixed;
    top: 48px;
    height: calc(100vh - 48px);
    z-index: 200;
    transform: translateX(0%);
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