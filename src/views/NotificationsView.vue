<template>
  <div class="notifications-view">
    <UnifiedContentArea
      mode="activitypub"
      :special-view-data="notifications"
      :has-more-special-data="hasMoreNotifications"
      :is-loading-feed="isLoadingNotifications"
      view-type="notifications"
      current-view="notifications"
      @load-more-special-data="handleLoadMore"
      @refresh-timeline="handleRefresh"
      @favorite-post="handleFavoritePost"
      @reblog-post="handleReblogPost"
      @show-user-profile="handleShowUserProfile"
      @follow-user="handleFollow"
      @unfollow-user="handleUnfollow"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import type { TimelinePost, FederatedUser } from '@/types'

// Props
interface Props {
  currentView: string
  viewType: string
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  favoritePost: [post: TimelinePost]
  reblogPost: [post: TimelinePost]
  showUserProfile: [user: FederatedUser]
  followUser: [user: FederatedUser]
  unfollowUser: [user: FederatedUser]
}>()

// Store
const activityPubStore = useActivityPubStore()

// State
const isLoadingNotifications = ref(false)

// Computed
const notifications = computed(() => {
  return activityPubStore.notifications || []
})

const hasMoreNotifications = computed(() => {
  return activityPubStore.hasMoreNotifications
})

// Load notifications
const loadNotifications = async () => {
  isLoadingNotifications.value = true
  try {
    await activityPubStore.loadNotifications()
  } catch (error) {
    console.error('Failed to load notifications:', error)
  } finally {
    isLoadingNotifications.value = false
  }
}

// Event handlers
const handleLoadMore = async () => {
  try {
    await activityPubStore.loadMoreNotifications()
  } catch (error) {
    console.error('Failed to load more notifications:', error)
  }
}

const handleRefresh = () => {
  loadNotifications()
}

const handleFavoritePost = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleFavorite(post.id)
    emit('favoritePost', post)
  } catch (error) {
    console.error('Failed to favorite post:', error)
  }
}

const handleReblogPost = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleReblog(post.id)
    emit('reblogPost', post)
  } catch (error) {
    console.error('Failed to reblog post:', error)
  }
}

const handleShowUserProfile = (user: FederatedUser) => {
  emit('showUserProfile', user)
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

onMounted(() => {
  loadNotifications()
})
</script>

<style scoped>
.notifications-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>