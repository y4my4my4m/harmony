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
        <!-- On-device AI summary (optional). The card renders as soon as the
             feature is on - a spinner while the model works beats the card
             popping in seconds after the page settled. -->
        <section
          v-if="todayAiSummariesEnabled && (aiPending || aiSummary || highlights.length > 0)"
          class="today-card span-full"
        >
          <div class="today-card-header">
            <Icon name="sparkles" :size="16" />
            <h2>Summary</h2>
            <span class="on-device-badge" title="Generated locally - nothing leaves your device">On-device</span>
          </div>
          <div v-if="aiPending && !aiSummary && highlights.length === 0" class="ai-pending">
            <LoadingSpinner :size="16" />
            <span>Summarizing on this device…</span>
          </div>
          <div v-else-if="highlightsPending && highlights.length === 0" class="ai-pending">
            <LoadingSpinner :size="16" />
            <span>Summarizing channel conversations…</span>
          </div>
          <p v-if="aiSummary" class="ai-summary-text">
            <template v-for="(segment, i) in summarySegments" :key="i">
              <button
                v-if="segment.channel"
                class="channel-pill inline-channel-pill"
                @click="goToChannelId(segment.channel.serverId, segment.channel.channelId)"
              >#{{ segment.channel.channelName }}</button>
              <button
                v-else-if="segment.user"
                class="user-chip"
                :style="segment.user.color ? { color: segment.user.color } : undefined"
                @click="openUserProfile(segment.user)"
              >
                <span class="user-chip-name">{{ segment.text }}</span>
                <Avatar :src="segment.user.avatarUrl" :alt="segment.user.displayName" size="mini" class="user-chip-avatar" />
              </button>
              <template v-else>{{ segment.text }}</template>
            </template>
          </p>
          <!-- Same server-grouped presentation as Catch up -->
          <div v-for="group in highlightsByServer" :key="group.serverId" class="server-group">
            <div class="server-group-header">
              <img
                :src="getServerIconUrl(group.serverIcon, 48)"
                :alt="group.serverName"
                class="server-icon"
              />
              <span class="server-name">{{ group.serverName }}</span>
            </div>
            <ul class="highlight-list">
              <li v-for="h in group.highlights" :key="h.channelId" class="highlight-item">
                <button class="channel-pill" @click="goToChannelId(h.serverId, h.channelId)">
                  #{{ h.channelName }}
                </button>
                <span class="highlight-text">{{ h.summary }}</span>
              </li>
            </ul>
          </div>
        </section>

        <!-- Mentions -->
        <section v-if="digest.unreadMentions > 0" class="today-card mentions-card span-full" @click="goToMentions">
          <div class="today-card-header">
            <Icon name="at-sign" :size="16" />
            <h2>Mentions</h2>
          </div>
          <p class="mentions-text">
            You have <strong>{{ digest.unreadMentions }}</strong> unread {{ digest.unreadMentions === 1 ? 'mention' : 'mentions' }}.
          </p>
        </section>

        <!-- Active channels, grouped by server -->
        <section class="today-card span-full">
          <div class="today-card-header">
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
          <div class="today-card-header">
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
          <div class="today-card-header">
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
            <div class="row-stats">
              <span class="row-stat" title="Replies">
                <Icon name="message-circle" :size="12" /> {{ post.replies_count || 0 }}
              </span>
              <span class="row-stat" title="Reblogs">
                <Icon name="repeat" :size="12" /> {{ post.reblogs_count || 0 }}
              </span>
              <span class="row-stat" title="Favorites">
                <Icon name="heart" :size="12" /> {{ post.favorites_count || 0 }}
              </span>
            </div>
          </button>
        </section>

        <!-- Trending posts -->
        <section v-if="digest.trendingPosts.length > 0" class="today-card">
          <div class="today-card-header">
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
            <div class="row-stats">
              <span class="row-stat" title="Replies">
                <Icon name="message-circle" :size="12" /> {{ post.replies_count || 0 }}
              </span>
              <span class="row-stat" title="Reblogs">
                <Icon name="repeat" :size="12" /> {{ post.reblogs_count || 0 }}
              </span>
              <span class="row-stat" title="Favorites">
                <Icon name="heart" :size="12" /> {{ post.favorites_count || 0 }}
              </span>
            </div>
          </button>
        </section>
      </div>

      <div v-else class="today-error">
        <p>Couldn't load your digest.</p>
        <button class="retry-btn" @click="loadDigest(true)">Retry</button>
      </div>
    </div>

    <UserProfileModal
      :show="showProfileModal"
      :user="profileModalUser"
      @close="showProfileModal = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import UserProfileModal from '@/components/UserProfileModal.vue'
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
const aiPending = ref(false)
const highlightsPending = ref(false)

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

interface HighlightGroup {
  serverId: string
  serverName: string
  serverIcon: string | null
  highlights: ChannelHighlight[]
}

const highlightsByServer = computed<HighlightGroup[]>(() => {
  const groups = new Map<string, HighlightGroup>()
  for (const h of highlights.value) {
    let group = groups.get(h.serverId)
    if (!group) {
      group = { serverId: h.serverId, serverName: h.serverName, serverIcon: h.serverIcon, highlights: [] }
      groups.set(h.serverId, group)
    }
    group.highlights.push(h)
  }
  return [...groups.values()]
})

interface SummaryAuthor {
  id: string
  displayName: string
  username?: string
  avatarUrl?: string
  color?: string | null
  domain?: string
  isLocal?: boolean
}

interface SummarySegment {
  text: string
  channel: ActiveChannelEntry | null
  user: SummaryAuthor | null
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Authors from the digest posts, keyed by the names the model may echo. */
const summaryAuthorsByName = computed<Map<string, SummaryAuthor>>(() => {
  const byName = new Map<string, SummaryAuthor>()
  const posts = [...(digest.value?.trendingPosts || []), ...(digest.value?.followedPosts || [])]
  for (const post of posts) {
    const raw = (post as any).author
    if (!raw?.id) continue
    const author: SummaryAuthor = {
      id: raw.id,
      displayName: raw.display_name || raw.username || 'Unknown',
      username: raw.username,
      avatarUrl: raw.avatar_url,
      color: raw.color,
      domain: raw.domain,
      isLocal: raw.is_local,
    }
    const candidates = new Set<string>()
    if (raw.display_name) {
      candidates.add(String(raw.display_name))
      // The model often shortens "Malika (arc auntiefication)" to "Malika".
      const firstWord = String(raw.display_name).split(/[\s(]/)[0]
      if (firstWord.length >= 3) candidates.add(firstWord)
    }
    if (raw.username && String(raw.username).length >= 3) candidates.add(String(raw.username))
    for (const name of candidates) {
      const key = name.toLowerCase()
      if (!byName.has(key)) byName.set(key, author)
    }
  }
  return byName
})

/** Split plain text on known author names, producing user segments. */
const splitByAuthors = (text: string): SummarySegment[] => {
  const byName = summaryAuthorsByName.value
  if (!text || byName.size === 0) return text ? [{ text, channel: null, user: null }] : []

  const escaped = [...byName.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
  const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')

  const segments: SummarySegment[] = []
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > lastIndex) segments.push({ text: text.slice(lastIndex, index), channel: null, user: null })
    segments.push({ text: match[0], channel: null, user: byName.get(match[0].toLowerCase()) || null })
    lastIndex = index + match[0].length
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), channel: null, user: null })
  return segments
}

/**
 * The model writes channel and author names as plain prose. Split the
 * free-text summary against the known names from the digest that fed it:
 * channels render as clickable "#channel" pills, post authors as avatar +
 * profile-colored chips that open their profile.
 */
const summarySegments = computed<SummarySegment[]>(() => {
  const text = aiSummary.value
  if (!text) return []

  const channels = digest.value?.activeChannels || []
  if (channels.length === 0) return splitByAuthors(text)

  const byName = new Map<string, ActiveChannelEntry>()
  for (const c of channels) {
    if (!byName.has(c.channelName.toLowerCase())) byName.set(c.channelName.toLowerCase(), c)
  }

  const escaped = [...byName.keys()]
    .sort((a, b) => b.length - a.length) // longest first so e.g. "money" doesn't shadow "money-talk"
    .map(escapeRegExp)
  // Consume an optional leading "#" (with optional space, some models write
  // "# gaming"): the pill supplies its own "#", so leaving the model's in the
  // text produced "# #gaming".
  const pattern = new RegExp(`#\\s?(${escaped.join('|')})\\b|\\b(${escaped.join('|')})\\b`, 'gi')

  const segments: SummarySegment[] = []
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    const name = (match[1] || match[2] || '').toLowerCase()
    if (index > lastIndex) segments.push(...splitByAuthors(text.slice(lastIndex, index)))
    segments.push({ text: match[0], channel: byName.get(name) || null, user: null })
    lastIndex = index + match[0].length
  }
  if (lastIndex < text.length) segments.push(...splitByAuthors(text.slice(lastIndex)))

  return segments
})

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
  // Mentioned channels lead within each server group.
  for (const group of groups.values()) {
    group.channels.sort((a, b) =>
      b.unreadMentions - a.unreadMentions || b.unreadMessages - a.unreadMessages)
  }
  return [...groups.values()]
})

const AI_CACHE_KEY = 'today-ai-cache'
const AI_CACHE_MAX_AGE_MS = 12 * 3600_000
const AI_CACHE_VERSION = 2

interface AiCacheEntry {
  version: number
  signature: string
  summary: string | null
  highlights: ChannelHighlight[]
  at: number
}

const readAiCache = (): AiCacheEntry | null => {
  try {
    const raw = userStorage.getItem(AI_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AiCacheEntry
    return parsed.version === AI_CACHE_VERSION ? parsed : null
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
  const entry: AiCacheEntry = { version: AI_CACHE_VERSION, signature, summary: null, highlights: [], at: Date.now() }
  aiPending.value = true
  highlightsPending.value = true
  const summaryRun = todayDigestService.summarizeDigest(snapshot)
    .then(summary => {
      aiSummary.value = summary
      entry.summary = summary
      writeAiCache(entry)
    })
  const highlightsRun = todayDigestService.getChannelHighlights(snapshot.activeChannels)
    .then(result => {
      highlights.value = result
      entry.highlights = result
      writeAiCache(entry)
    })
    .finally(() => {
      highlightsPending.value = false
    })
  Promise.allSettled([summaryRun, highlightsRun]).then(() => {
    aiPending.value = false
  })
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

const showProfileModal = ref(false)
const profileModalUser = ref<any>(null)

const openUserProfile = (author: SummaryAuthor) => {
  profileModalUser.value = {
    id: author.id,
    username: author.username || author.displayName,
    display_name: author.displayName,
    avatar_url: author.avatarUrl,
    color: author.color,
    domain: author.domain,
    is_local: author.isLocal,
  }
  showProfileModal.value = true
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
  /* Clear the floating user-profile bar so the last card is fully reachable. */
  padding-bottom: 112px;
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

.today-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  color: var(--text-secondary);
}

.today-card-header h2 {
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

.inline-channel-pill {
  padding: 1px 8px;
  font: inherit;
  font-size: 0.93em;
  line-height: 1.3;
  vertical-align: baseline;
  margin: 0 1px;
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

.ai-pending {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 4px 0;
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
  /* Bleed the hover background into the card padding on both sides.
     width: 100% with a negative left margin left an 8px dead strip on the
     right; the width must grow by both margins. */
  width: calc(100% + 16px);
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

.row-stats {
  display: flex;
  align-items: center;
  gap: 10px;
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
    padding: 12px 12px 112px;
  }

  .today-card {
    padding: 14px 16px;
  }

  .card-hint {
    display: none;
  }
}

.user-chip {
  display: inline-flex;
  flex-direction: row-reverse;
  align-items: center;
  gap: 4px;
  padding: 0 2px;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  color: var(--harmony-primary);
  vertical-align: baseline;
}

.user-chip:hover .user-chip-name {
  text-decoration: underline;
}

.user-chip-avatar {
  flex-shrink: 0;
}

</style>