<template>
  <div class="explore-view">
    <ExploreContent
      :current-view="currentView"
      :trending-posts="trendingPosts"
      :trending-tags="trendingTags"
      :suggested-users="suggestedUsers"
      :instances="instances"
      :is-loading="isLoading"
      @load-more="handleLoadMore"
      @refresh="handleRefresh"
      @follow-user="handleFollow"
      @unfollow-user="handleUnfollow"
      @favorite-post="handleFavoritePost"
      @reblog-post="handleReblogPost"
      @bookmark-post="handleBookmarkPost"
      @show-user-profile="handleShowUserProfile"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import ExploreContent from '@/components/activitypub/ExploreContent.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import type { TimelinePost, FederatedUser } from '@/types'

// Props
interface Props {
  currentView: string
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  followUser: [user: FederatedUser]
  unfollowUser: [user: FederatedUser]
  favoritePost: [post: TimelinePost]
  reblogPost: [post: TimelinePost]
  bookmarkPost: [post: TimelinePost]
  showUserProfile: [user: FederatedUser]
}>()

// Store
const activityPubStore = useActivityPubStore()
const route = useRoute()

// State
const isLoading = ref(false)
const trendingPosts = ref<TimelinePost[]>([])
const trendingTags = ref<Array<{ tag: string; count: number }>>([])
const suggestedUsers = ref<FederatedUser[]>([])
const instances = ref<Array<{ domain: string; users: number; posts: number }>>([])

// Load explore data based on current view
const loadExploreData = async () => {
  isLoading.value = true
  try {
    switch (props.currentView) {
      case 'trending':
        await loadTrending()
        break
      case 'instances':
        await loadInstances()
        break
      default:
        await loadTrending()
        break
    }
  } catch (error) {
    console.error('Failed to load explore data:', error)
  } finally {
    isLoading.value = false
  }
}

const loadTrending = async () => {
  // Load trending posts and tags
  try {
    const [posts, tags, users] = await Promise.all([
      activityPubStore.loadTrendingPosts(),
      activityPubStore.loadTrendingTags(),
      activityPubStore.loadSuggestedUsers()
    ])
    
    trendingPosts.value = posts || []
    trendingTags.value = tags || []
    suggestedUsers.value = users || []
  } catch (error) {
    console.error('Failed to load trending data:', error)
  }
}

const loadInstances = async () => {
  try {
    const instanceData = await activityPubStore.loadFederatedInstances()
    instances.value = instanceData || []
  } catch (error) {
    console.error('Failed to load instances:', error)
  }
}

// Event handlers
const handleLoadMore = async () => {
  try {
    await activityPubStore.loadMoreExploreData(props.currentView)
  } catch (error) {
    console.error('Failed to load more explore data:', error)
  }
}

const handleRefresh = () => {
  loadExploreData()
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

const handleShowUserProfile = (user: FederatedUser) => {
  emit('showUserProfile', user)
}

// Watch for route changes
watch(() => props.currentView, loadExploreData)

onMounted(() => {
  loadExploreData()
})
</script>

<style scoped>
.explore-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>