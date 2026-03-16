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
        :key="posts[virtualRow.index].id"
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
        <MonyPost
          :post="posts[virtualRow.index]"
          v-bind="postProps"
          @reply="$emit('reply', $event)"
          @favorite="$emit('favorite', $event)"
          @reblog="$emit('reblog', $event)"
          @bookmark="$emit('bookmark', $event)"
          @delete="$emit('delete', $event)"
          @user-click="$emit('user-click', $event)"
          @hashtag-click="$emit('hashtag-click', $event)"
          @show-conversation="$emit('show-conversation', $event)"
        />
      </div>
    </div>

    <!-- Infinite scroll sentinel + fallback button -->
    <div v-if="hasMore && posts.length > 0" ref="sentinelRef" class="load-more-container">
      <div v-if="isLoading" class="loading-more">
        <Icon name="loader" class="spinning" />
        <span>Loading...</span>
      </div>
      <button
        v-else
        @click="$emit('load-more')"
        class="load-more-btn"
      >
        Load More
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
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
  /** Optional: register scroll element for parent (e.g. composer auto-hide) */
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

const propsWithRegister = props as typeof props & { registerScroll?: (el: HTMLElement | null) => void }

const emit = defineEmits<{
  'load-more': []
  'empty-action': []
  'reply': [post: any]
  'favorite': [postId: string]
  'reblog': [postId: string]
  'bookmark': [postId: string]
  'delete': [postId: string]
  'user-click': [user: any]
  'hashtag-click': [tag: string]
  'show-conversation': [postId: string]
}>()

const scrollContainer = ref<HTMLDivElement | null>(null)
const sentinelRef = ref<HTMLDivElement | null>(null)

// --- Virtual scrolling ---
const rowVirtualizer = useVirtualizer(computed(() => ({
  count: props.posts.length,
  getScrollElement: () => scrollContainer.value,
  estimateSize: () => 300,
  overscan: 3,
})))

const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems())
const totalSize = computed(() => rowVirtualizer.value.getTotalSize())

const measureElement = (el: any) => {
  if (!el || !(el instanceof HTMLElement)) return
  rowVirtualizer.value.measureElement(el)
}

// --- Infinite scroll via IntersectionObserver ---
let observer: IntersectionObserver | null = null

const setupObserver = () => {
  if (observer) observer.disconnect()
  if (!sentinelRef.value) return

  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting && props.hasMore && !props.isLoading) {
        emit('load-more')
      }
    },
    { root: scrollContainer.value, rootMargin: '200px' }
  )
  observer.observe(sentinelRef.value)
}

watch([() => props.hasMore, sentinelRef], () => {
  setupObserver()
})

onMounted(() => {
  setupObserver()
  props.registerScroll?.(scrollContainer.value)
})

onUnmounted(() => {
  props.registerScroll?.(null)
  if (observer) {
    observer.disconnect()
    observer = null
  }
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
  height: calc(100% - 4px);
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

.explore-btn,
.load-more-btn {
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
}

.explore-btn {
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.explore-btn:hover {
  background: var(--harmony-primary-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.load-more-btn {
  background: var(--background-secondary);
  border-color: var(--border-color);
  color: var(--text-primary);
}

.load-more-btn:hover {
  background: var(--background-hover);
  border-color: var(--border-hover);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.load-more-container {
  display: flex;
  justify-content: center;
  padding: var(--space-5);
  width: 100%;
  max-width: 600px;
}

.loading-more {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
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
