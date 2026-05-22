<template>
  <div class="view-header">
    <div class="header-content">
      <h1 class="page-title">
        <Icon :name="getViewIcon(viewType)" />
        {{ getViewTitle(viewType) }}
      </h1>
      <p class="page-subtitle">{{ getViewSubtitle(viewType) }}</p>
    </div>
    
    <!-- Clear All Button (for bookmarks) -->
    <button 
      v-if="viewType === 'bookmarks' && (dataCount ?? 0) > 0"
      @click="$emit('clear-all')"
      class="clear-all-btn"
    >
      <Icon name="trash" />
      Clear All
    </button>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'

interface Props {
  viewType: string
  dataCount?: number
}

defineProps<Props>()

defineEmits<{
  'clear-all': []
}>()

// Helper functions
const getViewIcon = (viewType: string) => {
  switch (viewType) {
    case 'explore':
      return 'compass'
    case 'bookmarks':
      return 'bookmark'
    case 'lists':
      return 'list'
    case 'mentions':
      return 'at-sign'
    case 'profile':
      return 'user'
    default:
      return 'home'
  }
}

const getViewTitle = (viewType: string) => {
  switch (viewType) {
    case 'explore':
      return 'Explore'
    case 'bookmarks':
      return 'Bookmarks'
    case 'lists':
      return 'Lists'
    case 'mentions':
      return 'Mentions'
    case 'profile':
      return 'Profile'
    default:
      return 'Timeline'
  }
}

const getViewSubtitle = (viewType: string) => {
  switch (viewType) {
    case 'explore':
      return 'Discover trending content and new instances'
    case 'bookmarks':
      return 'Posts you\'ve saved for later'
    case 'lists':
      return 'Curated lists of users and topics'
    case 'mentions':
      return 'Posts where you\'ve been @mentioned'
    case 'profile':
      return 'Your profile and posts'
    default:
      return 'Your timeline'
  }
}
</script>

<style scoped>
.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-primary);
  position: sticky;
  top: 0;
  z-index: 10;
}

.header-content {
  flex: 1;
}

.page-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 4px 0;
  color: var(--text-primary);
}

.page-subtitle {
  font-size: 16px;
  color: var(--text-secondary);
  margin: 0;
}

.clear-all-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.clear-all-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
  border-color: var(--border-hover);
}
</style> 