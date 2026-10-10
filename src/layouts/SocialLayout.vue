<template>
  <div class="social-layout" :class="{ 'is-dragging': isDragging }">
    <!-- Social mode has no context bar; views render their own headers and the
         funding indicator sits in the instance card. -->
    <FundingModal
      v-if="showFundingModal"
      @close="showFundingModal = false"
    />

    <div class="social-layout-content" data-region="workspace">
      <div 
        class="social-sidebar-container" 
        data-region="nav"
        :class="{ 
          'mobile-open': leftSidebarOpen,
          'is-dragging': isDragging && dragDirection === 'left'
        }"
        :style="leftSidebarStyle"
      >
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

      <div class="main-and-right-container" data-region="main">
        <div 
          class="social-content-area"
          data-region="view"
        >
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
            :left-sidebar-open="leftSidebarOpen"
            :right-sidebar-open="rightSidebarOpen"
            @open-search="handleOpenSearch"
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
            @load-more-special-data="handleLoadMoreSpecialData"
            @back-to-timeline="handleBackToTimeline"
            @toggle-left-sidebar="$emit('toggleLeftSidebar')"
            @toggle-right-sidebar="$emit('toggleRightSidebar')"
          />
        </div>

        <div 
          class="right-sidebar-container" 
          data-region="aside"
          :class="{ 
            'sidebar-open': rightSidebarOpen,
            'mobile-open': rightSidebarOpen,
            'is-dragging': isDragging && dragDirection === 'right'
          }"
          :style="rightSidebarStyle"
        >
          <div class="activitypub-right-sidebar">
          <!-- Hidden on the trending tab, where the main area lists hashtags. -->
          <div v-if="currentView !== 'trending'" class="sidebar-section">
            <h3 class="section-title">{{ $t('activitypub.trending') }}</h3>
            <div v-if="isLoadingTrending" class="trending-loading">
              <span>{{ $t('activitypub.loading') }}</span>
            </div>
            <div v-else-if="trendingTopics.length > 0" class="trending-list">
              <RouterLink
                v-for="trend in trendingTopics"
                :key="trend.tag"
                :to="{ name: 'HashtagView', params: { tag: trend.tag } }"
                class="trending-item"
              >
                <span class="trending-text">
                  <span class="trending-tag">#{{ trend.tag }}</span>
                  <span class="trending-count">{{ $t('activitypub.postsCountLabel', { count: formatNumber(trend.count) }, trend.count) }}</span>
                </span>
                <Icon
                  v-if="trend.trend === 'up'"
                  name="trending-up"
                  :size="14"
                  class="trending-rising"
                  :aria-label="$t('activitypub.trendingRising')"
                />
              </RouterLink>
            </div>
            <EmptyState v-else size="sm" icon="hash" :title="$t('activitypub.noTrendingHashtags')" />
          </div>

          <div class="sidebar-section">
            <h3 class="section-title">{{ $t('activitypub.suggestedFollows') }}</h3>
            <div class="suggested-users">
              <ProfileCard
                v-for="user in suggestedUsers"
                :key="user.id"
                :user="user"
                :show-follow-btn="true"
                :is-compact="true"
                instance-badge-variant="inline"
                @click="handleUserCardClick as any"
              />
            </div>
          </div>

          <div class="sidebar-section">
            <h3 class="section-title">{{ $t('activitypub.instanceInfo') }}</h3>
            <div class="instance-info">
              <p class="instance-domain">{{ localInstanceDomain }}</p>
              <p class="instance-users">{{ localInstanceUserCount }} {{ $t('server.members') }}</p>
              <p class="instance-posts">{{ $t('activitypub.postsCountLabel', { count: formatNumber(localInstancePostCount) }, localInstancePostCount) }}</p>
            </div>
            <button
              v-if="showFunding && fundingConfig"
              type="button"
              class="funding-card"
              :title="fundingTooltip"
              @click="showFundingModal = true"
            >
              <span class="funding-head">
                <Icon name="heart" :size="14" class="funding-heart" />
                <span class="funding-label">{{ $t('activitypub.supportInstance') }}</span>
                <span class="funding-percent">{{ fundingPercent }}%</span>
              </span>
              <span class="funding-track" aria-hidden="true">
                <span class="funding-fill" :style="{ width: fundingPercent + '%' }"></span>
              </span>
              <span class="funding-amount">
                {{ formatCurrency(fundingConfig.displayed_amount ?? fundingConfig.current_amount, fundingConfig.goal_currency) }}
                /
                {{ formatCurrency(fundingConfig.goal_amount ?? 0, fundingConfig.goal_currency) }}
              </span>
            </button>
            <button
              v-else-if="fundingConfig?.enabled"
              type="button"
              class="funding-card"
              data-testid="funding-support"
              @click="showFundingModal = true"
            >
              <span class="funding-head">
                <Icon name="heart" :size="14" class="funding-heart" />
                <span class="funding-label">{{ $t('activitypub.supportInstance') }}</span>
              </span>
            </button>
          </div>
          </div>
        </div>
      </div>
    </div>
    
    <Composer
      v-if="activityPubStore.isComposerOpen"
      mode="modal"
      :type="composerType"
      :is-open="activityPubStore.isComposerOpen"
      :reply-to-post="(composerReplyPost as any) ?? undefined"
      :quote-post="activityPubStore.composerState.quotePost"
      :quote-author="activityPubStore.composerState.quoteAuthor"
      :initial-content="activityPubStore.composerState.content"
      :initial-content-warning="activityPubStore.composerState.contentWarning"
      :initial-sensitive="activityPubStore.composerState.sensitive"
      :default-visibility="activityPubStore.composerState.visibility"
      @close="handleCloseComposer"
      @posted="handlePosted"
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
import { computed, ref, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter, useRoute } from 'vue-router'
import AdaptiveChannelSidebar from '@/components/common/AdaptiveChannelSidebar.vue'
import Composer from '@/components/activitypub/Composer.vue'
import ProfileCard from '@/components/common/ProfileCard.vue'
import UserSearchModal from '@/components/activitypub/UserSearchModal.vue'
import UserProfileModal from '@/components/UserProfileModal.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useFundingStore } from '@/stores/useFunding'
import { storeToRefs } from 'pinia'
import { trendingService } from '@/services/TrendingService'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useLayoutState, useSidebarPanel } from '@/composables/useLayoutState'
import { getOriginalPost } from '@/utils/postReblog'
import FundingModal from '@/components/FundingModal.vue'
import { showsFundingGoal } from '@/services/FundingService'
import type { FederatedUser, TimelinePost } from '@/types'
import { runtimeConfig } from '@/services/runtimeConfig'

interface Props {
  leftSidebarOpen: boolean
  rightSidebarOpen: boolean
  isMobile: boolean
  voicePanelOpen: boolean
  currentView?: string // derived from the route when absent
  viewType?: string // derived from the route when absent
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
  // Drag state props from BaseLayout
  isDragging?: boolean
  dragDirection?: 'left' | 'right' | null
  leftSidebarDragOffset?: number
  rightSidebarDragOffset?: number
}

const props = withDefaults(defineProps<Props>(), {
  currentView: undefined,
  viewType: undefined,
  posts: () => [],
  isLoadingFeed: false,
  hasMorePosts: false,
  profileUser: null,
  specialViewData: () => [],
  hasMoreSpecialData: false,
  followingCount: 0,
  followersCount: 0,
  instanceDomain: runtimeConfig.domain as string,
  instanceUserCount: 0,
  instancePostCount: 0,
  isDragging: false,
  dragDirection: null,
  leftSidebarDragOffset: 0,
  rightSidebarDragOffset: 0
})

// Emits
// eslint-disable-next-line unused-imports/no-unused-vars
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  toggleVoicePanel: []
  refreshTimeline: []
}>()

const activityPubStore = useActivityPubStore()
const fundingStore = useFundingStore()
const { config: fundingConfig } = storeToRefs(fundingStore)
const showFundingModal = ref(false)
const router = useRouter()
const route = useRoute()

// Layout state
const { SIDEBAR_WIDTH } = useLayoutState()
useSidebarPanel('left')
useSidebarPanel('right')

// Drag-follow transforms for the mobile sidebars.
const leftSidebarStyle = computed(() => {
  if (!props.isMobile) return {}
  
  if (props.isDragging && props.dragDirection === 'left') {
    // Slides in from the left, stopping at the 72px server sidebar.
    const progress = props.leftSidebarDragOffset / SIDEBAR_WIDTH
    const closedPosition = -280 // px, offscreen left
    const openPosition = 72 // px, server sidebar width
    const currentPosition = closedPosition + (openPosition - closedPosition) * progress
    
    return {
      transform: `translateX(${currentPosition}px)`,
      width: '280px',
      transition: 'none'
    }
  }
  
  return {}
})

const rightSidebarStyle = computed(() => {
  if (!props.isMobile) return {}
  
  if (props.isDragging && props.dragDirection === 'right') {
    const progress = props.rightSidebarDragOffset / SIDEBAR_WIDTH
    const closedPosition = 100 // percent of own width, offscreen right
    // eslint-disable-next-line unused-imports/no-unused-vars
    const openPosition = 0 // percent
    const currentPosition = closedPosition - (closedPosition * progress)
    
    return {
      transform: `translateX(${currentPosition}%)`,
      width: '280px',
      transition: 'none'
    }
  }
  
  return {}
})

// View identity derived from the current route.
const routeBasedProps = computed(() => {
  const routeName = route.name as string
  const routePath = route.path
  
  // Route name -> currentView / viewType.
  const routeViewMap: Record<string, { currentView: string; viewType: string }> = {
    // Timeline routes
    'SocialHome': { currentView: 'home', viewType: 'timeline' },
    'SocialLocal': { currentView: 'local', viewType: 'timeline' },
    'SocialPublic': { currentView: 'public', viewType: 'timeline' },
    
    // Special view routes
    'Mentions': { currentView: 'mentions', viewType: 'mentions' },
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
    'PostView': { currentView: 'post', viewType: 'post' },
    'PostDetail': { currentView: 'post', viewType: 'post' }, // Legacy support
    'ConversationThread': { currentView: 'conversation', viewType: 'conversation' }, // Legacy support
    
    // Legacy routes
    'Social': { currentView: 'home', viewType: 'timeline' },
    'Explore': { currentView: 'trending', viewType: 'explore' }
  }
  
  // Exact route name wins; path matching is the fallback.
  if (routeViewMap[routeName]) {
    return routeViewMap[routeName]
  }
  
  // Fallback: extract from path
  if (routePath.includes('/social/home')) return { currentView: 'home', viewType: 'timeline' }
  if (routePath.includes('/social/local')) return { currentView: 'local', viewType: 'timeline' }
  if (routePath.includes('/social/public')) return { currentView: 'public', viewType: 'timeline' }
  if (routePath.includes('/social/mentions')) return { currentView: 'mentions', viewType: 'mentions' }
  if (routePath.includes('/social/bookmarks')) return { currentView: 'bookmarks', viewType: 'bookmarks' }
  if (routePath.includes('/social/trending')) return { currentView: 'trending', viewType: 'explore' }
  if (routePath.includes('/social/profile/')) return { currentView: 'profile', viewType: 'profile' }
  
  // Default.
  return { currentView: 'home', viewType: 'timeline' }
})

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

// eslint-disable-next-line unused-imports/no-unused-vars
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
const composerReplyPost = ref<TimelinePost | null>(null)

const composerType = computed(() => {
  if (composerReplyPost.value) return 'reply'
  if (activityPubStore.composerState.quotePost) return 'quote'
  return 'post'
})
const trendingTopics = ref<Array<{ tag: string; count: number; trend: 'up' | 'down' | 'stable' }>>([])
const isLoadingTrending = ref(false)

// Store-cached, already filtered to exclude followed users.
const suggestedUsers = computed(() => activityPubStore.filteredSuggestedUsers.slice(0, 3))

// Instance stats (cached in store)
const localInstanceDomain = computed(() => activityPubStore.instanceDomain)
const localInstanceUserCount = computed(() => activityPubStore.instanceUserCount)
const localInstancePostCount = computed(() => activityPubStore.instancePostCount)

const loadTrendingHashtags = async () => {
  try {
    isLoadingTrending.value = true
    debug.log('Loading trending hashtags...')
    const hashtags = await trendingService.getTrendingHashtags({ limit: 10, days: 7 })
    debug.log('Trending hashtags:', hashtags)
    
    trendingTopics.value = hashtags.map(h => ({
      tag: h.tag,
      count: h.daily_uses || h.weekly_uses || 0,
      trend: h.trend,
    }))
    
    // Empty result renders the no-trending state; no placeholder rows.
    if (trendingTopics.value.length === 0) {
      debug.log('ℹNo trending hashtags found')
    }
  } catch (error) {
    debug.error('Failed to load trending hashtags:', error)
    trendingTopics.value = []
  } finally {
    isLoadingTrending.value = false
  }
}

const loadSuggestedUsers = async () => {
  await activityPubStore.fetchSuggestedUsers()
}

// Instance stats are fetched on demand by the instance store, 5-minute cache.

onMounted(() => {
  loadTrendingHashtags()
  loadSuggestedUsers()
  activityPubStore.fetchInstanceStats()
  void fundingStore.load()
})

// BUGS.md H32: realtime subscriptions are app-scoped and torn down by
// `auth.logout()` via the auth store, not on route change. Calling
// `cleanupRealtimeSubscriptions()` on unmount here strips every ActivityPub
// broadcast handler off the userEventChannel, and most non-social routes never
// call `initialize()` again, so posts/follows/mutes/blocks stop updating after
// social -> chat navigation.

// Event handlers
const handleSwitchFeed = async (feed: string) => {
  debug.log(`Switching to ${feed} feed`)
  
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
  
  // Per-feed load actions guard against their own duplicate in-flight loads.
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
        // ExploreView loads trending data.
        debug.log('Navigating to trending view')
        break
      case 'instances':
        // ExploreView loads instance data.
        debug.log('Navigating to instances view')
        break
    }
  } catch (error) {
    debug.error(`Failed to load ${feed} feed:`, error)
  }
}

const handleOpenSearch = () => {
  showSearchModal.value = true
}

const handlePostCreated = async () => {
  // The realtime subscription appends the new post. A manual refresh would
  // duplicate the timeline/follows/reactions queries.
}

const handleReplyToPost = (post: TimelinePost) => {
  // Reblogs reply to the original post's author, not the booster.
  composerReplyPost.value = getOriginalPost(post)
  activityPubStore.openComposer()
}

// Store actions are `toggleFavorite` / `toggleReblog` / `toggleBookmark`.
// There is no `favoritePost` / `reblogPost` / `bookmarkPost`; calling those
// through an `as any` cast throws a TypeError that the catch blocks swallow,
// leaving the buttons silently dead.
const handleFavoritePost = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleFavorite(post.id)
  } catch (error) {
    debug.error('Failed to favorite post:', error)
  }
}

const handleReblogPost = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleReblog(post.id)
  } catch (error) {
    debug.error('Failed to reblog post:', error)
  }
}

const handleBookmarkPost = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleBookmark(post.id)
  } catch (error) {
    debug.error('Failed to bookmark post:', error)
  }
}

const handleDeletePost = async (post: TimelinePost) => {
  try {
    await activityPubStore.deletePost(post.id)
  } catch (error) {
    debug.error('Failed to delete post:', error)
  }
}

const handleShowUserProfile = (user: FederatedUser) => {
  const handle = (user.handle || user.username || '').replace(/^@/, '')
  router.push({ name: 'UserProfile', params: { handle } })
}

const handleLoadMorePosts = async () => {
  // TimelineView owns pagination for this view.
  debug.log('Load more handled by TimelineView component');
}

const handleFollow = async (user: FederatedUser | string) => {
  try {
    const userId = typeof user === 'string' ? user : user?.id
    
    if (!userId) {
      debug.error('handleFollow: Invalid user ID:', user)
      return
    }
    
    await activityPubStore.followUser(userId)
    debug.log(`Successfully followed user: ${userId}`)
  } catch (error) {
    debug.error('Failed to follow user:', error)
  }
}

const handleUnfollow = async (user: FederatedUser | string) => {
  try {
    const userId = typeof user === 'string' ? user : user?.id
    
    if (!userId) {
      debug.error('handleUnfollow: Invalid user ID:', user)
      return
    }
    
    await activityPubStore.unfollowUser(userId)
    debug.log(`Successfully unfollowed user: ${userId}`)
  } catch (error) {
    debug.error('Failed to unfollow user:', error)
  }
}

const handleLoadMoreSpecialData = async () => {
  try {
    debug.log('Loading more special data for view:', currentView.value)
    // No per-view loaders exist for bookmarks or notifications.
  } catch (error) {
    debug.error('Failed to load more special data:', error)
  }
}

const handleBackToTimeline = () => {
  router.push({ name: 'Social', params: { timeline: 'home' } })
}

const handleCloseComposer = () => {
  composerReplyPost.value = null
  activityPubStore.closeComposer()
}

const handlePosted = (post: any) => {
  debug.log('Post created:', post.id)
  composerReplyPost.value = null
  // The store's realtime subscription appends the post to the feeds.
}

const closeSearch = () => {
  showSearchModal.value = false
}

const closeUserProfile = () => {
  selectedUser.value = null
}

const handleUserCardClick = (user: any) => {
  // Opens the modal without navigating; the modal offers its own navigation.
  // ProfileCard emits `User | FederatedUser`; selectedUser holds the federated
  // shape, hence the cast.
  selectedUser.value = user as FederatedUser
}

const showFunding = computed(() => showsFundingGoal(fundingConfig.value))

const fundingPercent = computed(() => {
  const cfg = fundingConfig.value
  if (!cfg?.goal_amount) return 0
  const amount = cfg.displayed_amount ?? cfg.current_amount
  return Math.min(100, Math.round((amount / cfg.goal_amount) * 100))
})

const fundingTooltip = computed(() => {
  const cfg = fundingConfig.value
  if (!cfg) return ''
  return `${fundingPercent.value}%${cfg.goal_description ? ' - ' + cfg.goal_description : ''}`
})

const formatCurrency = (amount: number, currency: string) => {
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' }
  const symbol = symbols[currency] || currency + ' '
  return symbol + amount.toFixed(0)
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
  /* Fills BaseLayout's content area, which is 100dvh less the safe-area
     padding on mobile. */
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
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
  will-change: transform;
}

.main-and-right-container {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.social-content-area {
  flex: 1;
  overflow: hidden;
}

.right-sidebar-container {
  flex-shrink: 0;
  background: var(--background-tertiary);
  border-left: 1px solid var(--border-color);
  z-index: 40;
  will-change: transform;
  /* Hidden by default on desktop; shown when sidebar-open */
  transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1), width 0.35s cubic-bezier(0.32, 0.72, 0, 1);
  transform: translateX(100%);
  width: 0;
  overflow: hidden;
}

.right-sidebar-container.sidebar-open {
  transform: translateX(0);
  width: 320px;
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
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.trending-list {
  display: flex;
  flex-direction: column;
}

.trending-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin: 0 -8px;
  border-radius: var(--radius-sm);
  color: inherit;
  text-decoration: none;
  transition: background-color 0.15s ease;
}

.trending-item:hover {
  background: var(--background-modifier-hover);
}

.trending-item:focus-visible,
.funding-card:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.trending-loading,
.trending-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.trending-tag {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trending-item:hover .trending-tag {
  color: var(--harmony-primary);
}

.trending-count {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.trending-rising {
  flex-shrink: 0;
  color: var(--success);
}

.suggested-users {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Sidebar rows: avatar, name and handle, Follow. The ancestor chain puts these
   at (0,4,0), above ProfileCard's own .compact rules at (0,3,0). */
.sidebar-section .suggested-users :deep(.profile-card.compact) {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  margin: 0 -8px;
  border: none;
  background: transparent;
  box-shadow: none;
}

.sidebar-section .suggested-users :deep(.profile-card.compact:hover) {
  background: var(--background-modifier-hover);
}

.sidebar-section .suggested-users :deep(.compact .user-info) {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.sidebar-section .suggested-users :deep(.compact .name-section) {
  margin-bottom: 0;
}

.sidebar-section .suggested-users :deep(.compact .display-name) {
  justify-content: flex-start;
}

.sidebar-section .suggested-users :deep(.compact .user-handle) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-section .suggested-users :deep(.compact .stats-section),
.sidebar-section .suggested-users :deep(.compact .mention-btn),
.sidebar-section .suggested-users :deep(.compact .message-btn),
.sidebar-section .suggested-users :deep(.compact .more-actions) {
  display: none;
}

.sidebar-section .suggested-users :deep(.compact .actions-section) {
  width: auto;
  flex: none;
  padding-top: 0;
  border-top: none;
}

.sidebar-section .suggested-users :deep(.compact .follow-btn) {
  flex: none;
  padding: 4px 12px;
  border-radius: var(--radius-full);
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

.funding-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.funding-card:hover {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
}

.funding-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.funding-heart {
  flex-shrink: 0;
  color: var(--harmony-primary);
}

.funding-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}

.funding-percent {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.funding-track {
  display: block;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--background-modifier-active);
  overflow: hidden;
}

.funding-fill {
  display: block;
  height: 100%;
  background: var(--harmony-primary);
}

.funding-amount {
  font-size: 12px;
  color: var(--text-secondary);
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .social-sidebar-container,
  .right-sidebar-container {
    position: fixed;
    top: 0;
    height: 100%;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
    z-index: 200;
    /* Spring easing applied on drag release */
    transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1), width 0.2s cubic-bezier(0.32, 0.72, 0, 1);
  }

  /* Disable transitions during active drag */
  .social-sidebar-container.is-dragging,
  .right-sidebar-container.is-dragging {
    transition: none !important;
  }

  .social-sidebar-container.mobile-open {
    transform: translateX(72px);
    width: 280px;
    left: 0;
  }
  .social-sidebar-container {
    transform: translateX(-280px);
    width: 280px;
    left: 0;
  }
  .right-sidebar-container {
    transform: translateX(100%);
    width: 280px;
    right: 0;
  }
  .right-sidebar-container.mobile-open {
    transform: translateX(0);
    width: 280px;
  }
  .main-content-area {
    width: 100%;
    height: 100%;
  }
}
</style>
