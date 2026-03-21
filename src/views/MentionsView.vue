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
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { usePostInteractions } from '@/composables/usePostInteractions'
import type { TimelinePost, FederatedUser } from '@/types'

const activityPubStore = useActivityPubStore()
const { toggleFavorite, toggleReblog } = usePostInteractions()

const isLoadingMentions = computed(() => activityPubStore.isLoadingFeed)

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

const handleShowUserProfile = (user: FederatedUser) => {
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
