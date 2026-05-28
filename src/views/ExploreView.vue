<template>
  <div class="explore-view">
    <!-- Mony Header -->
    <div class="mony-header-container">
      <MonyHeader
        :current-view="currentView"
        :is-mobile="isMobile"
        @switch-feed="handleSwitchFeed"
        @refresh-timeline="handleRefresh"
        @open-composer="handleOpenComposer"
        @open-search="handleOpenSearch"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-right-sidebar="$emit('toggleRightSidebar')"
      />
    </div>

    <!-- Explore Content -->
    <div class="explore-content">
      <ExploreContent
        ref="exploreContentRef"
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useRoute, useRouter } from 'vue-router'
import ExploreContent from '@/components/activitypub/ExploreContent.vue'
import MonyHeader from '@/components/activitypub/MonyHeader.vue'
import { useLayoutState } from '@/composables/useLayoutState'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { usePostInteractions } from '@/composables/usePostInteractions'
import type { TimelinePost, FederatedUser } from '@/types'

// Layout state
const { isMobile } = useLayoutState()

// Props
interface Props {
  currentView: 'trending' | 'instances'
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  followUser: [userId: string]
  unfollowUser: [userId: string]
  favoritePost: [postId: string]
  reblogPost: [postId: string]
  bookmarkPost: [postId: string]
  showUserProfile: [user: FederatedUser]
  toggleLeftSidebar: []
  toggleRightSidebar: []
  openSearch: []
}>()

// Store and composables
const activityPubStore = useActivityPubStore()
const { followUser, unfollowUser, toggleFavorite, toggleReblog, toggleBookmark } = usePostInteractions()
const route = useRoute()
const router = useRouter()

// Refs
const exploreContentRef = ref<InstanceType<typeof ExploreContent> | null>(null)

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
    debug.error('Failed to load explore data:', error)
  } finally {
    isLoading.value = false
  }
}

const loadTrending = async () => {
  try {
    debug.log('Loading trending data from TrendingService')
  } catch (error) {
    debug.error('Failed to load trending data:', error)
  }
}

const loadInstances = async () => {
  try {
    debug.log('Instances loaded via ExploreContent component')
  } catch (error) {
    debug.error('Failed to load instances:', error)
  }
}

// Event handlers using composables - much cleaner!
const handleLoadMore = async () => {
  try {
    if (props.currentView === 'trending') {
      // Load more trending content (using public feed for now)
      const lastPost = trendingPosts.value[trendingPosts.value.length - 1]
      await activityPubStore.loadPublicFeed(lastPost?.id)
      
      // Add new posts to trending
      const newPosts = activityPubStore.publicFeed.posts.filter(
        p => !trendingPosts.value.some(tp => tp.id === p.id)
      )
      trendingPosts.value.push(...newPosts.slice(0, 10))
    }
    // Instances don't need pagination for now
  } catch (error) {
    debug.error('Failed to load more explore data:', error)
  }
}

const handleRefresh = () => {
  exploreContentRef.value?.refreshContent()
}

// Clean composable-based handlers
const handleFollow = async (userId: string) => {
  const result = await followUser(userId)
  if (result.success) {
    emit('followUser', userId)
  }
}

const handleUnfollow = async (userId: string) => {
  const result = await unfollowUser(userId)
  if (result.success) {
    emit('unfollowUser', userId)
  }
}

const handleFavoritePost = async (postId: string) => {
  const result = await toggleFavorite(postId)
  if (!result.error) {
    emit('favoritePost', postId)
  }
}

const handleReblogPost = async (postId: string) => {
  const result = await toggleReblog(postId)
  if (!result.error) {
    emit('reblogPost', postId)
  }
}

const handleBookmarkPost = async (postId: string) => {
  const result = await toggleBookmark(postId)
  if (!result.error) {
    emit('bookmarkPost', postId)
  }
}

const handleShowUserProfile = (user: FederatedUser) => {
  emit('showUserProfile', user)
}

// MonyHeader event handlers
const handleSwitchFeed = (feed: string) => {
  router.push({ name: 'Social', params: { timeline: feed } })
}

const handleOpenComposer = () => {
  activityPubStore.openComposer()
}

const handleOpenSearch = () => {
  emit('openSearch')
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

.mony-header-container {
  flex-shrink: 0;
}

.explore-content {
  flex: 1;
  overflow: hidden;
}
</style>