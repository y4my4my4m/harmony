<template>
  <div class="timeline-view">
    <!-- Mony Header -->
    <div class="mony-header-container">
      <MonyHeader
        :current-view="currentView"
        :is-mobile="isMobile"
        :right-sidebar-open="rightSidebarOpen ?? false"
        @switch-feed="handleSwitchFeed"
        @refresh-timeline="handleRefreshTimeline"
        @open-composer="handleOpenComposer"
        @open-search="handleOpenSearch"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-right-sidebar="$emit('toggleRightSidebar')"
      />
    </div>

    <!-- Timeline Content -->
    <div class="timeline-content">
      <UnifiedContentArea
        ref="contentArea"
        mode="activitypub"
        :posts="posts"
        :is-loading-feed="isLoadingFeed"
        :has-more-posts="hasMorePosts"
        :view-type="(viewType as any)"
        :current-view="currentView"
        :load-error="loadError"
        :pending-count="pendingCount"
        @timeline-scrolled="handleTimelineScrolled"
        @show-pending="handleShowPending"
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
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { debug } from '@/utils/debug'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import MonyHeader from '@/components/activitypub/MonyHeader.vue'
import { useActivityPubStore, type FeedScrollAnchor } from '@/stores/useActivityPub'
import { useLayoutState } from '@/composables/useLayoutState'
import { usePostInteractions } from '@/composables/usePostInteractions'
import type { TimelinePost, FederatedUser } from '@/types'

// Props
interface Props {
  currentView: string
  posts?: TimelinePost[]
  hasMorePosts?: boolean
  viewType?: string
  rightSidebarOpen?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  posts: () => [],
  hasMorePosts: false,
  viewType: 'timeline',
  rightSidebarOpen: false
})

// Emits
const emit = defineEmits<{
  refreshTimeline: []
  postCreated: []
  switchFeed: [feed: string]
  replyToPost: [post: TimelinePost]
  favoritePost: [post: TimelinePost]
  reblogPost: [post: TimelinePost]
  bookmarkPost: [post: TimelinePost]
  deletePost: [post: TimelinePost]
  showUserProfile: [user: FederatedUser]
  loadMorePosts: []
  followUser: [user: FederatedUser]
  unfollowUser: [user: FederatedUser]
  toggleLeftSidebar: []
  toggleRightSidebar: []
  openSearch: []
}>()

const activityPubStore = useActivityPubStore()
const { blockedUsers, mutedUsers } = storeToRefs(activityPubStore)

// Layout state
const { isMobile } = useLayoutState()

type TimelineFeed = 'home' | 'public' | 'local'
const feedKey = computed(() => (props.currentView || 'home') as TimelineFeed)

const isLoadingFeed = computed(() => activityPubStore.isFeedLoading(feedKey.value))
const loadError = computed(() => activityPubStore.feedError(feedKey.value))
const pendingCount = computed(() => activityPubStore.pendingPostCount(feedKey.value))

const handleTimelineScrolled = (scrolled: boolean) => {
  activityPubStore.setTimelineScrolled(feedKey.value, scrolled)
}

const handleShowPending = () => {
  activityPubStore.setTimelineScrolled(feedKey.value, false)
}

// Computed - filter out posts from blocked and muted users
const posts = computed(() => {
  const rawPosts = activityPubStore.getTimelinePosts(props.currentView as 'home' | 'public' | 'local')
  
  // Drop posts from blocked users, and from muted users unless the post is a
  // reply to the viewer.
  return rawPosts.filter(post => {
    const authorId = post.author_id || post.author?.id
    if (!authorId) return true
    
    if (blockedUsers.value.has(authorId)) {
      return false
    }
    
    // Hide posts from muted users across every timeline (home, public/federated,
    // local) - a muted user must not reappear on a tab switch.
    if (mutedUsers.value.has(authorId)) {
      return false
    }
    
    return true
  })
})

const hasMorePosts = computed(() => {
  switch (props.currentView) {
    case 'home':
      return activityPubStore.homeFeed.has_more
    case 'public':
      return activityPubStore.publicFeed.has_more
    case 'local':
      return activityPubStore.localFeed.has_more
    default:
      return false
  }
})

const loadTimeline = async () => {
  try {
    await activityPubStore.loadTimelinePage(feedKey.value)
  } catch (error) {
    debug.error('Failed to load timeline:', error)
  }
}

// Event handlers
const handleRefreshTimeline = () => {
  emit('refreshTimeline')
  loadTimeline()
}

const handlePostCreated = () => {
  emit('postCreated')
  // Realtime subscription handles adding the new post to feeds - no manual reload needed
}

const handleSwitchFeed = (feed: string) => {
  emit('switchFeed', feed)
}

const handleReplyToPost = (post: TimelinePost) => {
  emit('replyToPost', post)
}

// Use the composable for consistent interaction handling
const { toggleFavorite, toggleReblog, toggleBookmark } = usePostInteractions()

const handleFavoritePost = async (post: TimelinePost) => {
  try {
    const result = await toggleFavorite(post.id)
    if (result.success) {
      emit('favoritePost', post)
    }
  } catch (error) {
    debug.error('Failed to favorite post:', error)
  }
}

const handleReblogPost = async (post: TimelinePost) => {
  try {
    const result = await toggleReblog(post.id)
    if (result.success) {
      emit('reblogPost', post)
    }
  } catch (error) {
    debug.error('Failed to reblog post:', error)
  }
}

const handleBookmarkPost = async (post: TimelinePost) => {
  try {
    const result = await toggleBookmark(post.id)
    if (result.success) {
      emit('bookmarkPost', post)
    }
  } catch (error) {
    debug.error('Failed to bookmark post:', error)
  }
}

const handleDeletePost = async (post: TimelinePost) => {
  try {
    await activityPubStore.deletePost(post.id)
    emit('deletePost', post)
  } catch (error) {
    debug.error('Failed to delete post:', error)
  }
}

const handleShowUserProfile = (user: FederatedUser) => {
  emit('showUserProfile', user)
}

const handleLoadMorePosts = async () => {
  try {
    const currentPosts = posts.value
    const lastPost = currentPosts[currentPosts.length - 1]
    const cursor = lastPost?.created_at
    await activityPubStore.loadTimelinePage(feedKey.value, cursor)
    emit('loadMorePosts')
  } catch (error) {
    debug.error('Failed to load more posts:', error)
  }
}

const handleFollow = async (user: FederatedUser) => {
  try {
    await activityPubStore.followUser(user.id)
    emit('followUser', user)
  } catch (error) {
    debug.error('Failed to follow user:', error)
  }
}

const handleUnfollow = async (user: FederatedUser) => {
  try {
    await activityPubStore.unfollowUser(user.id)
    emit('unfollowUser', user)
  } catch (error) {
    debug.error('Failed to unfollow user:', error)
  }
}

const handleOpenComposer = () => {
  activityPubStore.openComposer()
}

const handleOpenSearch = () => {
  emit('openSearch')
}

const contentArea = ref<InstanceType<typeof UnifiedContentArea> | null>(null)
let mounted = false
// Reading position of the feed shown at mount, restored once its rows exist.
let mountAnchor: FeedScrollAnchor | null = null

// Feed switches reuse this instance. The feed left keeps its posts and reading
// position in the store; the feed shown gets its own back.
watch(() => props.currentView, (newView, oldView) => {
  if (oldView && oldView !== newView) {
    activityPubStore.leaveTimeline(oldView as TimelineFeed, contentArea.value?.readScrollAnchor() ?? null)
  }
  if (!newView || newView === oldView) return
  debug.log(`Timeline view changed from ${oldView} to ${newView}`)
  const anchor = activityPubStore.enterTimeline(newView as TimelineFeed)
  if (!mounted) {
    mountAnchor = anchor
    return
  }
  void nextTick(() => contentArea.value?.restoreScrollAnchor(anchor))
}, { immediate: true })

onMounted(() => {
  mounted = true
  // Mark the feed as on-screen so the app-scoped realtime handlers process
  // live post arrivals (prepend + sound). Off-view they no-op to avoid
  // wasteful fetches and notification sounds for posts the user isn't viewing.
  activityPubStore.enterFeedView()
  void contentArea.value?.restoreScrollAnchor(mountAnchor)

  // Only load if currentView is not provided (legacy support)
  if (!props.currentView) {
    debug.log(`Timeline mounted without currentView prop, loading default timeline`)
    loadTimeline()
  }
})

// Rows are still rendered here; opening a post unmounts the timeline.
onBeforeUnmount(() => {
  activityPubStore.leaveTimeline(feedKey.value, contentArea.value?.readScrollAnchor() ?? null)
})

onUnmounted(() => {
  activityPubStore.leaveFeedView()
})
</script>

<style scoped>
.timeline-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mony-header-container {
  flex-shrink: 0;
}

.timeline-content {
  flex: 1;
  overflow: hidden;
}
</style>