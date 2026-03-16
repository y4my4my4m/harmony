<template>
  <div class="thread-sidebar">
    <div class="sidebar-header">
      <h3>Threads</h3>
      <span class="thread-count" v-if="threads.length">{{ threads.length }}</span>
    </div>
    
    <div class="thread-list" v-if="!loading">
      <div v-if="threads.length === 0" class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" class="empty-icon">
          <path d="M12 2.81a1 1 0 0 1 0-1.41l.36-.36a1 1 0 0 1 1.41 0l9.2 9.2a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1.3.13l-9.54-6.72a1 1 0 0 1-.08-1.58l1-1 .65.65-1 1 7.93 5.59-7.16-7.16-.77.77Z"/>
        </svg>
        <p>No threads yet</p>
        <span>Start a thread from any message!</span>
      </div>
      
      <button 
        v-for="thread in threads" 
        :key="thread.id"
        class="thread-item"
        :class="{ active: activeThreadId === thread.id }"
        @click="selectThread(thread)"
      >
        <div class="thread-content">
          <div class="thread-name">{{ thread.name }}</div>
          <div class="thread-meta">
            <span class="message-count">{{ thread.message_count }} messages</span>
            <span class="separator">•</span>
            <span class="last-activity">{{ formatRelativeTime(thread.last_message_at) }}</span>
          </div>
          <div class="thread-preview" v-if="thread.last_message_preview">
            {{ thread.last_message_preview }}
          </div>
        </div>
        
        <div class="thread-badges">
          <span v-if="thread.unread_count" class="unread-badge">{{ thread.unread_count }}</span>
          <svg 
            v-if="thread.archived" 
            class="archived-icon" 
            width="16" height="16" 
            viewBox="0 0 24 24" 
            fill="currentColor"
            title="Archived"
          >
            <path d="M21 8V6c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v2h18zm-2 2H5v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V10zm-4 3c0 .55-.45 1-1 1H10c-.55 0-1-.45-1-1s.45-1 1-1h4c.55 0 1 .45 1 1z"/>
          </svg>
        </div>
      </button>
    </div>
    
    <div v-else class="loading-state">
      <div class="spinner"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { threadService } from '@/services/ThreadService'
import { formatDistanceToNow } from 'date-fns'
import type { ThreadWithDetails } from '@/services/ThreadService'

interface Props {
  channelId?: string
  activeThreadId?: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'select-thread': [thread: ThreadWithDetails]
}>()

const threads = ref<ThreadWithDetails[]>([])
const loading = ref(false)

const loadThreads = async () => {
  if (!props.channelId) {
    threads.value = []
    return
  }
  
  loading.value = true
  try {
    threads.value = await threadService.getThreadsForChannel(props.channelId)
  } catch (error) {
    console.error('Failed to load threads:', error)
    threads.value = []
  } finally {
    loading.value = false
  }
}

const selectThread = (thread: ThreadWithDetails) => {
  emit('select-thread', thread)
}

const formatRelativeTime = (date?: Date | string | null) => {
  if (!date) return ''
  try {
    const d = typeof date === 'string' ? new Date(date) : date
    return formatDistanceToNow(d, { addSuffix: true })
  } catch {
    return ''
  }
}

watch(() => props.channelId, loadThreads)

onMounted(() => {
  loadThreads()
})
</script>

<style scoped>
.thread-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--background-secondary);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.sidebar-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.thread-count {
  background: var(--harmony-primary);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 10px;
}

.thread-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  text-align: center;
  color: var(--text-secondary);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 16px;
}

.empty-state p {
  margin: 0 0 4px 0;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-state span {
  font-size: 13px;
}

.thread-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  width: 100%;
  padding: 12px;
  background: none;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
  transition: background 0.15s;
}

.thread-item:hover {
  background: var(--background-tertiary);
}

.thread-item.active {
  background: var(--harmony-primary-alpha, rgba(14, 165, 233, 0.15));
}

.thread-content {
  flex: 1;
  min-width: 0;
}

.thread-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thread-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.separator {
  opacity: 0.5;
}

.thread-preview {
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thread-badges {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-left: 8px;
}

.unread-badge {
  background: var(--harmony-primary);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

.archived-icon {
  color: var(--text-muted);
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-color);
  border-top-color: var(--harmony-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>

