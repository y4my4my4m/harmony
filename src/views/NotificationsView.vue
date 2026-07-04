<template>
  <div class="notifications-view">
    <UnifiedContentArea
      :mode="ViewMode.ACTIVITYPUB"
      :special-view-data="notifications"
      :has-more-special-data="hasMoreNotifications"
      :is-loading-feed="isLoadingNotifications"
      :view-type="('notifications' as any)"
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
import { debug } from '@/utils/debug'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import type { TimelinePost, FederatedUser } from '@/types'
import { ViewMode } from '@/types/viewTypes'

// Props
interface Props {
  currentView: string
  viewType: string
}

// eslint-disable-next-line unused-imports/no-unused-vars
const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  favoritePost: [post: TimelinePost]
  reblogPost: [post: TimelinePost]
  showUserProfile: [user: FederatedUser]
  followUser: [user: FederatedUser]
  unfollowUser: [user: FederatedUser]
}>()

const activityPubStore = useActivityPubStore()

// State
const isLoadingNotifications = ref(false)

// Computed
// Notifications state lives on the store but isn't currently typed there.
// Cast through any to read the data without changing runtime behaviour.
const notifications = computed(() => {
  return (activityPubStore as any).notifications || []
})

const hasMoreNotifications = computed(() => {
  return (activityPubStore as any).hasMoreNotifications
})

const loadNotifications = async () => {
  isLoadingNotifications.value = true
  try {
    await activityPubStore.loadNotifications()
  } catch (error) {
    debug.error('Failed to load notifications:', error)
  } finally {
    isLoadingNotifications.value = false
  }
}

// Event handlers
const handleLoadMore = async () => {
  try {
    await (activityPubStore as any).loadMoreNotifications()
  } catch (error) {
    debug.error('Failed to load more notifications:', error)
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
    debug.error('Failed to favorite post:', error)
  }
}

const handleReblogPost = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleReblog(post.id)
    emit('reblogPost', post)
  } catch (error) {
    debug.error('Failed to reblog post:', error)
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