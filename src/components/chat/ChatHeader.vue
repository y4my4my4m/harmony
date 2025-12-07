<template>
  <div class="chat-header">
    <div class="header-left">
      <button 
        v-if="isMobile"
        class="mobile-menu-btn"
        @click="$emit('toggle-left-sidebar')"
      >
        <svg viewBox="0 0 24 24" class="menu-icon">
          <path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z" fill="currentColor"/>
        </svg>
      </button>
      
      <div class="channel-info">
        <div class="channel-icon">
          <svg viewBox="0 0 24 24" class="hash-icon">
            <path d="M5.41 21L6.12 17H2.12L2.47 15H6.47L7.53 9H3.53L3.88 7H7.88L8.59 3H10.59L9.88 7H15.88L16.59 3H18.59L17.88 7H21.88L21.53 9H17.53L16.47 15H20.47L20.12 17H16.12L15.41 21H13.41L14.12 17H8.12L7.41 21H5.41M9.53 9L8.47 15H14.47L15.53 9H9.53Z" fill="currentColor"/>
          </svg>
        </div>
        <div class="channel-details">
          <h2 class="channel-name">
            {{ channel.name }}
          </h2>
          <div v-if="channel.description" class="channel-description">
            {{ channel.description }}
          </div>
        </div>
      </div>
    </div>

    <div class="header-actions">
      <button 
        v-if="pinnedCount > 0"
        class="action-btn pinned-btn"
        :class="{ 'has-pins': pinnedCount > 0 }"
        @click="handlePinnedClick"
        :title="`${pinnedCount} pinned message${pinnedCount !== 1 ? 's' : ''}`"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12,2L15.09,8.26L22,9.27L17,14.14L18.18,21.02L12,17.77L5.82,21.02L7,14.14L2,9.27L8.91,8.26L12,2Z"/>
        </svg>
        <span v-if="pinnedCount > 0" class="pinned-count">{{ pinnedCount }}</span>
      </button>
      
      <button 
        class="action-btn threads-btn"
        @click="handleThreadsClick"
        title="View all threads"
      >
        <Icon name="thread" :size="16" />
      </button>
      
      <button 
        class="action-btn search-btn"
        @click="handleSearchClick"
        title="Search in channel"
      >
        <Icon name="search" :size="16" />
      </button>
      
      <button 
        class="action-btn members-btn"
        :class="{ active: props.rightSidebarOpen }"
        @click="handleMembersClick"
        title="Show member list"
      >
        <Icon name="users" :size="16" />
      </button>
      
      <button 
        class="action-btn more-btn"
        @click="handleMoreClick"
        title="More options"
      >
        <Icon name="dots-vertical" :size="16" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { Channel, Server } from '@/types'
import Icon from '@/components/common/Icon.vue'
import { messageService } from '@/services'

// Props
interface Props {
  channel: Channel
  server?: Server
  isMobile?: boolean
  rightSidebarOpen?: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'toggle-left-sidebar': []
  'toggle-right-sidebar': []
  'toggle-search': []
  'show-pinned': []
  'show-threads': []
}>()

// State
const showMembersList = ref(false)
const showOptionsMenu = ref(false)
const pinnedCount = ref(0)

// Methods
const loadPinnedCount = async () => {
  if (!props.channel?.id) return
  try {
    pinnedCount.value = await messageService.getPinnedCount(props.channel.id)
  } catch (error) {
    console.error('Failed to load pinned count:', error)
  }
}

const handlePinnedClick = () => {
  emit('show-pinned')
}

const handleSearchClick = () => {
  emit('toggle-search')
}

const handleThreadsClick = () => {
  emit('show-threads')
}

const handleMembersClick = () => {
  showMembersList.value = !showMembersList.value
  emit('toggle-right-sidebar')
}

const handleMoreClick = () => {
  showOptionsMenu.value = !showOptionsMenu.value
}

watch(() => props.channel?.id, () => {
  loadPinnedCount()
})

onMounted(() => {
  loadPinnedCount()
})
</script>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  height: 48px;
  min-height: 48px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.mobile-menu-btn {
  display: none;
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.mobile-menu-btn:hover {
  background: var(--background-secondary);
}

.menu-icon {
  width: 20px;
  height: 20px;
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.channel-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
  display: flex;
}

.hash-icon {
  width: 24px;
  height: 24px;
}

.channel-details {
  flex: 1;
  min-width: 0;
}

.channel-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-description {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
}

.action-btn:hover {
  color: var(--text-primary);
  background: var(--background-secondary);
}

.pinned-btn {
  position: relative;
}

.pinned-count {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--harmony-primary);
  color: white;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 5px;
  border-radius: 10px;
  min-width: 16px;
  text-align: center;
  line-height: 1.2;
}

.pinned-btn.has-pins {
  color: var(--harmony-primary);
}


/* Mobile styles */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }
  
  .chat-header {
    padding: 12px;
  }
  
  .action-btn {
    width: 40px;
    height: 40px;
  }
  
  .channel-description {
    display: none;
  }
  .pinned-count {
    top: 0;
    right: 0px;
  }

}
</style>