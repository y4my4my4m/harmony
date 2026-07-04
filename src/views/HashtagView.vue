<template>
  <div class="hashtag-view">
    <!-- Mony Header (search, compose, refresh, sidebar) -->
    <div class="mony-header-container">
      <MonyHeader
        :current-view="(props.currentView as string) ?? 'trending'"
        :is-mobile="isMobile"
        :right-sidebar-open="(props.rightSidebarOpen ?? false)"
        @switch-feed="handleSwitchFeed"
        @refresh-timeline="handleRefresh"
        @open-composer="handleOpenComposer"
        @open-search="handleOpenSearch"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-right-sidebar="$emit('toggleRightSidebar')"
      />
    </div>

    <!-- Hashtag Header -->
    <div class="hashtag-header">
      <button class="back-button" @click="goBack">
        <Icon name="arrow-left" :size="20" />
      </button>
      <div class="hashtag-info">
        <h1 class="hashtag-title">#{{ hashtag }}</h1>
        <div class="hashtag-stats" v-if="!isLoading">
          <span class="post-count">
            {{ hashtagStats?.total_uses || posts.length }} {{ (hashtagStats?.total_uses || posts.length) === 1 ? 'post' : 'posts' }}
          </span>
          <span v-if="hashtagStats?.daily_uses" class="daily-stat">
            {{ hashtagStats.daily_uses }} today
          </span>
          <span v-if="hashtagStats?.last_used_at" class="last-used">
            Last used {{ formatTimeAgo(hashtagStats.last_used_at) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Posts (virtualized) -->
    <PostsContainer
      :posts="posts"
      :is-loading="isLoading || isLoadingMore"
      :has-more="hasMore"
      loading-message="Loading posts..."
      empty-title="No posts yet"
      :empty-message="`Be the first to post with #${hashtag}`"
      empty-icon="hash"
      @load-more="loadMorePosts"
      @reply="handleReply"
      @favorite="handleFavorite"
      @reblog="handleReblog"
      @bookmark="handleBookmark"
      @delete="handleDelete"
      @user-click="handleUserClick"
      @hashtag-click="handleHashtagClick"
      @show-conversation="handleShowConversation"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { debug } from '@/utils/debug'
import { trendingService } from '@/services/TrendingService'
import { activityPubService } from '@/services/activityPubService'
import { usePostInteractions } from '@/composables/usePostInteractions'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useFeedRealtime, type FeedKind } from '@/composables/useFeedRealtime'
import { useLayoutState } from '@/composables/useLayoutState'
import MonyHeader from '@/components/activitypub/MonyHeader.vue'
import PostsContainer from '@/components/common/PostsContainer.vue'
import Icon from '@/components/common/Icon.vue'
import { getOriginalPostId, getReplyMentionAuthor } from '@/utils/postReblog'
import type { TimelinePost } from '@/types'

// Props
interface Props {
  hashtag: string
  currentView?: string
  viewType?: string
  rightSidebarOpen?: boolean
}

const props = defineProps<Props>()

// Emits (for layout events)
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  openSearch: []
}>()

const { isMobile } = useLayoutState()

// Router
const router = useRouter()

const activityPubStore = useActivityPubStore()

// State
const posts = ref<TimelinePost[]>([])
const isLoading = ref(false)
const isLoadingMore = ref(false)
const hasMore = ref(false)
const cursor = ref<string | null>(null)
const hashtagStats = ref<any>(null)

// Realtime - keep the active subscription scoped to whichever tag this
// view is showing. `feed:hashtag:{normalized}` is published by the
// `broadcast_post_event` trigger; normalization mirrors the DB rule
// (`lower(trim(...))`) so the topic name matches exactly.
const feedKind = computed<FeedKind>(
  () => `hashtag:${(props.hashtag || '').replace(/^#/, '').trim().toLowerCase()}` as const
)
useFeedRealtime(feedKind, {
  onCreate: async (event) => {
    if (posts.value.some(p => p.id === event.id)) return
    const fullPost = await activityPubService.loadPostWithAuthor(event.id)
    if (!fullPost) return
    posts.value = [fullPost as TimelinePost, ...posts.value]
  },
  onUpdate: (event) => {
    if (event.visibility && event.visibility !== 'public') {
      posts.value = posts.value.filter(p => p.id !== event.id)
    }
  },
  onDelete: (event) => {
    posts.value = posts.value.filter(p => p.id !== event.id)
  },
})

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

const handleRefresh = () => {
  loadPosts()
  loadHashtagStats()
}

const handleSwitchFeed = (feed: string) => {
  router.push({ name: 'Social', params: { timeline: feed } })
}

const handleOpenComposer = () => {
  activityPubStore.openComposer()
}

const handleOpenSearch = () => {
  emit('openSearch')
}

const loadHashtagStats = async () => {
  try {
    hashtagStats.value = await trendingService.getHashtagStats(props.hashtag)
  } catch (error) {
    debug.error('Failed to load hashtag stats:', error)
  }
}

const formatTimeAgo = (dateStr: string): string => {
  const diff = Date.now() - new Date(dateStr).getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

// Event handlers
const handleReply = (post: TimelinePost) => {
  // For pure reblogs, route the reply to the original post and prefill the
  // original author's mention - same rule as `UserProfileView.replyToPost`
  // and `SocialLayout.handleReplyToPost`. Quote posts and regular posts
  // pass through unchanged via the shared util.
  const author = getReplyMentionAuthor(post)
  const handle = author?.handle || ''
  const mentionText = handle
    ? (handle.startsWith('@') ? `${handle} ` : `@${handle} `)
    : ''
  activityPubStore.openComposer({
    replyTo: getOriginalPostId(post),
    content: mentionText,
  })
}

// Handlers receive the full TimelinePost (PostsContainer forwards
// `posts[index]` for these chains, since MonyPost handles favorite/reblog/
// bookmark internally and only fires these as a pass-through hook for
// consumers that need the post object).
const handleFavorite = async (post: TimelinePost) => {
  await toggleFavorite(post.id)
}

const handleReblog = async (post: TimelinePost) => {
  await toggleReblog(post.id)
}

const handleBookmark = async (post: TimelinePost) => {
  await toggleBookmark(post.id)
}

const handleDelete = async (post: TimelinePost) => {
  await activityPubStore.deletePost(post.id)
  posts.value = posts.value.filter(p => p.id !== post.id)
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

onMounted(() => {
  loadPosts()
  loadHashtagStats()
})
</script>

<style scoped>
.hashtag-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--background-primary, #111827);
  color: var(--text-primary, #f3f4f6);
  overflow: hidden;
}

.mony-header-container {
  flex-shrink: 0;
}

.hashtag-view .mony-post {
  max-width: 680px;
  margin: 20px auto;
}

.hashtag-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  border-bottom: 1px solid var(--border-color, #374151);
  background-color: var(--background-secondary, #1f2937);
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
  background-color: var(--background-hover, #374151);
}

.hashtag-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.hashtag-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--harmony-accent);
  margin: 0;
}

.hashtag-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.post-count {
  font-size: 0.875rem;
  color: var(--text-secondary, #9ca3af);
}

.daily-stat {
  font-size: 0.8rem;
  color: var(--harmony-primary, #0EA5E9);
  font-weight: 500;
}

.last-used {
  font-size: 0.8rem;
  color: var(--text-tertiary, #6b7280);
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
  background-color: var(--background-tertiary, #374151);
  color: var(--text-primary, #f3f4f6);
  border-radius: 0.5rem;
  border: none;
  cursor: pointer;
  transition: background-color 0.2s;
}

.load-more-btn:hover {
  background-color: var(--background-hover, #4b5563);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}
</style>

