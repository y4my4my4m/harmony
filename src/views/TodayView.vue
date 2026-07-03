<template>
  <div class="today-view">
    <header class="today-header">
      <button class="back-btn" @click="goBack" aria-label="Back">
        <Icon name="arrow-left" :size="20" />
      </button>
      <div class="today-title">
        <h1>{{ greeting }}</h1>
        <span class="beta-badge">Beta</span>
      </div>
      <button class="refresh-btn" @click="loadDigest" :disabled="loading" aria-label="Refresh">
        <Icon name="refresh-cw" :size="18" :class="{ spinning: loading }" />
      </button>
    </header>

    <div class="today-content">
      <div v-if="loading && !digest" class="today-loading">
        <LoadingSpinner :size="32" />
        <span>Gathering your day...</span>
      </div>

      <template v-else-if="digest">
        <!-- On-device AI summary (optional) -->
        <section v-if="aiSummary" class="today-card ai-summary-card">
          <div class="card-header">
            <Icon name="sparkles" :size="18" />
            <h2>Summary</h2>
            <span class="on-device-badge" title="Generated locally - nothing leaves your device">On-device</span>
          </div>
          <p class="ai-summary-text">{{ aiSummary }}</p>
        </section>

        <!-- Mentions -->
        <section v-if="digest.unreadMentions > 0" class="today-card mentions-card" @click="goToMentions">
          <div class="card-header">
            <Icon name="at-sign" :size="18" />
            <h2>Mentions</h2>
          </div>
          <p class="mentions-text">
            You have <strong>{{ digest.unreadMentions }}</strong> unread {{ digest.unreadMentions === 1 ? 'mention' : 'mentions' }}.
          </p>
        </section>

        <!-- Active channels -->
        <section class="today-card">
          <div class="card-header">
            <Icon name="hash" :size="18" />
            <h2>Catch up</h2>
          </div>
          <div v-if="digest.activeChannels.length === 0" class="empty-hint">
            All caught up - no unread channels.
          </div>
          <button
            v-for="channel in digest.activeChannels"
            :key="channel.channelId"
            class="digest-row"
            @click="goToChannel(channel)"
          >
            <div class="row-main">
              <span class="row-title">#{{ channel.channelName }}</span>
              <span class="row-subtitle">{{ channel.serverName }}</span>
            </div>
            <div class="row-meta">
              <span v-if="channel.unreadMentions > 0" class="mention-badge">@{{ channel.unreadMentions }}</span>
              <span class="unread-count">{{ channel.unreadMessages }} new</span>
            </div>
          </button>
        </section>

        <!-- Threads -->
        <section v-if="digest.activeThreads.length > 0" class="today-card">
          <div class="card-header">
            <Icon name="thread" :size="18" />
            <h2>Your threads</h2>
          </div>
          <button
            v-for="thread in digest.activeThreads"
            :key="thread.threadId"
            class="digest-row"
            @click="goToThread(thread)"
          >
            <div class="row-main">
              <span class="row-title">{{ thread.name }}</span>
              <span class="row-subtitle">{{ formatRelativeTime(thread.lastMessageAt) }}</span>
            </div>
            <div class="row-meta">
              <span class="unread-count">{{ thread.messageCount }} messages</span>
            </div>
          </button>
        </section>

        <!-- Trending posts -->
        <section v-if="digest.trendingPosts.length > 0" class="today-card">
          <div class="card-header">
            <Icon name="trending-up" :size="18" />
            <h2>Trending in the Monyverse</h2>
          </div>
          <button
            v-for="post in digest.trendingPosts"
            :key="post.id"
            class="digest-row"
            @click="goToPost(post)"
          >
            <div class="row-main">
              <span class="row-title">{{ postAuthorName(post) }}</span>
              <span class="row-subtitle post-preview">{{ postPreview(post) }}</span>
            </div>
            <div class="row-meta">
              <span class="unread-count">
                <Icon name="heart" :size="12" /> {{ post.favorites_count || 0 }}
              </span>
            </div>
          </button>
        </section>
      </template>

      <div v-else class="today-error">
        <p>Couldn't load your digest.</p>
        <button class="retry-btn" @click="loadDigest">Retry</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { todayDigestService, type TodayDigest, type ActiveChannelEntry, type ActiveThreadEntry } from '@/services/TodayDigestService'
import { useTodayDashboard } from '@/composables/useTodayDashboard'
import type { TimelinePost } from '@/types'
import { debug } from '@/utils/debug'

const router = useRouter()
const { todayAiSummariesEnabled } = useTodayDashboard()

const loading = ref(false)
const digest = ref<TodayDigest | null>(null)
const aiSummary = ref<string | null>(null)

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 5) return 'Up late?'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
})

const loadDigest = async () => {
  loading.value = true
  try {
    digest.value = await todayDigestService.getDigest()

    // Summary is strictly additive; never block the digest on it.
    aiSummary.value = null
    if (todayAiSummariesEnabled.value && digest.value) {
      todayDigestService.summarizeDigest(digest.value)
        .then(summary => { aiSummary.value = summary })
        .catch(() => {})
    }
  } catch (error) {
    debug.error('Failed to load today digest:', error)
    digest.value = null
  } finally {
    loading.value = false
  }
}

const goBack = () => router.back()
const goToMentions = () => router.push('/social/mentions')

const goToChannel = (channel: ActiveChannelEntry) => {
  router.push({ name: 'ChatChannel', params: { serverId: channel.serverId, channelId: channel.channelId } })
}

const goToThread = (thread: ActiveThreadEntry) => {
  router.push({ name: 'ThreadView', params: { serverId: thread.serverId, threadId: thread.threadId } })
}

const goToPost = (post: TimelinePost) => {
  router.push(`/posts/${post.id}`)
}

const postAuthorName = (post: TimelinePost): string => {
  const author = (post as any).author
  return author?.display_name || author?.username || 'Unknown'
}

const postPreview = (post: TimelinePost): string => {
  const content = (post as any).content
  if (typeof content === 'string') return content.slice(0, 120)
  if (Array.isArray(content)) {
    const text = content
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join(' ')
    return text.slice(0, 120) || 'View post'
  }
  return 'View post'
}

const formatRelativeTime = (iso: string | null): string => {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

onMounted(loadDigest)
</script>

<style scoped>
.today-view {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
  color: var(--text-primary);
}

.today-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.today-title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.today-title h1 {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
}

.beta-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--harmony-primary);
  color: var(--text-light, #fff);
}

.back-btn,
.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}

.back-btn:hover,
.refresh-btn:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.today-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
}

.today-loading,
.today-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 16px;
  color: var(--text-secondary);
}

.retry-btn {
  padding: 8px 20px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--background-secondary);
  color: var(--text-primary);
  cursor: pointer;
}

.today-card {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--text-secondary);
}

.card-header h2 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
  flex: 1;
  text-align: left;
}

.on-device-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.ai-summary-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
}

.mentions-card {
  cursor: pointer;
}

.mentions-card:hover {
  border-color: var(--harmony-primary);
}

.mentions-text {
  margin: 0;
  font-size: 14px;
}

.empty-hint {
  font-size: 13px;
  color: var(--text-muted);
  padding: 4px 0;
}

.digest-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  margin: 0 -4px;
  background: none;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
}

.digest-row:hover {
  background: var(--background-tertiary);
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.row-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-subtitle {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.post-preview {
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.mention-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 10px;
  background: var(--harmony-danger, #ef4444);
  color: #fff;
}

.unread-count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

@media (max-width: 480px) {
  .today-content {
    padding: 12px;
    gap: 12px;
  }

  .today-card {
    padding: 12px;
  }
}
</style>
