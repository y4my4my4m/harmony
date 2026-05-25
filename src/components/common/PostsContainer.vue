<template>
  <div class="posts-container" ref="scrollContainer">
    <!-- Loading State -->
    <div v-if="isLoading && posts.length === 0" class="loading-state">
      <div class="loading-spinner"></div>
      <p>{{ loadingMessage }}</p>
    </div>

    <!-- Empty State -->
    <div v-else-if="!isLoading && posts.length === 0" class="empty-state">
      <Icon :name="emptyIcon" :size="48" />
      <h3>{{ emptyTitle }}</h3>
      <p>{{ emptyMessage }}</p>
      <button 
        v-if="emptyAction"
        @click="$emit('empty-action')" 
        class="explore-btn"
      >
        {{ emptyAction }}
      </button>
    </div>

    <!-- Virtualized Posts -->
    <div v-else class="posts-list" :style="{ height: `${totalSize}px`, position: 'relative' }">
      <div
        v-for="virtualRow in virtualRows"
        :key="virtualRow.index < posts.length ? posts[virtualRow.index].id : '__loader__'"
        :data-index="virtualRow.index"
        :ref="measureElement"
        class="virtual-post-row"
        :style="{
          position: 'absolute',
          top: `${virtualRow.start}px`,
          left: 0,
          width: '100%',
        }"
      >
        <div v-if="virtualRow.index >= posts.length" class="loading-more">
          <Icon name="loader" class="spinning" />
          <span>Loading more...</span>
        </div>
        <MonyPost
          v-else
          :post="posts[virtualRow.index]"
          v-bind="postProps"
          @reply="$emit('reply', $event)"
          @favorite="$emit('favorite', $event)"
          @reblog="$emit('reblog', $event)"
          @bookmark="$emit('bookmark', $event)"
          @delete="$emit('delete', $event)"
          @edit="$emit('edit', $event)"
          @user-click="$emit('user-click', $event)"
          @hashtag-click="$emit('hashtag-click', $event)"
          @show-conversation="$emit('show-conversation', $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, watchEffect } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import MonyPost from '@/components/activitypub/MonyPost.vue'
import Icon from '@/components/common/Icon.vue'
import type { TimelinePost } from '@/types'

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
}

const props = withDefaults(defineProps<Props>(), {
  posts: () => [],
  isLoading: false,
  hasMore: false,
  loadingMessage: 'Loading posts...',
  emptyTitle: 'No posts yet',
  emptyMessage: 'Posts will appear here when available.',
  emptyIcon: 'users',
  emptyAction: undefined,
  postProps: () => ({}),
  registerScroll: undefined
})

const emit = defineEmits<{
  'load-more': []
  'empty-action': []
  'reply': [post: any]
  'favorite': [postId: string]
  'reblog': [postId: string]
  'bookmark': [postId: string]
  'delete': [postId: string]
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
const observedElements = new Set<HTMLElement>()

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

// +1 phantom row when there's more to load - acts as in-flow loading indicator
const rowVirtualizer = useVirtualizer<HTMLElement, Element>(
  computed(() => ({
    count: props.hasMore ? props.posts.length + 1 : props.posts.length,
    getScrollElement: () => scrollContainer.value,
    estimateSize: estimatePostSize,
    overscan: 8,
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

watch(() => props.posts.length, () => {
  lastEmittedIndex.value = -1
})

watchEffect(() => {
  const items = virtualRows.value
  const lastItem = items[items.length - 1]
  if (!lastItem) return

  if (
    lastItem.index >= props.posts.length - 1 &&
    props.hasMore &&
    !props.isLoading &&
    lastItem.index !== lastEmittedIndex.value
  ) {
    lastEmittedIndex.value = lastItem.index
    emit('load-more')
  }
})

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
})
</script>

<style scoped>
.posts-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  overflow-y: auto;
  padding: 20px 0;
  flex: 1;
  min-height: 0;
  height: 100%;
}

.posts-list {
  width: 100%;
  max-width: 600px;
}

.virtual-post-row {
  padding: 6px 16px;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-16) var(--space-4);
  text-align: center;
  color: var(--text-secondary);
  min-height: 400px;
}

.empty-state h3 {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  margin: var(--space-4) 0 var(--space-2) 0;
  color: var(--text-primary);
}

.empty-state p {
  font-size: var(--font-size-sm);
  margin: 0 0 var(--space-5) 0;
  max-width: 300px;
  line-height: var(--line-height-relaxed);
}

.explore-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all var(--transition-base);
  text-decoration: none;
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.explore-btn:hover {
  background: var(--harmony-primary-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
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

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .posts-container {
    max-width: 100%;
  }
  
  .empty-state,
  .loading-state {
    padding: var(--space-10) var(--space-4);
    min-height: 300px;
  }
}
</style>
