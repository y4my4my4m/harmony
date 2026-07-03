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
      <button class="refresh-btn" @click="loadDigest(true)" :disabled="loading" aria-label="Refresh">
        <Icon name="refresh-cw" :size="18" :class="{ spinning: loading }" />
      </button>
    </header>

    <div class="today-scroll">
      <div v-if="loading && !digest" class="today-loading">
        <LoadingSpinner :size="32" />
        <span>Gathering your day...</span>
      </div>

      <div v-else-if="digest" class="today-grid">
        <!-- On-device AI summary (optional) -->
        <section v-if="aiSummary || highlights.length > 0" class="today-card span-full">
          <div class="card-header">
            <Icon name="sparkles" :size="16" />
            <h2>Summary</h2>
            <span class="on-device-badge" title="Generated locally - nothing leaves your device">On-device</span>
          </div>
          <p v-if="aiSummary" class="ai-summary-text">{{ aiSummary }}</p>
          <ul v-if="highlights.length > 0" class="highlight-list">
            <li v-for="h in highlights" :key="h.channelId" class="highlight-item">
              <button class="channel-pill" @click="goToChannelId(h.serverId, h.channelId)">
                #{{ h.channelName }}
              </button>
              <span class="highlight-text">{{ h.summary }}</span>
            </li>
          </ul>
        </section>

        <!-- Mentions -->
        <section v-if="digest.unreadMentions > 0" class="today-card mentions-card span-full" @click="goToMentions">
          <div class="card-header">
            <Icon name="at-sign" :size="16" />
            <h2>Mentions</h2>
          </div>
          <p class="mentions-text">
            You have <strong>{{ digest.unreadMentions }}</strong> unread {{ digest.unreadMentions === 1 ? 'mention' : 'mentions' }}.
          </p>
        </section>

        <!-- Active channels, grouped by server -->
        <section class="today-card span-full">
          <div class="card-header">
            <Icon name="hash" :size="16" />
            <h2>Catch up</h2>
            <span class="card-hint">busiest unread channels across your servers</span>
          </div>
          <div v-if="channelsByServer.length === 0" class="empty-hint">
            All caught up - no unread channels.
          </div>
          <div v-for="group in channelsByServer" :key="group.serverId" class="server-group">
            <div class="server-group-header">
              <img
                :src="getServerIconUrl(group.serverIcon, 48)"
                :alt="group.serverName"
                class="server-icon"
              />
              <span class="server-name">{{ group.serverName }}</span>
            </div>
            <div class="channel-pills">
              <button
                v-for="channel in group.channels"
                :key="channel.channelId"
                class="channel-pill"
                :class="{ 'has-mentions': channel.unreadMentions > 0 }"
                @click="goToChannel(channel)"
              >
                <span class="pill-name">#{{ channel.channelName }}</span>
                <span v-if="channel.unreadMentions > 0" class="pill-mentions">@{{ channel.unreadMentions }}</span>
                <span class="pill-count">{{ channel.unreadMessages }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- Threads -->
        <section v-if="digest.activeThreads.length > 0" class="today-card">
          <div class="card-header">
            <Icon name="thread" :size="16" />
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
              <span class="row-subtitle">{{ thread.messageCount }} messages · {{ formatRelativeTime(thread.lastMessageAt) }}</span>
            </div>
            <Icon name="chevron-right" :size="16" class="row-chevron" />
          </button>
        </section>

        <!-- From people you follow -->
        <section v-if="digest.followedPosts.length > 0" class="today-card">
          <div class="card-header">
            <Icon name="users" :size="16" />
            <h2>From people you follow</h2>
          </div>
          <button
            v-for="post in digest.followedPosts"
            :key="post.id"
            class="digest-row"
            @click="goToPost(post)"
          >
            <Avatar
              :src="postAuthorAvatar(post)"
              :alt="postAuthorName(post)"
              size="sm"
              class="row-avatar"
            />
            <div class="row-main">
              <span class="row-title">{{ postAuthorName(post) }}</span>
              <span class="row-subtitle post-preview">{{ postPreview(post) }}</span>
            </div>
            <span class="row-stat">
              <Icon name="heart" :size="12" /> {{ post.favorites_count || 0 }}
            </span>
          </button>
        </section>

        <!-- Trending posts -->
        <section v-if="digest.trendingPosts.length > 0" class="today-card">
          <div class="card-header">
            <Icon name="trending-up" :size="16" />
            <h2>Trending in the Fediverse</h2>
          </div>
          <button
            v-for="post in digest.trendingPosts"
            :key="post.id"
            class="digest-row"
            @click="goToPost(post)"
          >
            <Avatar
              :src="postAuthorAvatar(post)"
              :alt="postAuthorName(post)"
              size="sm"
              class="row-avatar"
            />
            <div class="row-main">
              <span class="row-title">{{ postAuthorName(post) }}</span>
              <span class="row-subtitle post-preview">{{ postPreview(post) }}</span>
            </div>
            <span class="row-stat">
              <Icon name="heart" :size="12" /> {{ post.favorites_count || 0 }}
            </span>
          </button>
        </section>
      </div>

      <div v-else class="today-error">
        <p>Couldn't load your digest.</p>
        <button class="retry-btn" @click="loadDigest(true)">Retry</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { getServerIconUrl } from '@/utils/serverUtils'
import {
  todayDigestService,
  type TodayDigest,
  type ActiveChannelEntry,
  type ActiveThreadEntry,
  type ChannelHighlight,
} from '@/services/TodayDigestService'
import { useTodayDashboard } from '@/composables/useTodayDashboard'
import { userStorage } from '@/utils/userScopedStorage'
import type { TimelinePost } from '@/types'
import { debug } from '@/utils/debug'

const router = useRouter()
const { todayAiSummariesEnabled } = useTodayDashboard()

const loading = ref(false)
const digest = ref<TodayDigest | null>(null)
const aiSummary = ref<string | null>(null)
const highlights = ref<ChannelHighlight[]>([])

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 5) return 'Up late?'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
})

interface ServerGroup {
  serverId: string
  serverName: string
  serverIcon: string | null
  channels: ActiveChannelEntry[]
}

const channelsByServer = computed<ServerGroup[]>(() => {
  const groups = new Map<string, ServerGroup>()
  for (const channel of digest.value?.activeChannels || []) {
    let group = groups.get(channel.serverId)
    if (!group) {
      group = {
        serverId: channel.serverId,
        serverName: channel.serverName,
        serverIcon: channel.serverIcon,
        channels: [],
      }
      groups.set(channel.serverId, group)
    }
    group.channels.push(channel)
  }
  return [...groups.values()]
})

// On-device summarization isn't free (model spin-up per section), so AI
// output is cached per digest signature. Normal opens reuse it; the refresh
// button (force) always re-runs the model.
const AI_CACHE_KEY = 'today-ai-cache'
const AI_CACHE_MAX_AGE_MS = 12 * 3600_000

interface AiCacheEntry {
  signature: string
  summary: string | null
  highlights: ChannelHighlight[]
  at: number
}

const readAiCache = (): AiCacheEntry | null => {
  try {
    const raw = userStorage.getItem(AI_CACHE_KEY)
    return raw ? JSON.parse(raw) as AiCacheEntry : null
  } catch {
    return null
  }
}

const writeAiCache = (entry: AiCacheEntry) => {
  try {
    userStorage.setItem(AI_CACHE_KEY, JSON.stringify(entry))
  } catch { /* storage full - cache is best-effort */ }
}

const runAi = (snapshot: TodayDigest, signature: string) => {
  const entry: AiCacheEntry = { signature, summary: null, highlights: [], at: Date.now() }
  todayDigestService.summarizeDigest(snapshot)
    .then(summary => {
      aiSummary.value = summary
      entry.summary = summary
      writeAiCache(entry)
    })
    .catch(() => {})
  todayDigestService.getChannelHighlights(snapshot.activeChannels)
    .then(result => {
      highlights.value = result
      entry.highlights = result
      writeAiCache(entry)
    })
    .catch(() => {})
}

const loadDigest = async (force = false) => {
  loading.value = true
  try {
    digest.value = await todayDigestService.getDigest()

    // AI output is strictly additive; never block the digest on it.
    aiSummary.value = null
    highlights.value = []
    if (todayAiSummariesEnabled.value && digest.value) {
      const snapshot = digest.value
      const signature = todayDigestService.digestSignature(snapshot)
      const cached = readAiCache()
      const cacheUsable =
        !force &&
        cached !== null &&
        Date.now() - cached.at < AI_CACHE_MAX_AGE_MS &&
        cached.signature === signature

      if (cacheUsable) {
        aiSummary.value = cached.summary
        highlights.value = cached.highlights
      } else if (!force && cached && Date.now() - cached.at < AI_CACHE_MAX_AGE_MS) {
        // Inputs drifted (new messages since): show the cached text instantly,
        // refresh it in the background.
        aiSummary.value = cached.summary
        highlights.value = cached.highlights
        runAi(snapshot, signature)
      } else {
        runAi(snapshot, signature)
      }
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
  goToChannelId(channel.serverId, channel.channelId)
}

const goToChannelId = (serverId: string, channelId: string) => {
  router.push({ name: 'ChatChannel', params: { serverId, channelId } })
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

const postAuthorAvatar = (post: TimelinePost): string | undefined => {
  return (post as any).author?.avatar_url || undefined
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

onMounted(() => loadDigest())
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
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.today-title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
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
  flex-shrink: 0;
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

.today-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.today-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
  max-width: 1100px;
  margin: 0 auto;
}

.span-full {
  grid-column: 1 / -1;
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
  padding: 16px 20px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  color: var(--text-secondary);
}

.card-header h2 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.card-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-left: auto;
}

.on-device-badge {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

/* Summary */
.ai-summary-text {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 1.55;
}

.highlight-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.highlight-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.highlight-text {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--text-secondary);
  flex: 1;
  min-width: 200px;
}

/* Mentions */
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

/* Catch up: server groups + channel pills */
.server-group {
  padding: 10px 0;
}

.server-group + .server-group {
  border-top: 1px solid var(--border-color);
}

.server-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.server-icon {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}

.server-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.channel-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.channel-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 14px;
  border: 1px solid var(--border-color);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.channel-pill:hover {
  border-color: var(--harmony-primary);
}

.channel-pill.has-mentions {
  border-color: var(--harmony-primary-alpha, var(--harmony-primary));
}

.pill-name {
  font-weight: 500;
}

.pill-mentions {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--harmony-danger, #ef4444);
  color: #fff;
}

.pill-count {
  font-size: 11px;
  color: var(--text-muted);
}

/* Rows (threads / trending) */
.digest-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  margin: 0 -8px;
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

.row-avatar {
  flex-shrink: 0;
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
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

.row-chevron {
  color: var(--text-muted);
  flex-shrink: 0;
}

.row-stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

@media (max-width: 800px) {
  .today-grid {
    grid-template-columns: 1fr;
  }

  .today-scroll {
    padding: 12px;
  }

  .today-card {
    padding: 14px 16px;
  }

  .card-hint {
    display: none;
  }
}
</style>
