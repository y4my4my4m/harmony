<template>
  <div class="instance-posts-view">
    <ViewHeader
      :title="domain"
      :subtitle="t('activitypub.instancePosts.subtitle', { domain })"
      :back-fallback="{ name: 'SocialInstances' }"
    />

    <PostsContainer
      :posts="posts"
      :is-loading="isLoading || isLoadingMore"
      :has-more="hasMore"
      :error="loadError"
      :loading-message="t('common.loading')"
      :feed-label="t('activitypub.instancePosts.feedLabel', { domain })"
      :empty-title="t('activitypub.instancePosts.emptyTitle', { domain })"
      :empty-message="t('activitypub.instancePosts.emptyMessage', { domain })"
      empty-icon="globe"
      @retry="loadPosts"
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
// Public posts by accounts of one instance, as this instance holds them
// (activityPubService.getInstanceActivity), newest first.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { debug } from '@/utils/debug'
import { activityPubService } from '@/services/activityPubService'
import { usePostInteractions } from '@/composables/usePostInteractions'
import { useActivityPubStore } from '@/stores/useActivityPub'
import ViewHeader from '@/components/common/ViewHeader.vue'
import PostsContainer from '@/components/common/PostsContainer.vue'
import { getOriginalPostId, getReplyMentionAuthor } from '@/utils/postReblog'
import type { TimelinePost } from '@/types'

interface Props {
  instanceDomain: string
  currentView?: string
  viewType?: string
  rightSidebarOpen?: boolean
}

const props = defineProps<Props>()

// SocialLayout's RouterView props stay off the root element.
defineOptions({ inheritAttrs: false })

defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  openSearch: []
}>()

const { t } = useI18n()
const router = useRouter()
const activityPubStore = useActivityPubStore()
const { toggleFavorite, toggleReblog, toggleBookmark } = usePostInteractions()

const PAGE = 20

const domain = computed(() => props.instanceDomain.trim().toLowerCase())
const posts = ref<TimelinePost[]>([])
const isLoading = ref(false)
const isLoadingMore = ref(false)
const hasMore = ref(false)
const cursor = ref<string | null>(null)
const loadError = ref<string | null>(null)

// A page answered after the domain changed is dropped.
let generation = 0

async function loadPosts() {
  const run = ++generation
  isLoading.value = true
  loadError.value = null
  try {
    const result = await activityPubService.getInstanceActivity(domain.value, { limit: PAGE })
    if (run !== generation) return
    posts.value = result.posts
    hasMore.value = result.hasMore
    cursor.value = result.cursor
  } catch (error) {
    if (run !== generation) return
    debug.error('Failed to load instance posts:', error)
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (run === generation) isLoading.value = false
  }
}

async function loadMorePosts() {
  if (!cursor.value || isLoadingMore.value) return
  const run = generation
  isLoadingMore.value = true
  try {
    const result = await activityPubService.getInstanceActivity(domain.value, { limit: PAGE, cursor: cursor.value })
    if (run !== generation) return
    const seen = new Set(posts.value.map(p => p.id))
    posts.value = [...posts.value, ...result.posts.filter(p => !seen.has(p.id))]
    hasMore.value = result.hasMore
    cursor.value = result.cursor
  } catch (error) {
    debug.error('Failed to load more instance posts:', error)
  } finally {
    isLoadingMore.value = false
  }
}

// Same reply rule as HashtagView and SocialLayout: a pure boost replies to the original.
function handleReply(post: TimelinePost) {
  const handle = getReplyMentionAuthor(post)?.handle || ''
  const mentionText = handle ? (handle.startsWith('@') ? `${handle} ` : `@${handle} `) : ''
  activityPubStore.openComposer({ replyTo: getOriginalPostId(post), content: mentionText })
}

const handleFavorite = async (post: TimelinePost) => { await toggleFavorite(post.id) }
const handleReblog = async (post: TimelinePost) => { await toggleReblog(post.id) }
const handleBookmark = async (post: TimelinePost) => { await toggleBookmark(post.id) }

async function handleDelete(post: TimelinePost) {
  await activityPubStore.deletePost(post.id)
  posts.value = posts.value.filter(p => p.id !== post.id)
}

function handleUserClick(user: any) {
  const handle = user.is_local ? `@${user.username}` : `@${user.username}@${user.domain}`
  router.push({ name: 'UserProfile', params: { handle } })
}

function handleHashtagClick(tag: string) {
  router.push({ name: 'HashtagView', params: { tag } })
}

function handleShowConversation(postId: string) {
  router.push({ name: 'PostDetail', params: { postId } })
}

watch(domain, (next, previous) => {
  if (next && next !== previous) {
    posts.value = []
    cursor.value = null
    void loadPosts()
  }
})

onMounted(() => {
  void loadPosts()
})
</script>

<style scoped>
.instance-posts-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--background-primary);
  color: var(--text-primary);
  overflow: hidden;
}
</style>
