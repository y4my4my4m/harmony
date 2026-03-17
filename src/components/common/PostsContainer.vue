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
  'user-click': [user: any]
  'hashtag-click': [tag: string]
  'show-conversation': [postId: string]
}>()

const scrollContainer = ref<HTMLDivElement | null>(null)

// +1 phantom row when there's more to load — acts as in-flow loading indicator
const rowVirtualizer = useVirtualizer(computed(() => ({
  count: props.hasMore ? props.posts.length + 1 : props.posts.length,
  getScrollElement: () => scrollContainer.value,
  estimateSize: () => 300,
  overscan: 5,
})))

const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems())
const totalSize = computed(() => rowVirtualizer.value.getTotalSize())

const measureElement = (el: any) => {
  if (!el || !(el instanceof HTMLElement)) return
  rowVirtualizer.value.measureElement(el)
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

onMounted(() => {
  props.registerScroll?.(scrollContainer.value)
})

onUnmounted(() => {
  props.registerScroll?.(null)
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
