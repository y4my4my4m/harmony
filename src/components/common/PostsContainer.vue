<template>
  <div class="posts-container" ref="scrollContainer">
    <!-- Loading State -->
    <div
      v-if="isLoading && posts.length === 0"
      class="skeleton-list feed-column"
      role="status"
      aria-busy="true"
      :aria-label="loadingMessage || t('common.loading')"
    >
      <div v-for="n in skeletonCount" :key="n" class="skeleton-row" aria-hidden="true">
        <div class="skeleton-avatar" />
        <div class="skeleton-body">
          <div class="skeleton-line skeleton-line--name" />
          <div class="skeleton-line" />
          <div class="skeleton-line" :class="n % 2 ? 'skeleton-line--short' : 'skeleton-line--mid'" />
        </div>
      </div>
    </div>

    <!-- Error State -->
    <EmptyState
      v-else-if="error && posts.length === 0"
      tone="error"
      class="feed-column"
      icon="alert-circle"
      :title="errorTitle || t('activitypub.loadFailedTitle')"
      :description="t('activitypub.loadFailedMessage')"
      :action-label="t('common.retry')"
      @action="$emit('retry')"
    />

    <!-- Empty State -->
    <EmptyState
      v-else-if="!isLoading && posts.length === 0"
      class="feed-column"
      :icon="emptyIcon"
      :title="emptyTitle ?? t('empty.posts.title')"
      :description="emptyMessage ?? t('empty.posts.description')"
      :action-label="emptyAction"
      @action="$emit('empty-action')"
    />

    <!-- Virtualized posts in a role="feed" (WAI-ARIA feed pattern): articles carry
         aria-posinset/aria-setsize, PageDown/PageUp (and j/k outside text fields)
         move between them, Ctrl+End/Ctrl+Home leave the feed. The article holding
         focus stays rendered while scrolled out of the window. -->
    <template v-else>
      <div
        ref="feedEl"
        class="posts-list feed-column"
        role="feed"
        :aria-label="feedLabel || t('activitypub.feedA11y.label')"
        :aria-busy="isLoading ? 'true' : 'false'"
        :style="{ height: `${totalSize}px`, position: 'relative' }"
        @keydown="onFeedKeydown"
        @focusin="onFeedFocusIn"
        @focusout="onFeedFocusOut"
      >
        <div
          v-for="virtualRow in virtualRows"
          :key="posts[virtualRow.index]?.id ?? virtualRow.index"
          :data-index="virtualRow.index"
          :data-post-id="posts[virtualRow.index]?.id"
          :ref="measureElement"
          class="virtual-post-row"
          :style="{
            position: 'absolute',
            top: `${virtualRow.start - scrollMargin}px`,
            left: 0,
            width: '100%',
          }"
        >
          <MonyPost
            v-if="posts[virtualRow.index]"
            :post="posts[virtualRow.index]"
            v-bind="postProps"
            :posinset="virtualRow.index + 1"
            :setsize="hasMore ? -1 : posts.length"
            @reply="$emit('reply', $event)"
            @favorite="$emit('favorite', posts[virtualRow.index])"
            @reblog="$emit('reblog', posts[virtualRow.index])"
            @bookmark="$emit('bookmark', posts[virtualRow.index])"
            @delete="$emit('delete', posts[virtualRow.index])"
            @edit="$emit('edit', $event)"
            @user-click="$emit('user-click', $event)"
            @hashtag-click="$emit('hashtag-click', $event)"
            @show-conversation="$emit('show-conversation', $event)"
          />
        </div>
      </div>

      <!-- Outside the feed: a feed owns articles only. -->
      <div v-if="hasMore || loadMoreFailed" class="loading-more feed-column" data-testid="feed-footer">
        <template v-if="loadMoreFailed">
          <span>{{ t('activitypub.loadMoreFailed') }}</span>
          <button type="button" class="retry-btn" @click="retryLoadMore">{{ t('common.retry') }}</button>
        </template>
        <button
          v-else
          ref="loadMoreBtn"
          type="button"
          class="retry-btn load-more-btn"
          data-testid="feed-load-more"
          :aria-disabled="isLoading ? 'true' : undefined"
          @click="onLoadMoreClick"
        >
          <LoadingSpinner v-if="isLoading" :size="16" :thickness="2" />
          <span>{{ isLoading ? t('activitypub.loadingMore') : t('activitypub.loadMoreMonies') }}</span>
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, onMounted, onUnmounted, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/vue-virtual'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { tabbables } from '@/utils/a11y/focus'
import MonyPost from '@/components/activitypub/MonyPost.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import type { TimelinePost } from '@/types'
import type { FeedScrollAnchor } from '@/stores/useActivityPub'

interface Props {
  posts: TimelinePost[]
  isLoading?: boolean
  hasMore?: boolean
  loadingMessage?: string
  emptyTitle?: string
  emptyMessage?: string
  emptyIcon?: string
  emptyAction?: string
  postProps?: Record<string, any>
  registerScroll?: (el: HTMLElement | null) => void
  /** First-page load failure; replaces the empty state with a retry prompt. */
  error?: string | null
  errorTitle?: string
  skeletonCount?: number
  /** Accessible name of the feed ("Local timeline"). */
  feedLabel?: string
  /**
   * Scroller of the page around the feed, where the feed does not scroll itself (a profile).
   * Rows are windowed against it.
   */
  scrollRoot?: HTMLElement | null
}

const props = withDefaults(defineProps<Props>(), {
  posts: () => [],
  isLoading: false,
  hasMore: false,
  loadingMessage: undefined,
  emptyTitle: undefined,
  emptyMessage: undefined,
  emptyIcon: 'users',
  emptyAction: undefined,
  postProps: () => ({}),
  registerScroll: undefined,
  error: null,
  errorTitle: undefined,
  skeletonCount: 5,
  feedLabel: undefined,
  scrollRoot: null
})

const { t } = useI18n()
const { polite } = useAnnouncer()

const emit = defineEmits<{
  'load-more': []
  'empty-action': []
  'retry': []
  'reply': [post: any]
  // favorite/reblog/bookmark/delete are pass-through chains. MonyPost
  // handles those interactions internally via usePostInteractions and only
  // emits `delete`/`edit` upward via the post id; the entire favorite/
  // reblog/bookmark chain is currently dead. The upstream feed views
  // (TimelineView, BookmarksView, etc.) still declare handlers shaped
  // `(post: TimelinePost) => Promise<void>` for their re-emit semantics,
  // so declare the post payload here to keep the type chain coherent
  // (and to avoid TS2322 contravariance breaks at every listener site).
  'favorite': [post: TimelinePost]
  'reblog': [post: TimelinePost]
  'bookmark': [post: TimelinePost]
  'delete': [post: TimelinePost]
  'edit': [postId: string]
  'user-click': [user: any]
  'hashtag-click': [tag: string]
  'show-conversation': [postId: string]
  // Fired whenever the set of *rendered* post ids changes. The virtualizer
  // already renders only what's near the viewport (plus 8 rows of overscan),
  // so this is a reasonable "in view" signal without a second
  // IntersectionObserver chain. Consumers (e.g. MentionsView) use this to
  // clear notifications as the user scrolls posts into view.
  'posts-visible': [postIds: string[]]
}>()

const scrollContainer = ref<HTMLDivElement | null>(null)
const feedEl = ref<HTMLElement | null>(null)
const loadMoreBtn = ref<HTMLButtonElement | null>(null)
const observedElements = new Set<HTMLElement>()

// Post whose article holds focus; rangeExtractor keeps its row rendered so focus
// is not dropped to <body> when the row scrolls out of the window. Kept by id:
// realtime prepends shift indexes.
let focusedPostId: string | null = null

const keepFocusedRow = (range: Range): number[] => {
  const indexes = defaultRangeExtractor(range)
  if (!focusedPostId) return indexes
  const focused = props.posts.findIndex((p) => p.id === focusedPostId)
  if (focused < 0 || indexes.includes(focused)) return indexes
  return [...indexes, focused].sort((a, b) => a - b)
}

const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const el = entry.target as HTMLElement
    if (el.dataset.index !== undefined) {
      rowVirtualizer.value.measureElement(el)
    }
  }
})

const estimatePostSize = (index: number): number => {
  if (index >= props.posts.length) return 60
  const post = props.posts[index]
  if (!post) return 200

  let estimate = 80 // header + actions baseline

  const content = post.content
  if (Array.isArray(content)) {
    // `text` only exists on text-typed parts; narrow via `any` so the union
    // member access stays loose for length estimation.
    const textLength = content.reduce((sum: number, part: any) => sum + (part?.text?.length || 0), 0)
    estimate += Math.min(textLength * 0.4, 400)
  }

  if (post.media_attachments?.length) {
    estimate += post.media_attachments.length > 1 ? 320 : 280
  }

  if (post.reblog) estimate += 120

  if (post.content_warning || post.is_sensitive) estimate += 40

  return Math.max(estimate, 120)
}

/** The element that scrolls the feed: scrollRoot, else the container itself. */
const scroller = (): HTMLElement | null => props.scrollRoot ?? scrollContainer.value

// Offset of the feed list in scrollRoot's content, px; 0 when the container scrolls. Row
// starts include it (virtual-core scrollMargin).
const scrollMargin = ref(0)

const measureScrollMargin = () => {
  const root = props.scrollRoot
  const feed = feedEl.value
  const next = root && feed
    ? Math.round(feed.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop)
    : 0
  if (next !== scrollMargin.value) scrollMargin.value = next
}

// Content above the feed (a profile header, a banner loading) moves the list in the scroller.
watch(
  () => [props.scrollRoot, feedEl.value] as const,
  ([root, feed], _previous, onCleanup) => {
    measureScrollMargin()
    if (!root || !feed) return
    const observer = new ResizeObserver(measureScrollMargin)
    for (const child of Array.from(root.children)) observer.observe(child)
    onCleanup(() => observer.disconnect())
  },
  { flush: 'post', immediate: true },
)

const rowVirtualizer = useVirtualizer<HTMLElement, Element>(
  computed(() => ({
    count: props.posts.length,
    getScrollElement: props.scrollRoot ? () => props.scrollRoot ?? null : () => scrollContainer.value,
    scrollMargin: scrollMargin.value,
    estimateSize: estimatePostSize,
    // Measurements follow the post, not the index, across realtime prepends.
    getItemKey: (index: number) => props.posts[index]?.id ?? index,
    overscan: 8,
    rangeExtractor: keepFocusedRow,
  })) as any
)

const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems())
const totalSize = computed(() => rowVirtualizer.value.getTotalSize())

const measureElement = (el: any) => {
  if (!el || !(el instanceof HTMLElement)) return
  rowVirtualizer.value.measureElement(el)
  if (!observedElements.has(el)) {
    resizeObserver.observe(el)
    observedElements.add(el)
  }
}

const lastEmittedIndex = ref(-1)
const loadMoreFailed = ref(false)
// A load started from the Load more button moves focus to its first new post.
let focusNewPosts = false

// `load-more` handlers report failure only by settling with no new posts;
// `hasMore` stays set. Without an explicit failed state the tail index latch
// never reopens, since the last row is always the highest index.
let attemptActive = false
let attemptTimer: ReturnType<typeof setTimeout> | null = null
// Covers handlers that never flip `isLoading`, leaving no edge to settle on.
const ATTEMPT_TIMEOUT_MS = 8000

const clearAttemptTimer = () => {
  if (attemptTimer !== null) {
    clearTimeout(attemptTimer)
    attemptTimer = null
  }
}

const failAttempt = () => {
  clearAttemptTimer()
  attemptActive = false
  focusNewPosts = false
  loadMoreFailed.value = true
}

const retryLoadMore = () => {
  loadMoreFailed.value = false
  lastEmittedIndex.value = -1
}

const startAttempt = () => {
  attemptActive = true
  clearAttemptTimer()
  attemptTimer = setTimeout(() => {
    attemptTimer = null
    if (props.isLoading) return
    failAttempt()
  }, ATTEMPT_TIMEOUT_MS)
  emit('load-more')
}

const onLoadMoreClick = () => {
  focusNewPosts = true
  if (props.isLoading || attemptActive) return
  lastEmittedIndex.value = props.posts.length - 1
  startAttempt()
}

// Runs before the render that may unmount the footer, so a focused Load more
// button is still detectable; its focus moves to the first new post.
watch(() => props.posts.length, (length, previous) => {
  const loaded = attemptActive && length > previous ? length - previous : 0
  const fromButton = focusNewPosts || (!!loadMoreBtn.value && document.activeElement === loadMoreBtn.value)
  clearAttemptTimer()
  attemptActive = false
  loadMoreFailed.value = false
  lastEmittedIndex.value = -1
  if (loaded > 0) {
    polite(t('activitypub.feedA11y.postsLoaded', { count: loaded }, loaded), { key: 'feed-loaded' })
    if (fromButton) void focusPost(previous)
  }
  focusNewPosts = false
})

watch(() => props.isLoading, (loading) => {
  if (!attemptActive) return
  if (loading) {
    clearAttemptTimer()
    return
  }
  failAttempt()
})

// The next page loads once the reader has scrolled the feed and its last row is in the
// window; Load more asks for it at any time. A list whose end shows on open (a remote account
// with few stored posts) waits for one or the other.
watchEffect(() => {
  const items = virtualRows.value
  const lastItem = items[items.length - 1]
  if (!lastItem) return

  if (
    (rowVirtualizer.value.scrollOffset ?? 0) > 0 &&
    lastItem.index >= props.posts.length - 1 &&
    props.hasMore &&
    !props.isLoading &&
    !attemptActive &&
    !loadMoreFailed.value &&
    lastItem.index !== lastEmittedIndex.value
  ) {
    lastEmittedIndex.value = lastItem.index
    startAttempt()
  }
})

const articleAt = (index: number) =>
  feedEl.value?.querySelector<HTMLElement>(`article[aria-posinset="${index + 1}"]`) ?? null

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** Moves focus to the post at `index`, scrolling its row into the window first. */
const focusPost = async (index: number): Promise<boolean> => {
  if (index < 0 || index >= props.posts.length) return false
  await nextTick()
  let el = articleAt(index)
  if (!el) {
    rowVirtualizer.value.scrollToIndex(index, { align: 'start' })
    for (let attempt = 0; attempt < 6 && !el; attempt++) {
      await nextFrame()
      el = articleAt(index)
    }
  }
  if (!el) return false
  focusedPostId = props.posts[index]?.id ?? null
  el.focus({ preventScroll: true })
  const box = scroller()?.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  if (box && (rect.top < box.top || rect.top > box.bottom - 48)) el.scrollIntoView({ block: 'start' })
  return document.activeElement === el
}

/** First tabbable element after (or last before) the feed, for Ctrl+End / Ctrl+Home. */
const focusBeyondFeed = (after: boolean) => {
  const feed = feedEl.value
  if (!feed) return
  const outside = tabbables(document.body).filter((el) => {
    if (feed.contains(el)) return false
    const position = feed.compareDocumentPosition(el)
    return after ? !!(position & Node.DOCUMENT_POSITION_FOLLOWING) : !!(position & Node.DOCUMENT_POSITION_PRECEDING)
  })
  const target = after ? outside[0] : outside[outside.length - 1]
  target?.focus()
}

const isTextEntry = (el: HTMLElement) => el.isContentEditable || el.matches('input, textarea, select')

const onFeedKeydown = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.altKey || event.metaKey) return
  const target = event.target as HTMLElement
  const article = target.closest<HTMLElement>('article[aria-posinset]')
  if (!article || !feedEl.value?.contains(article)) return
  const index = Number(article.getAttribute('aria-posinset')) - 1
  if (Number.isNaN(index)) return
  const typing = isTextEntry(target)

  let step = 0
  if ((event.key === 'PageDown' || event.key === 'PageUp') && !event.ctrlKey && !event.shiftKey && !typing) {
    step = event.key === 'PageDown' ? 1 : -1
  } else if ((event.key === 'j' || event.key === 'k') && !event.ctrlKey && !event.shiftKey && !typing) {
    step = event.key === 'j' ? 1 : -1
  } else if ((event.key === 'End' || event.key === 'Home') && event.ctrlKey && !typing) {
    event.preventDefault()
    focusBeyondFeed(event.key === 'End')
    return
  }
  if (step === 0) return
  event.preventDefault()
  const next = index + step
  if (next >= props.posts.length) {
    loadMoreBtn.value?.focus()
    return
  }
  void focusPost(Math.max(0, next))
}

const onFeedFocusIn = (event: FocusEvent) => {
  const article = (event.target as HTMLElement).closest<HTMLElement>('article[aria-posinset]')
  const index = article ? Number(article.getAttribute('aria-posinset')) - 1 : -1
  focusedPostId = props.posts[index]?.id ?? focusedPostId
}

const onFeedFocusOut = (event: FocusEvent) => {
  const next = event.relatedTarget
  if (next instanceof Node && feedEl.value?.contains(next)) return
  // A menu or dialog opened from a post returns focus to it, so its row stays.
  if (next === null || (next instanceof Element && next.closest('[role="menu"], [role="dialog"], [role="alertdialog"]'))) return
  focusedPostId = null
}

/**
 * Reading position from the rendered rows, not from `posts`: a parent switching
 * feeds reads it after the new list arrives and before it renders.
 */
const readScrollAnchor = (): FeedScrollAnchor | null => {
  const el = scroller()
  if (!el) return null
  const top = el.getBoundingClientRect().top
  const rows = feedEl.value?.querySelectorAll<HTMLElement>('.virtual-post-row') ?? []
  for (const row of Array.from(rows)) {
    const box = row.getBoundingClientRect()
    if (box.bottom > top) return { postId: row.dataset.postId ?? null, offset: top - box.top, scrollTop: el.scrollTop }
  }
  return { postId: null, offset: 0, scrollTop: el.scrollTop }
}

// Frames spent placing the anchor row; rows render and measure over the first few.
const RESTORE_FRAMES = 30
// A later restore supersedes a running one.
let restoreRun = 0

/**
 * Scrolls back to a position from readScrollAnchor; null is the top. The anchor row is
 * placed from the virtualizer's estimate, then from its rendered box, until it stays put
 * for two frames.
 */
const restoreScrollAnchor = async (anchor: FeedScrollAnchor | null) => {
  const run = ++restoreRun
  const el = scroller()
  if (!el) return
  if (!anchor) {
    el.scrollTop = 0
    return
  }
  let still = 0
  for (let frame = 0; frame < RESTORE_FRAMES && still < 2 && run === restoreRun; frame++) {
    const index = anchor.postId ? props.posts.findIndex((p) => p.id === anchor.postId) : -1
    if (index < 0) {
      el.scrollTop = anchor.scrollTop
      return
    }
    const row = feedEl.value?.querySelector<HTMLElement>(`.virtual-post-row[data-index="${index}"]`)
    if (row) {
      const drift = row.getBoundingClientRect().top - el.getBoundingClientRect().top + anchor.offset
      if (Math.abs(drift) < 1) {
        still++
      } else {
        still = 0
        el.scrollTop += drift
      }
    } else {
      still = 0
      el.scrollTop = (rowVirtualizer.value.measurementsCache[index]?.start ?? 0) + anchor.offset
    }
    await nextFrame()
  }
}

defineExpose({ focusPost, readScrollAnchor, restoreScrollAnchor })

// Emit visible post ids whenever the virtualizer's rendered window changes.
// Keyed-dedup on the joined id string prevents redundant emits while the
// user is mid-scroll between two adjacent overscan boundaries.
let lastVisibleKey = ''
watch(virtualRows, (rows) => {
  if (!rows.length || !props.posts.length) return
  const ids: string[] = []
  for (const row of rows) {
    if (row.index >= props.posts.length) continue
    const id = props.posts[row.index]?.id
    if (id) ids.push(id)
  }
  if (!ids.length) return
  const key = ids.join('|')
  if (key === lastVisibleKey) return
  lastVisibleKey = key
  emit('posts-visible', ids)
})

onMounted(() => {
  props.registerScroll?.(scrollContainer.value as unknown as HTMLElement | null)
})

onUnmounted(() => {
  props.registerScroll?.(null)
  resizeObserver.disconnect()
  observedElements.clear()
  clearAttemptTimer()
})
</script>

<style scoped>
/* The gutter is reserved with or without overflow, so the feed column sits on the same
   axis as a column header outside the scroller that reserves the same gutter. */
.posts-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 0;
  flex: 1;
  min-height: 0;
  height: 100%;
}

/* Rows are absolutely positioned, so the list's automatic minimum height is 0: a shrinkable
   list collapses to the scroller's height and the footer lands over a post. */
.posts-list,
.loading-more {
  flex-shrink: 0;
}

.virtual-post-row {
  padding: 0;
}

.skeleton-row {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-color);
}

.skeleton-avatar {
  width: 40px;
  height: 40px;
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
.skeleton-line--short { width: 45%; }

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

.loading-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  padding: var(--space-5);
}

.retry-btn {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.retry-btn:hover {
  background: var(--background-modifier-hover);
}

.load-more-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.load-more-btn[aria-disabled='true'] {
  cursor: progress;
}

.retry-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

/* The column rules run to the bottom whether the feed is loading, listed or empty. */
@media (min-width: 769px) {
  .posts-list,
  .skeleton-list,
  .empty-state {
    min-height: 100%;
  }

  .empty-state {
    justify-content: flex-start;
  }
}
</style>
