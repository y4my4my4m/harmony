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
        mode="activitypub"
        :posts="posts"
        :is-loading-feed="isLoadingFeed"
        :has-more-posts="hasMorePosts"
        :view-type="(viewType as any)"
        :current-view="currentView"
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
import { computed, onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { debug } from '@/utils/debug'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import MonyHeader from '@/components/activitypub/MonyHeader.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useLayoutState } from '@/composables/useLayoutState'
import { usePostInteractions } from '@/composables/usePostInteractions'
import type { TimelinePost, FederatedUser } from '@/types'

// Props
interface Props {
  currentView: string
  posts?: TimelinePost[]
  isLoadingFeed?: boolean
  hasMorePosts?: boolean
  viewType?: string
  rightSidebarOpen?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  posts: () => [],
  isLoadingFeed: false,
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

// Store
const activityPubStore = useActivityPubStore()
const { blockedUsers, mutedUsers } = storeToRefs(activityPubStore)

// Layout state
const { isMobile } = useLayoutState()

const isLoadingFeed = computed(() => activityPubStore.isLoadingFeed)

// Computed - filter out posts from blocked and muted users
const posts = computed(() => {
  const rawPosts = activityPubStore.getTimelinePosts(props.currentView as 'home' | 'public' | 'local')
  
  // Filter out posts from blocked users (they shouldn't see our feed at all)
  // Also filter out posts from muted users (unless they're replies to us)
  return rawPosts.filter(post => {
    const authorId = post.author_id || post.author?.id
    if (!authorId) return true
    
    // Hide posts from blocked users completely
    if (blockedUsers.value.has(authorId)) {
      return false
    }
    
    // Hide posts from muted users (in home timeline)
    if (props.currentView === 'home' && mutedUsers.value.has(authorId)) {
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

// Load timeline data
const loadTimeline = async () => {
  try {
    switch (props.currentView) {
      case 'home':
        await activityPubStore.loadHomeFeed()
        break
      case 'public':
        await activityPubStore.loadPublicFeed()
        break
      case 'local':
        await activityPubStore.loadLocalFeed()
        break
      default:
        await activityPubStore.loadHomeFeed()
        break
    }
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
    
    switch (props.currentView) {
      case 'home':
        await activityPubStore.loadHomeFeed(cursor)
        break
      case 'public':
        await activityPubStore.loadPublicFeed(cursor)
        break
      case 'local':
        await activityPubStore.loadLocalFeed(cursor)
        break
      default:
        await activityPubStore.loadHomeFeed(cursor)
        break
    }
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

// Single source of truth for timeline loading - only watch currentView prop changes
watch(() => props.currentView, (newView, oldView) => {
  if (newView && newView !== oldView) {
    debug.log(`🔄 Timeline view changed from ${oldView} to ${newView}, loading content`)
    loadTimeline()
  }
}, { immediate: true }) // Load on initial mount via currentView prop

// Load timeline on mount for direct navigation only if no currentView prop
onMounted(() => {
  // Only load if currentView is not provided (legacy support)
  if (!props.currentView) {
    debug.log(`🔄 Timeline mounted without currentView prop, loading default timeline`)
    loadTimeline()
  }
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