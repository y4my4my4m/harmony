<template>
  <div class="mentions-view">
    <UnifiedContentArea
      mode="activitypub"
      :special-view-data="mentionedPosts"
      :has-more-special-data="hasMoreMentions"
      :is-loading-feed="isLoadingMentions"
      view-type="mentions"
      current-view="mentions"
      @load-more-special-data="handleLoadMore"
      @refresh-timeline="handleRefresh"
      @favorite-post="handleFavoritePost"
      @reblog-post="handleReblogPost"
      @show-user-profile="handleShowUserProfile"
      @follow-user="handleFollow"
      @unfollow-user="handleUnfollow"
      @posts-visible="handlePostsVisible"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useNotificationStore } from '@/stores/useNotification'
import { usePostInteractions } from '@/composables/usePostInteractions'
import type { TimelinePost, FederatedUser } from '@/types'

const activityPubStore = useActivityPubStore()
const notificationStore = useNotificationStore()
const { toggleFavorite, toggleReblog } = usePostInteractions()

// Track which post ids we've already asked the store to clear notifications
// for, so a noisy `posts-visible` stream (re-fires on every overscan change
// during scroll) doesn't spam the DB with redundant UPDATE statements.
const handledPostIds = new Set<string>()

const handlePostsVisible = (postIds: string[]) => {
  const fresh = postIds.filter(id => !handledPostIds.has(id))
  if (fresh.length === 0) return
  fresh.forEach(id => handledPostIds.add(id))
  notificationStore.markMentionNotificationsForPostsAsRead(fresh).catch(err => {
    debug.warn('Failed to mark mention notifications as read for visible posts:', err)
    // Allow retry on next visibility tick if the call fails.
    fresh.forEach(id => handledPostIds.delete(id))
  })
}

const isLoadingMentions = computed(() => activityPubStore.isFeedLoading('mentions'))

const mentionedPosts = computed(() => {
  return activityPubStore.mentionsFeed.posts || []
})

const hasMoreMentions = computed(() => {
  return activityPubStore.mentionsFeed.has_more
})

const loadMentions = async () => {
  try {
    await activityPubStore.loadMentionedPosts()
  } catch (error) {
    debug.error('Failed to load mentions:', error)
  }
}

const handleLoadMore = async () => {
  try {
    const cursor = activityPubStore.mentionsFeed.cursor
    await activityPubStore.loadMentionedPosts(cursor)
  } catch (error) {
    debug.error('Failed to load more mentions:', error)
  }
}

const handleRefresh = () => {
  loadMentions()
}

const handleFavoritePost = async (post: TimelinePost) => {
  try {
    await toggleFavorite(post.id)
  } catch (error) {
    debug.error('Failed to favorite post:', error)
  }
}

const handleReblogPost = async (post: TimelinePost) => {
  try {
    await toggleReblog(post.id)
  } catch (error) {
    debug.error('Failed to reblog post:', error)
  }
}

const handleShowUserProfile = (_user: FederatedUser) => {
  // Handled by parent layout
}

const handleFollow = async (user: FederatedUser) => {
  try {
    await activityPubStore.followUser(user.id)
  } catch (error) {
    debug.error('Failed to follow user:', error)
  }
}

const handleUnfollow = async (user: FederatedUser) => {
  try {
    await activityPubStore.unfollowUser(user.id)
  } catch (error) {
    debug.error('Failed to unfollow user:', error)
  }
}

onMounted(() => {
  loadMentions()
})
</script>

<style scoped>
.mentions-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
