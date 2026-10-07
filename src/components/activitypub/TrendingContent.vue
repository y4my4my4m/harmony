<template>
  <div class="trending" data-testid="trending">
    <div class="trending-bar">
      <div class="trending-bar-inner feed-column">
        <div
          class="trending-tabs"
          role="tablist"
          :aria-label="t('activitypub.trendingSections')"
          @keydown="handleTabKeydown"
        >
          <button
            v-for="item in tabs"
            :id="`trending-tab-${item.id}`"
            :key="item.id"
            type="button"
            role="tab"
            class="trending-tab"
            :class="{ active: tab === item.id }"
            :aria-selected="tab === item.id"
            :aria-controls="`trending-panel-${item.id}`"
            :tabindex="tab === item.id ? 0 : -1"
            :data-testid="`trending-tab-${item.id}`"
            @click="selectTab(item.id)"
          >
            {{ item.label }}
          </button>
        </div>

        <!-- Horizontal scrolling on narrow screens; swipes here are not sidebar gestures. -->
        <div
          v-if="showRangeFilter || showSourceFilter || showMediaFilter"
          class="trending-filters"
          role="toolbar"
          :aria-label="t('activitypub.trendingFilters')"
          data-block-sidebar-gestures
        >
          <label
            v-if="showRangeFilter"
            class="chip chip-select"
            :class="{ 'is-active': timeRange !== DEFAULT_RANGE }"
          >
            <Icon name="clock" :size="14" class="chip-icon" />
            <span class="chip-label" aria-hidden="true">{{ rangeLabel(timeRange) }}</span>
            <Icon name="chevron-down" :size="14" class="chip-caret" />
            <select
              class="chip-native"
              :value="timeRange"
              :aria-label="t('activitypub.trendingTimeRange')"
              data-testid="trending-range"
              @change="setQuery({ range: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="range in TIME_RANGES" :key="range" :value="range">{{ rangeLabel(range) }}</option>
            </select>
          </label>

          <label
            v-if="showSourceFilter"
            class="chip chip-select"
            :class="{ 'is-active': source !== '' }"
          >
            <Icon name="globe" :size="14" class="chip-icon" />
            <span class="chip-label" aria-hidden="true">{{ sourceLabel }}</span>
            <Icon name="chevron-down" :size="14" class="chip-caret" />
            <select
              class="chip-native"
              :value="source"
              :aria-label="t('activitypub.trendingSource')"
              data-testid="trending-source"
              @change="setQuery({ source: ($event.target as HTMLSelectElement).value })"
            >
              <option value="">{{ t('activitypub.allInstances') }}</option>
              <option value="local">{{ t('activitypub.thisInstance') }}</option>
              <option v-for="domain in sourceDomains" :key="domain" :value="domain">{{ domain }}</option>
            </select>
          </label>

          <button
            v-if="showMediaFilter"
            type="button"
            class="chip"
            :class="{ 'is-active': mediaOnly }"
            :aria-pressed="mediaOnly"
            data-testid="trending-media"
            @click="setQuery({ media: mediaOnly ? '' : '1' })"
          >
            <Icon name="image" :size="14" class="chip-icon" />
            {{ t('activitypub.withMedia') }}
          </button>

          <button
            v-if="hasActiveFilters"
            type="button"
            class="chip-clear"
            data-testid="trending-clear"
            @click="clearFilters"
          >
            <Icon name="x" :size="14" />
            {{ t('activitypub.clearFilters') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Posts -->
    <div
      v-if="tab === 'posts'"
      id="trending-panel-posts"
      class="trending-panel"
      role="tabpanel"
      aria-labelledby="trending-tab-posts"
    >
      <PostsContainer
        :key="postsKey"
        :posts="visiblePosts"
        :register-scroll="registerPostsScroll"
        :is-loading="posts.loading"
        :has-more="posts.hasMore"
        :error="posts.error"
        :error-title="t('activitypub.trendingLoadFailed')"
        :loading-message="t('common.loading')"
        :empty-title="mediaOnly ? t('activitypub.trendingNoMedia') : t('activitypub.trendingNoPosts')"
        :empty-message="postsEmptyMessage"
        :empty-icon="mediaOnly ? 'image' : 'trending-up'"
        :empty-action="postsEmptyAction"
        @retry="loadPosts()"
        @load-more="loadMorePosts"
        @empty-action="handlePostsEmptyAction"
        @edit="handleEditPost"
        @user-click="openProfile"
        @hashtag-click="openHashtag"
        @show-conversation="openPost"
      />
    </div>

    <!-- Hashtags -->
    <div
      v-else-if="tab === 'hashtags'"
      id="trending-panel-hashtags"
      ref="hashtagsScroll"
      class="trending-panel trending-scroll"
      role="tabpanel"
      aria-labelledby="trending-tab-hashtags"
    >
      <div class="trending-column feed-column">
        <div
          v-if="hashtags.loading && hashtags.items.length === 0"
          class="skeleton-list"
          role="status"
          aria-busy="true"
          :aria-label="t('common.loading')"
        >
          <div v-for="n in 6" :key="n" class="skeleton-row" aria-hidden="true">
            <div class="skeleton-body">
              <div class="skeleton-line skeleton-line--name" />
              <div class="skeleton-line skeleton-line--short" />
            </div>
          </div>
        </div>

        <div v-else-if="hashtags.error" class="state" role="alert">
          <Icon name="alert-circle" :size="40" />
          <h3>{{ t('activitypub.trendingLoadFailed') }}</h3>
          <p>{{ t('activitypub.loadFailedMessage') }}</p>
          <button type="button" class="state-btn" @click="loadHashtags()">{{ t('common.retry') }}</button>
        </div>

        <div v-else-if="hashtags.items.length === 0" class="state">
          <Icon name="hash" :size="40" />
          <h3>{{ t('activitypub.noTrendingHashtags') }}</h3>
          <p>{{ timeRange === DEFAULT_RANGE ? t('activitypub.noTrendingHashtagsHint') : t('activitypub.trendingFilteredHint') }}</p>
          <button v-if="hasActiveFilters" type="button" class="state-btn" @click="clearFilters">
            {{ t('activitypub.clearFilters') }}
          </button>
        </div>

        <ol v-else class="tag-list" data-testid="trending-hashtags">
          <li v-for="(item, index) in hashtags.items" :key="item.tag">
            <button type="button" class="tag-row" @click="openHashtag(item.tag)">
              <span class="tag-rank">{{ index + 1 }}</span>
              <span class="tag-main">
                <span class="tag-name">#{{ item.tag }}</span>
                <span class="tag-meta">{{ hashtagMeta(item) }}</span>
              </span>
              <span v-if="item.trend === 'up'" class="tag-trend">
                <Icon name="trending-up" :size="14" />
                {{ t('activitypub.trendingRising') }}
              </span>
            </button>
          </li>
        </ol>
      </div>
    </div>

    <!-- People -->
    <div
      v-else
      id="trending-panel-people"
      ref="peopleScroll"
      class="trending-panel trending-scroll"
      role="tabpanel"
      aria-labelledby="trending-tab-people"
    >
      <div class="trending-column feed-column">
        <div
          v-if="people.loading && people.items.length === 0"
          class="skeleton-list"
          role="status"
          aria-busy="true"
          :aria-label="t('common.loading')"
        >
          <div v-for="n in 5" :key="n" class="skeleton-row" aria-hidden="true">
            <div class="skeleton-avatar" />
            <div class="skeleton-body">
              <div class="skeleton-line skeleton-line--name" />
              <div class="skeleton-line skeleton-line--mid" />
            </div>
          </div>
        </div>

        <div v-else-if="people.error && people.items.length === 0" class="state" role="alert">
          <Icon name="alert-circle" :size="40" />
          <h3>{{ t('activitypub.trendingLoadFailed') }}</h3>
          <p>{{ t('activitypub.loadFailedMessage') }}</p>
          <button type="button" class="state-btn" @click="loadPeople()">{{ t('common.retry') }}</button>
        </div>

        <div v-else-if="visiblePeople.length === 0 && !people.hasMore" class="state">
          <Icon name="users" :size="40" />
          <h3>{{ t('activitypub.trendingNoPeople') }}</h3>
          <p>{{ source === '' ? t('activitypub.trendingNoPeopleHint') : t('activitypub.trendingFilteredHint') }}</p>
          <button v-if="hasActiveFilters" type="button" class="state-btn" @click="clearFilters">
            {{ t('activitypub.clearFilters') }}
          </button>
        </div>

        <template v-else>
          <div class="people-list" data-testid="trending-people">
            <ProfileCard
              v-for="user in visiblePeople"
              :key="user.id"
              :user="user"
              :show-follow-btn="true"
              :max-bio-length="140"
              class="people-card"
              @click="openProfile(user)"
            />
          </div>
          <div v-if="people.hasMore || people.error" class="list-footer">
            <span v-if="people.error" class="list-footer-error">{{ t('activitypub.loadMoreFailed') }}</span>
            <button
              type="button"
              class="footer-btn"
              :disabled="people.loading"
              @click="loadMorePeople"
            >
              <LoadingSpinner v-if="people.loading" :size="14" :thickness="2" />
              {{ people.error ? t('common.retry') : t('activitypub.showMore') }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <Composer
      v-if="editingPost"
      mode="modal"
      type="edit"
      :edit-post="editingPost"
      :is-open="!!editingPost"
      @close="editingPost = null"
      @edited="handleEdited"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { debug } from '@/utils/debug'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import {
  trendingService,
  TRENDING_TIME_RANGE_HOURS,
  type TrendingCursor,
  type TrendingHashtag,
  type TrendingTimeRange,
} from '@/services/TrendingService'
import PostsContainer from '@/components/common/PostsContainer.vue'
import ProfileCard from '@/components/common/ProfileCard.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import Composer from './Composer.vue'
import type { TimelinePost, FederatedUser } from '@/types'
import { runtimeConfig } from '@/services/runtimeConfig'

type TrendingTab = 'posts' | 'hashtags' | 'people'

const TAB_IDS: readonly TrendingTab[] = ['posts', 'hashtags', 'people']
const TIME_RANGES = Object.keys(TRENDING_TIME_RANGE_HOURS) as TrendingTimeRange[]
const DEFAULT_RANGE: TrendingTimeRange = '24h'
const POSTS_PAGE = 20
// Pages fetched in a row when hidden authors and repeats leave a page with nothing new.
const POSTS_EMPTY_PAGE_LIMIT = 5
const HASHTAG_LIMIT = 30
const PEOPLE_PAGE = 20

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const activityPubStore = useActivityPubStore()
const instanceSettings = useInstanceSettingsStore()

// Tab and filters live in the query string: ?tab=&range=&media=1&source=local|<domain>.
const queryString = (key: string): string => {
  const value = route.query[key]
  return typeof value === 'string' ? value : ''
}

const tab = computed<TrendingTab>(() => {
  const value = queryString('tab') as TrendingTab
  return TAB_IDS.includes(value) ? value : 'posts'
})
const timeRange = computed<TrendingTimeRange>(() => {
  const value = queryString('range') as TrendingTimeRange
  return TIME_RANGES.includes(value) ? value : DEFAULT_RANGE
})
const mediaOnly = computed(() => queryString('media') === '1')
const federationEnabled = computed(() => instanceSettings.isFederationEnabled)
const source = computed(() => (federationEnabled.value ? queryString('source').trim().toLowerCase() : ''))

const tabs = computed(() => [
  { id: 'posts' as const, label: t('activitypub.posts') },
  { id: 'hashtags' as const, label: t('activitypub.trendingHashtagsTab') },
  { id: 'people' as const, label: t('activitypub.trendingPeopleTab') },
])

const showRangeFilter = computed(() => tab.value !== 'people')
const showSourceFilter = computed(() => federationEnabled.value && tab.value !== 'hashtags')
const showMediaFilter = computed(() => tab.value === 'posts')

const hasActiveFilters = computed(() =>
  (showRangeFilter.value && timeRange.value !== DEFAULT_RANGE)
  || (showSourceFilter.value && source.value !== '')
  || (showMediaFilter.value && mediaOnly.value)
)

/**
 * Empty strings drop the key; defaults stay out of the URL. Tab changes are history
 * entries, so Back returns to the previous tab; filter changes replace the entry.
 */
const setQuery = (patch: Record<string, string>, mode: 'push' | 'replace' = 'replace') => {
  const query = { ...route.query }
  for (const [key, value] of Object.entries(patch)) {
    const isDefault = value === '' || (key === 'range' && value === DEFAULT_RANGE) || (key === 'tab' && value === 'posts')
    if (isDefault) delete query[key]
    else query[key] = value
  }
  if (mode === 'push') router.push({ query })
  else router.replace({ query })
}

const clearFilters = () => {
  const patch: Record<string, string> = {}
  if (showRangeFilter.value) patch.range = ''
  if (showSourceFilter.value) patch.source = ''
  if (showMediaFilter.value) patch.media = ''
  setQuery(patch)
}

const selectTab = (id: TrendingTab) => {
  if (id === tab.value) {
    refresh()
    return
  }
  setQuery({ tab: id }, 'push')
}

// Roving focus across the tablist (WAI-ARIA tabs pattern, manual activation).
const handleTabKeydown = (event: KeyboardEvent) => {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const list = event.currentTarget as HTMLElement
  const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (index === -1) return
  event.preventDefault()
  let next = index
  if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length
  if (event.key === 'ArrowRight') next = (index + 1) % buttons.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = buttons.length - 1
  buttons[next]?.focus()
}

const sourceLabel = computed(() => {
  if (source.value === '') return t('activitypub.allInstances')
  if (source.value === 'local') return t('activitypub.thisInstance')
  return source.value
})

const rangeLabel = (range: TrendingTimeRange): string => {
  switch (range) {
    case '1h': return t('activitypub.lastHour')
    case '6h': return t('activitypub.last6Hours')
    case '7d': return t('activitypub.lastWeek')
    case '30d': return t('activitypub.lastMonth')
    default: return t('activitypub.last24Hours')
  }
}

// Sources ---------------------------------------------------------------------------------
const knownDomains = ref<string[]>([])

const sourceDomains = computed(() => {
  const local = runtimeConfig.domain?.toLowerCase()
  const set = new Set(knownDomains.value.filter(d => d && d !== local))
  if (source.value && source.value !== 'local') set.add(source.value)
  return Array.from(set).sort((a, b) => a.localeCompare(b))
})

const loadKnownDomains = async () => {
  if (!federationEnabled.value || knownDomains.value.length > 0) return
  try {
    const instances = await trendingService.getFederatedInstances({ limit: 100, filter: 'active' })
    knownDomains.value = instances.map(i => String(i.domain || '').toLowerCase()).filter(Boolean)
  } catch (error) {
    debug.warn('Failed to load instance domains for the trending source filter:', error)
  }
}

const isHidden = (id: string | undefined): boolean =>
  !!id && (activityPubStore.mutedUsers.has(id) || activityPubStore.blockedUsers.has(id))

// Posts -----------------------------------------------------------------------------------
const postsKey = computed(() => `${timeRange.value}|${mediaOnly.value ? 1 : 0}|${source.value}`)

const posts = reactive({
  /** Filter key of the loaded rows; null until the first load. */
  key: null as string | null,
  items: [] as TimelinePost[],
  asOf: null as string | null,
  /** Last row received; the next page starts after it. */
  cursor: null as TrendingCursor | null,
  hasMore: false,
  loading: false,
  error: null as string | null,
  request: 0,
})

const visiblePosts = computed(() =>
  posts.items.filter(p => !isHidden(p.author_id || p.author?.id))
)

const postsQuery = () => ({
  timeRange: timeRange.value,
  mediaOnly: mediaOnly.value,
  localOnly: source.value === 'local',
  domain: source.value && source.value !== 'local' ? source.value : null,
  limit: POSTS_PAGE,
})

let postsScrollEl: HTMLElement | null = null
const registerPostsScroll = (el: HTMLElement | null) => {
  postsScrollEl = el
}

/**
 * Appends pages after the cursor until one adds a post the viewer can see, so a page
 * made only of muted or blocked authors, or of repeats, does not stall the list.
 * Returns false when a newer load superseded this one.
 */
const appendPages = async (request: number): Promise<boolean> => {
  for (let i = 0; i < POSTS_EMPTY_PAGE_LIMIT && posts.hasMore; i++) {
    const page = await trendingService.getTrendingPosts({
      ...postsQuery(),
      asOf: posts.asOf,
      after: posts.cursor,
    })
    if (request !== posts.request) return false
    // Counts move between pages; a post can rank into a page it already appeared on.
    const seen = new Set(posts.items.map(p => p.id))
    const fresh = page.posts.filter(p => !seen.has(p.id))
    posts.items = [...posts.items, ...fresh]
    activityPubStore.enrichFeedPosts(fresh)
    posts.cursor = page.cursor ?? posts.cursor
    posts.hasMore = page.hasMore
    if (fresh.some(p => !isHidden(p.author_id || p.author?.id))) break
  }
  return true
}

const loadPosts = async () => {
  const request = ++posts.request
  posts.key = postsKey.value
  posts.items = []
  posts.asOf = null
  posts.cursor = null
  posts.hasMore = false
  posts.error = null
  posts.loading = true
  try {
    const page = await trendingService.getTrendingPosts(postsQuery())
    if (request !== posts.request) return
    posts.items = page.posts
    activityPubStore.enrichFeedPosts(page.posts)
    posts.asOf = page.asOf
    posts.cursor = page.cursor
    posts.hasMore = page.hasMore
    if (visiblePosts.value.length === 0 && posts.hasMore && !(await appendPages(request))) return
  } catch (error) {
    if (request !== posts.request) return
    posts.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (request === posts.request) posts.loading = false
  }
}

const loadMorePosts = async () => {
  if (posts.loading || !posts.hasMore) return
  const request = posts.request
  posts.loading = true
  try {
    await appendPages(request)
  } catch (error) {
    debug.error('Failed to load more trending posts:', error)
  } finally {
    if (request === posts.request) posts.loading = false
  }
}

const postsEmptyMessage = computed(() => {
  if (hasActiveFilters.value) return t('activitypub.trendingFilteredHint')
  return mediaOnly.value ? t('activitypub.trendingNoMediaHint') : t('activitypub.trendingNoPostsHint')
})

const postsEmptyAction = computed(() => {
  if (hasActiveFilters.value) return t('activitypub.clearFilters')
  return federationEnabled.value ? t('activitypub.browseFederatedTimeline') : t('activitypub.browseTimeline')
})

const handlePostsEmptyAction = () => {
  if (hasActiveFilters.value) {
    clearFilters()
    return
  }
  router.push({ name: 'Social', params: { timeline: federationEnabled.value ? 'public' : 'local' } })
}

// Own deletes go through the store; the trending list keeps its own copy.
activityPubStore.$onAction(({ name, args, after }) => {
  if (name !== 'deletePost') return
  const postId = args[0] as string
  after(() => {
    posts.items = posts.items.filter(p => p.id !== postId)
  })
})

const editingPost = ref<TimelinePost | null>(null)

const handleEditPost = (postId: string) => {
  editingPost.value = posts.items.find(p => p.id === postId) ?? null
}

const handleEdited = (edited: TimelinePost | null) => {
  if (edited?.id) {
    posts.items = posts.items.map(p => (p.id === edited.id ? { ...p, ...edited, author: p.author } : p))
  }
  editingPost.value = null
}

// Hashtags --------------------------------------------------------------------------------
const hashtagsKey = computed(() => timeRange.value)
const hashtagsScroll = ref<HTMLElement | null>(null)

const hashtags = reactive({
  /** Filter key of the loaded rows; null until the first load. */
  key: null as string | null,
  items: [] as TrendingHashtag[],
  loading: false,
  error: null as string | null,
  request: 0,
})

const loadHashtags = async () => {
  const request = ++hashtags.request
  hashtags.key = hashtagsKey.value
  hashtags.items = []
  hashtags.error = null
  hashtags.loading = true
  try {
    const items = await trendingService.getTrendingHashtags({
      limit: HASHTAG_LIMIT,
      hours: TRENDING_TIME_RANGE_HOURS[timeRange.value],
    })
    if (request !== hashtags.request) return
    hashtags.items = items
  } catch (error) {
    if (request !== hashtags.request) return
    hashtags.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (request === hashtags.request) hashtags.loading = false
  }
}

const hashtagMeta = (item: TrendingHashtag): string => {
  const parts = [t('activitypub.postsCountLabel', { count: formatNumber(item.daily_uses) }, item.daily_uses)]
  if (item.unique_users > 0) {
    parts.push(t('activitypub.hashtagPeopleCount', { count: formatNumber(item.unique_users) }, item.unique_users))
  }
  return parts.join(' · ')
}

// People ----------------------------------------------------------------------------------
const peopleKey = computed(() => source.value)
const peopleScroll = ref<HTMLElement | null>(null)

const people = reactive({
  /** Filter key of the loaded rows; null until the first load. */
  key: null as string | null,
  items: [] as FederatedUser[],
  hasMore: false,
  loading: false,
  error: null as string | null,
  request: 0,
})

const visiblePeople = computed(() => people.items.filter(u => !isHidden(u.id)))

const peopleQuery = () => ({
  limit: PEOPLE_PAGE,
  instance: source.value && source.value !== 'local' ? source.value : undefined,
  includeLocal: true,
  includeFederated: source.value !== 'local',
})

const loadPeople = async () => {
  const request = ++people.request
  people.key = peopleKey.value
  people.items = []
  people.hasMore = false
  people.error = null
  people.loading = true
  try {
    const rows = await trendingService.getTrendingUsers({ ...peopleQuery(), offset: 0 })
    if (request !== people.request) return
    people.items = rows.map(r => r.user)
    people.hasMore = rows.length === PEOPLE_PAGE
  } catch (error) {
    if (request !== people.request) return
    people.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (request === people.request) people.loading = false
  }
}

const loadMorePeople = async () => {
  if (people.loading) return
  const request = people.request
  people.loading = true
  people.error = null
  try {
    const rows = await trendingService.getTrendingUsers({ ...peopleQuery(), offset: people.items.length })
    if (request !== people.request) return
    const seen = new Set(people.items.map(u => u.id))
    people.items = [...people.items, ...rows.map(r => r.user).filter(u => !seen.has(u.id))]
    people.hasMore = rows.length === PEOPLE_PAGE
  } catch (error) {
    if (request !== people.request) return
    people.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (request === people.request) people.loading = false
  }
}

// Loading ---------------------------------------------------------------------------------
const ensureLoaded = () => {
  if (tab.value === 'posts' && posts.key !== postsKey.value) void loadPosts()
  if (tab.value === 'hashtags' && hashtags.key !== hashtagsKey.value) void loadHashtags()
  if (tab.value === 'people' && people.key !== peopleKey.value) void loadPeople()
}

watch([tab, postsKey, hashtagsKey, peopleKey], ensureLoaded)

/** Reloads the visible tab from the top. */
const refresh = () => {
  if (tab.value === 'posts') {
    postsScrollEl?.scrollTo({ top: 0 })
    void loadPosts()
  } else if (tab.value === 'hashtags') {
    hashtagsScroll.value?.scrollTo({ top: 0 })
    void loadHashtags()
  } else {
    peopleScroll.value?.scrollTo({ top: 0 })
    void loadPeople()
  }
}

onMounted(() => {
  ensureLoaded()
  void loadKnownDomains()
})

watch(federationEnabled, () => void loadKnownDomains())

// Navigation ------------------------------------------------------------------------------
const openHashtag = (tag: string) => {
  router.push({ name: 'HashtagView', params: { tag } })
}

const openPost = (postId: string) => {
  router.push({ name: 'PostDetail', params: { postId } })
}

const openProfile = (user: any) => {
  if (!user?.username) return
  const handle = user.is_local ? `@${user.username}` : `@${user.username}@${user.domain}`
  router.push({ name: 'UserProfile', params: { handle } })
}

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

defineExpose({ refresh })
</script>

<style scoped>
.trending {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--background-primary);
}

/* Scroll container with a stable gutter, like the feed scroller below it: both centre
   the feed column on the same axis, so the side rules meet. */
.trending-bar {
  flex-shrink: 0;
  overflow: hidden;
  scrollbar-gutter: stable;
  background: var(--background-primary);
}

.trending-bar-inner {
  border-bottom: 1px solid var(--border-color);
}

.trending-tabs {
  display: flex;
  height: 44px;
}

.trending-tab {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  padding: 0 var(--space-3);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.trending-tab:hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.trending-tab.active {
  color: var(--text-primary);
}

.trending-tab.active::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 56px;
  max-width: calc(100% - var(--space-6));
  height: 3px;
  transform: translateX(-50%);
  border-radius: 3px 3px 0 0;
  background: var(--harmony-primary);
}

.trending-tab:focus-visible,
.chip:focus-within,
.chip-clear:focus-visible,
.tag-row:focus-visible,
.state-btn:focus-visible,
.footer-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}

/* Inline padding matches MonyPost's .post-content, so chips align with post text. */
.trending-filters {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4) var(--space-3);
  overflow-x: auto;
  scrollbar-width: none;
}

.trending-filters::-webkit-scrollbar {
  display: none;
}

.chip {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 30px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast), border-color var(--transition-fast);
}

.chip:hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.chip.is-active {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-alpha-light, var(--harmony-primary-light));
  color: var(--text-primary);
}

.chip.is-active .chip-icon {
  color: var(--harmony-primary);
}

.chip-select {
  padding-right: var(--space-2);
}

.chip-label {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The native select covers the chip transparently: the whole pill opens the menu, and
   the chip is as wide as the visible label rather than the longest option. */
.chip-native {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: none;
  opacity: 0;
  font: inherit;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
}

.chip-native option {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.chip-caret {
  pointer-events: none;
  flex-shrink: 0;
}

.chip-clear {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 30px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--harmony-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.chip-clear:hover {
  background: var(--background-modifier-hover);
}

.trending-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.trending-scroll {
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.trending-column {
  min-height: 100%;
}

/* Hashtags */
.tag-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tag-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: none;
  border-bottom: 1px solid var(--border-color);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.tag-row:hover {
  background: var(--background-modifier-hover);
}

.tag-rank {
  width: 24px;
  flex-shrink: 0;
  color: var(--text-muted, var(--text-secondary));
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.tag-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.tag-name {
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-meta {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.tag-trend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  color: var(--success);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

/* People */
.people-list {
  display: flex;
  flex-direction: column;
}

.people-card {
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-top: none;
  border-bottom: 1px solid var(--border-color);
}

.list-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-4);
}

.list-footer-error {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.footer-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.footer-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
}

.footer-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Loading, empty and error states, matching PostsContainer. */
.skeleton-row {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-color);
}

.skeleton-avatar {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--background-modifier-hover);
}

.skeleton-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-1);
}

.skeleton-line {
  height: 10px;
  border-radius: var(--radius-sm);
  background: var(--background-modifier-hover);
}

.skeleton-line--name { width: 35%; }
.skeleton-line--mid { width: 70%; }
.skeleton-line--short { width: 22%; }

.skeleton-avatar,
.skeleton-line {
  animation: skeleton-fade 1.4s ease-in-out infinite;
}

@keyframes skeleton-fade {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-avatar,
  .skeleton-line {
    animation: none;
  }
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 320px;
  padding: var(--space-16) var(--space-4);
  color: var(--text-secondary);
  text-align: center;
}

.state h3 {
  margin: var(--space-2) 0 0;
  color: var(--text-primary);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.state p {
  max-width: 320px;
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-relaxed, 1.5);
}

.state-btn {
  padding: var(--space-2) var(--space-5);
  border: none;
  border-radius: var(--radius-full);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.state-btn:hover {
  background: var(--harmony-primary-hover);
}

@media (max-width: 768px) {
  .trending-filters,
  .tag-row {
    padding-left: var(--space-3);
    padding-right: var(--space-3);
  }
}
</style>
