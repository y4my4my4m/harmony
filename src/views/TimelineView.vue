<template>
  <div class="timeline-view">
    <UnifiedContentArea
      mode="activitypub"
      :posts="posts"
      :is-loading-feed="isLoadingFeed"
      :has-more-posts="hasMorePosts"
      :view-type="viewType"
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
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import type { TimelinePost, FederatedUser } from '@/types'

// Props
interface Props {
  currentView: string
  posts?: TimelinePost[]
  isLoadingFeed?: boolean
  hasMorePosts?: boolean
  viewType?: string
}

const props = withDefaults(defineProps<Props>(), {
  posts: () => [],
  isLoadingFeed: false,
  hasMorePosts: false,
  viewType: 'timeline'
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
}>()

// Store
const activityPubStore = useActivityPubStore()
const route = useRoute()

// Computed
const posts = computed(() => {
  return activityPubStore.getTimelinePosts(props.currentView)
})

const isLoadingFeed = computed(() => {
  return activityPubStore.isLoadingFeed
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
    console.error('Failed to load timeline:', error)
  }
}

// Event handlers
const handleRefreshTimeline = () => {
  emit('refreshTimeline')
  loadTimeline()
}

const handlePostCreated = () => {
  emit('postCreated')
  loadTimeline()
}

const handleSwitchFeed = (feed: string) => {
  emit('switchFeed', feed)
}

const handleReplyToPost = (post: TimelinePost) => {
  emit('replyToPost', post)
}

const handleFavoritePost = async (post: TimelinePost) => {
  try {
    await activityPubStore.favoritePost(post.id)
    emit('favoritePost', post)
  } catch (error) {
    console.error('Failed to favorite post:', error)
  }
}

const handleReblogPost = async (post: TimelinePost) => {
  try {
    await activityPubStore.reblogPost(post.id)
    emit('reblogPost', post)
  } catch (error) {
    console.error('Failed to reblog post:', error)
  }
}

const handleBookmarkPost = async (post: TimelinePost) => {
  try {
    await activityPubStore.bookmarkPost(post.id)
    emit('bookmarkPost', post)
  } catch (error) {
    console.error('Failed to bookmark post:', error)
  }
}

const handleDeletePost = async (post: TimelinePost) => {
  try {
    await activityPubStore.deletePost(post.id)
    emit('deletePost', post)
  } catch (error) {
    console.error('Failed to delete post:', error)
  }
}

const handleShowUserProfile = (user: FederatedUser) => {
  emit('showUserProfile', user)
}

const handleLoadMorePosts = async () => {
  try {
    const currentPosts = posts.value
    const lastPost = currentPosts[currentPosts.length - 1]
    
    switch (props.currentView) {
      case 'home':
        await activityPubStore.loadHomeFeed(lastPost?.id)
        break
      case 'public':
        await activityPubStore.loadPublicFeed(lastPost?.id)
        break
      case 'local':
        await activityPubStore.loadLocalFeed(lastPost?.id)
        break
      default:
        await activityPubStore.loadHomeFeed(lastPost?.id)
        break
    }
    emit('loadMorePosts')
  } catch (error) {
    console.error('Failed to load more posts:', error)
  }
}

const handleFollow = async (user: FederatedUser) => {
  try {
    await activityPubStore.followUser(user.id)
    emit('followUser', user)
  } catch (error) {
    console.error('Failed to follow user:', error)
  }
}

const handleUnfollow = async (user: FederatedUser) => {
  try {
    await activityPubStore.unfollowUser(user.id)
    emit('unfollowUser', user)
  } catch (error) {
    console.error('Failed to unfollow user:', error)
  }
}

// Watch for route changes
watch(() => route.params.timeline, (newTimeline) => {
  if (newTimeline && newTimeline !== props.currentView) {
    loadTimeline()
  }
})

onMounted(() => {
  loadTimeline()
})
</script>

<style scoped>
.timeline-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>