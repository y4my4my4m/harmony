<template>
  <div class="bookmarks-view">
    <UnifiedContentArea
      mode="activitypub"
      :special-view-data="bookmarks"
      :has-more-special-data="hasMoreBookmarks"
      :is-loading-feed="isLoadingBookmarks"
      :load-error="loadError"
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
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
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
}>()

const activityPubStore = useActivityPubStore()
const { confirm } = useConfirmDialog()
const { t } = useI18n()
const toast = useToast()

// State
const isLoadingBookmarks = ref(false)
const loadError = ref<string | null>(null)

// Computed
const bookmarks = computed(() => {
  return activityPubStore.bookmarks || []
})

const hasMoreBookmarks = computed(() => {
  return activityPubStore.hasMoreBookmarks
})

const loadBookmarks = async () => {
  isLoadingBookmarks.value = true
  loadError.value = null
  try {
    await activityPubStore.loadBookmarks()
  } catch (error) {
    debug.error('Failed to load bookmarks:', error)
    loadError.value = error instanceof Error ? error.message : String(error)
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
  const confirmed = await confirm({
    title: t('activitypub.clearAllBookmarksTitle'),
    message: t('activitypub.clearAllBookmarksMessage', { count: bookmarks.value.length }),
    confirmButtonText: t('activitypub.clearAllBookmarks'),
    dangerAction: true,
  })
  if (!confirmed) return
  try {
    await activityPubStore.clearAllBookmarks()
  } catch (error) {
    debug.error('Failed to clear all bookmarks:', error)
    toast.error(t('activitypub.clearAllBookmarksFailed'))
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