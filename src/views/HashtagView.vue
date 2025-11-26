<template>
  <div class="hashtag-view">
    <!-- Hashtag Header -->
    <div class="hashtag-header">
      <button class="back-button" @click="goBack">
        <Icon name="arrow-left" :size="20" />
      </button>
      <div class="hashtag-info">
        <h1 class="hashtag-title">#{{ hashtag }}</h1>
        <span class="post-count" v-if="!isLoading">
          {{ posts.length }} {{ posts.length === 1 ? 'post' : 'posts' }}
        </span>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="isLoading && posts.length === 0" class="loading-state">
      <div class="loading-spinner"></div>
      <p>Loading posts...</p>
    </div>

    <!-- Empty State -->
    <div v-else-if="!isLoading && posts.length === 0" class="empty-state">
      <Icon name="hash" :size="48" />
      <h3>No posts yet</h3>
      <p>Be the first to post with #{{ hashtag }}</p>
    </div>

    <!-- Posts List -->
    <div v-else class="posts-container">
      <MonyPost
        v-for="post in posts"
        :key="post.id"
        :post="post"
        @reply="handleReply"
        @favorite="handleFavorite"
        @reblog="handleReblog"
        @bookmark="handleBookmark"
        @delete="handleDelete"
        @user-click="handleUserClick"
        @hashtag-click="handleHashtagClick"
        @show-conversation="handleShowConversation"
      />

      <!-- Load More -->
      <div v-if="hasMore" class="load-more-container">
        <button
          @click="loadMorePosts"
          :disabled="isLoadingMore"
          class="load-more-btn"
        >
          <Icon v-if="isLoadingMore" name="loader" class="spinning" />
          <span>{{ isLoadingMore ? 'Loading...' : 'Load More' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { debug } from '@/utils/debug'
import { trendingService } from '@/services/TrendingService'
import { usePostInteractions } from '@/composables/usePostInteractions'
import { useActivityPubStore } from '@/stores/useActivityPub'
import MonyPost from '@/components/activitypub/MonyPost.vue'
import Icon from '@/components/common/Icon.vue'
import type { TimelinePost } from '@/types'

// Props
interface Props {
  hashtag: string
  currentView?: string
  viewType?: string
}

const props = defineProps<Props>()

// Router
const router = useRouter()
const route = useRoute()

// Store
const activityPubStore = useActivityPubStore()

// State
const posts = ref<TimelinePost[]>([])
const isLoading = ref(false)
const isLoadingMore = ref(false)
const hasMore = ref(false)
const cursor = ref<string | null>(null)

// Post interactions
const { toggleFavorite, toggleReblog, toggleBookmark } = usePostInteractions()

// Methods
const loadPosts = async () => {
  if (!props.hashtag) return
  
  isLoading.value = true
  try {
    const result = await trendingService.getPostsByHashtag(props.hashtag, { limit: 20 })
    posts.value = result.posts
    hasMore.value = result.hasMore
    cursor.value = result.cursor
    debug.log(`✅ Loaded ${result.posts.length} posts for #${props.hashtag}`)
  } catch (error) {
    debug.error('Failed to load hashtag posts:', error)
  } finally {
    isLoading.value = false
  }
}

const loadMorePosts = async () => {
  if (!cursor.value || isLoadingMore.value) return
  
  isLoadingMore.value = true
  try {
    const result = await trendingService.getPostsByHashtag(props.hashtag, { 
      limit: 20, 
      cursor: cursor.value 
    })
    posts.value = [...posts.value, ...result.posts]
    hasMore.value = result.hasMore
    cursor.value = result.cursor
  } catch (error) {
    debug.error('Failed to load more hashtag posts:', error)
  } finally {
    isLoadingMore.value = false
  }
}

const goBack = () => {
  router.back()
}

// Event handlers
const handleReply = (post: TimelinePost) => {
  activityPubStore.openComposer(post.id)
}

const handleFavorite = async (postId: string) => {
  await toggleFavorite(postId)
}

const handleReblog = async (postId: string) => {
  await toggleReblog(postId)
}

const handleBookmark = async (postId: string) => {
  await toggleBookmark(postId)
}

const handleDelete = async (postId: string) => {
  await activityPubStore.deletePost(postId)
  posts.value = posts.value.filter(p => p.id !== postId)
}

const handleUserClick = (user: any) => {
  const handle = user.is_local ? `@${user.username}` : `@${user.username}@${user.domain}`
  router.push({ name: 'UserProfile', params: { handle } })
}

const handleHashtagClick = (tag: string) => {
  router.push({ name: 'HashtagView', params: { tag } })
}

const handleShowConversation = (postId: string) => {
  router.push({ name: 'PostDetail', params: { postId } })
}

// Watch for hashtag changes
watch(() => props.hashtag, (newTag, oldTag) => {
  if (newTag && newTag !== oldTag) {
    posts.value = []
    cursor.value = null
    loadPosts()
  }
})

// Load on mount
onMounted(() => {
  loadPosts()
})
</script>

<style scoped>
.hashtag-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-primary, #111827);
  color: var(--text-primary, #f3f4f6);
  overflow: hidden;
}

.hashtag-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  border-bottom: 1px solid var(--border-color, #374151);
  background-color: var(--bg-secondary, #1f2937);
  flex-shrink: 0;
}

.back-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: transparent;
  border: none;
  color: var(--text-primary, #f3f4f6);
  cursor: pointer;
  transition: background-color 0.2s;
}

.back-button:hover {
  background-color: var(--bg-hover, #374151);
}

.hashtag-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.hashtag-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: #60a5fa;
  margin: 0;
}

.post-count {
  font-size: 0.875rem;
  color: var(--text-secondary, #9ca3af);
}

.loading-state,
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  color: var(--text-secondary, #9ca3af);
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color, #374151);
  border-top-color: #60a5fa;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state h3 {
  color: var(--text-primary, #f3f4f6);
  margin: 0;
}

.empty-state p {
  margin: 0;
}

.posts-container {
  flex: 1;
  overflow-y: auto;
}

.posts-container > :deep(.mony-post) + :deep(.mony-post) {
  border-top: 1px solid var(--border-color, #374151);
}

.load-more-container {
  padding: 1rem;
  display: flex;
  justify-content: center;
}

.load-more-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  background-color: var(--bg-tertiary, #374151);
  color: var(--text-primary, #f3f4f6);
  border-radius: 0.5rem;
  border: none;
  cursor: pointer;
  transition: background-color 0.2s;
}

.load-more-btn:hover {
  background-color: var(--bg-hover, #4b5563);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}
</style>

