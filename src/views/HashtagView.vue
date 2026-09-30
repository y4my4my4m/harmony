<template>
  <div class="hashtag-view">
    <ViewHeader :title="`#${hashtag}`" :subtitle="headerSubtitle" />

    <!-- Posts (virtualized) -->
    <PostsContainer
      :posts="posts"
      :is-loading="isLoading || isLoadingMore"
      :has-more="hasMore"
      :error="loadError"
      :loading-message="t('common.loading')"
      :empty-title="t('activitypub.noPostsYet')"
      :empty-message="t('activitypub.beFirstToUseHashtag', { tag: hashtag })"
      empty-icon="hash"
      @retry="handleRefresh"
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
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { debug } from '@/utils/debug'
import { trendingService } from '@/services/TrendingService'
import { activityPubService } from '@/services/activityPubService'
import { usePostInteractions } from '@/composables/usePostInteractions'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useFeedRealtime, type FeedKind } from '@/composables/useFeedRealtime'
import ViewHeader from '@/components/common/ViewHeader.vue'
import PostsContainer from '@/components/common/PostsContainer.vue'
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

defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  openSearch: []
}>()

const { t } = useI18n()

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
const loadError = ref<string | null>(null)

const headerSubtitle = computed(() => {
  if (isLoading.value && posts.value.length === 0) return undefined
  const total = hashtagStats.value?.total_uses || posts.value.length
  const parts = [t('activitypub.postsCountLabel', { count: total }, total)]
  if (hashtagStats.value?.daily_uses) {
    parts.push(t('activitypub.todayCount', { count: hashtagStats.value.daily_uses }))
  }
  return parts.join(' · ')
})

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
  loadError.value = null
  try {
    const result = await trendingService.getPostsByHashtag(props.hashtag, { limit: 20 })
    posts.value = result.posts
    hasMore.value = result.hasMore
    cursor.value = result.cursor
    debug.log(`Loaded ${result.posts.length} posts for #${props.hashtag}`)
  } catch (error) {
    debug.error('Failed to load hashtag posts:', error)
    loadError.value = error instanceof Error ? error.message : String(error)
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

const handleRefresh = () => {
  loadPosts()
  loadHashtagStats()
}

const loadHashtagStats = async () => {
  try {
    hashtagStats.value = await trendingService.getHashtagStats(props.hashtag)
  } catch (error) {
    debug.error('Failed to load hashtag stats:', error)
  }
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
  background-color: var(--background-primary);
  color: var(--text-primary);
  overflow: hidden;
}
</style>

