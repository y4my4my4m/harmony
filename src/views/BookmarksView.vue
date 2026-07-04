<template>
  <div class="bookmarks-view">
    <UnifiedContentArea
      mode="activitypub"
      :special-view-data="bookmarks"
      :has-more-special-data="hasMoreBookmarks"
      :is-loading-feed="isLoadingBookmarks"
      view-type="bookmarks"
      current-view="bookmarks"
      @load-more-special-data="handleLoadMore"
      @refresh-timeline="handleRefresh"
      @favorite-post="handleFavoritePost"
      @reblog-post="handleReblogPost"
      @bookmark-post="handleBookmarkPost"
      @delete-post="handleDeletePost"
      @show-user-profile="handleShowUserProfile"
      @clear-all-bookmarks="handleClearAllBookmarks"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { debug } from '@/utils/debug'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import type { TimelinePost, FederatedUser } from '@/types'

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
  bookmarkPost: [post: TimelinePost]
  deletePost: [post: TimelinePost]
  showUserProfile: [user: FederatedUser]
  clearAllBookmarks: []
}>()

const activityPubStore = useActivityPubStore()

// State
const isLoadingBookmarks = ref(false)

// Computed
const bookmarks = computed(() => {
  return activityPubStore.bookmarks || []
})

const hasMoreBookmarks = computed(() => {
  return activityPubStore.hasMoreBookmarks
})

const loadBookmarks = async () => {
  isLoadingBookmarks.value = true
  try {
    await activityPubStore.loadBookmarks()
  } catch (error) {
    debug.error('Failed to load bookmarks:', error)
  } finally {
    isLoadingBookmarks.value = false
  }
}

// Event handlers
const handleLoadMore = async () => {
  try {
    await activityPubStore.loadMoreBookmarks()
  } catch (error) {
    debug.error('Failed to load more bookmarks:', error)
  }
}

const handleRefresh = () => {
  loadBookmarks()
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

const handleBookmarkPost = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleBookmark(post.id)
    emit('bookmarkPost', post)
  } catch (error) {
    debug.error('Failed to toggle bookmark:', error)
  }
}

const handleDeletePost = async (post: TimelinePost) => {
  try {
    await activityPubStore.deletePost(post.id)
    emit('deletePost', post)
    // Refresh bookmarks after deletion
    loadBookmarks()
  } catch (error) {
    debug.error('Failed to delete post:', error)
  }
}

const handleShowUserProfile = (user: FederatedUser) => {
  emit('showUserProfile', user)
}

const handleClearAllBookmarks = async () => {
  try {
    await activityPubStore.clearAllBookmarks()
    emit('clearAllBookmarks')
    loadBookmarks()
  } catch (error) {
    debug.error('Failed to clear all bookmarks:', error)
  }
}

onMounted(() => {
  loadBookmarks()
})
</script>

<style scoped>
.bookmarks-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>