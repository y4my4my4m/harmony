<template>
  <div class="dm-header">
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
      
      <div class="conversation-info">
        <div class="conversation-avatar">
          <Avatar
            :src="conversation.other_user?.avatar_url"
            :alt="conversation.other_user?.display_name || conversation.other_user?.username"
            size="sm"
            :status="otherUserStatus"
          />
        </div>
        <div class="conversation-details">
          <h2 class="conversation-name">
            {{ conversation.other_user?.display_name || conversation.other_user?.username }}
          </h2>
          <div class="conversation-status">
            <span v-if="isOtherUserOnline" class="status online">
              Online
            </span>
            <span v-else class="status offline">
              Last seen {{ formatLastSeen(conversation.other_user?.last_seen) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="header-actions">
      <button 
        class="action-btn voice-btn"
        @click="$emit('toggle-voice-panel')"
        title="Start voice call"
      >
        <svg viewBox="0 0 24 24" class="voice-icon">
          <path d="M7,4A2,2 0 0,0 5,6V10A2,2 0 0,0 7,12H9V16A2,2 0 0,0 11,18H13A2,2 0 0,0 15,16V12H17A2,2 0 0,0 19,10V6A2,2 0 0,0 17,4H7M7,6H17V10H15V16H11V10H9V8H15V6H7V8H9V10H7V6Z" fill="currentColor"/>
        </svg>
      </button>
      
      <button 
        class="action-btn search-btn"
        @click="handleSearchClick"
        title="Search in conversation"
      >
        <svg viewBox="0 0 24 24" class="search-icon">
          <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
        </svg>
      </button>
      
      <button 
        class="action-btn more-btn"
        @click="handleMoreClick"
        title="More options"
      >
        <svg viewBox="0 0 24 24" class="more-icon">
          <path d="M12,16A2,2 0 0,1 14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18A2,2 0 0,1 12,16M12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12A2,2 0 0,1 12,10M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8A2,2 0 0,1 10,6A2,2 0 0,1 12,4Z" fill="currentColor"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import { useUserData } from '@/composables/useUserData'
import type { DMConversation } from '@/stores/useDM'

// Props
interface Props {
  conversation: DMConversation
  isMobile?: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'toggle-left-sidebar': []
  'toggle-voice-panel': []
}>()

// Use clean status system
const { isUserOnline, getUserStatusForAvatar } = useUserData()

// State
const showSearchModal = ref(false)
const showOptionsMenu = ref(false)

// Computed
const isOtherUserOnline = computed(() => {
  if (!props.conversation.other_user?.id) return false
  return isUserOnline(props.conversation.other_user.id).value
})

const otherUserStatus = computed(() => {
  if (!props.conversation.other_user?.id) return 'offline'
  return getUserStatusForAvatar(props.conversation.other_user.id).value
})

// Methods
const formatLastSeen = (lastSeen?: string): string => {
  if (!lastSeen) return 'some time ago'
  
  const now = new Date()
  const seen = new Date(lastSeen)
  const diffMs = now.getTime() - seen.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  
  return seen.toLocaleDateString()
}

const handleSearchClick = () => {
  showSearchModal.value = true
}

const handleMoreClick = () => {
  showOptionsMenu.value = !showOptionsMenu.value
}
</script>

<style scoped>
.dm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  height: 64px;
  min-height: 64px;
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

.conversation-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.conversation-details {
  flex: 1;
  min-width: 0;
}

.conversation-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 2px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conversation-status {
  font-size: 12px;
}

.status {
  font-weight: 500;
}

.status.online {
  color: var(--success-color, #3ba55c);
}

.status.offline {
  color: var(--text-secondary);
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

.voice-icon,
.search-icon,
.more-icon {
  width: 20px;
  height: 20px;
}

/* Mobile styles */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }
  
  .dm-header {
    padding: 12px;
  }
  
  .action-btn {
    width: 40px;
    height: 40px;
  }
  
  .voice-icon,
  .search-icon,
  .more-icon {
    width: 24px;
    height: 24px;
  }
}
</style>