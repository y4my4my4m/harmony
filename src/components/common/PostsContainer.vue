<template>
  <div class="posts-container">
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

    <!-- Posts -->
    <div v-else class="posts-list">
      <MonyPost
        v-for="post in posts"
        :key="post.id"
        :post="post"
        v-bind="postProps"
      />

      <!-- Load More -->
      <div v-if="hasMore" class="load-more-container">
        <button
          @click="$emit('load-more')"
          :disabled="isLoading"
          class="load-more-btn"
        >
          <Icon v-if="isLoading" name="loader" class="spinning" />
          <span>{{ isLoading ? 'Loading...' : 'Load More' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
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
  postProps: () => ({})
})

defineEmits<{
  'load-more': []
  'empty-action': []
}>()
</script>

<style scoped>
.posts-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  overflow-y: auto;
  padding: 20px 0;
  height: calc(100% - 4px);
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
  color: white;
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