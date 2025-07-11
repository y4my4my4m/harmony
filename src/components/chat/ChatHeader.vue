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
        class="action-btn voice-btn"
        @click="$emit('toggle-voice-panel')"
        title="Join voice channel"
      >
        <svg viewBox="0 0 24 24" class="voice-icon">
          <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
        </svg>
      </button>
      
      <button 
        class="action-btn search-btn"
        @click="handleSearchClick"
        title="Search in channel"
      >
        <svg viewBox="0 0 24 24" class="search-icon">
          <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
        </svg>
      </button>
      
      <button 
        class="action-btn members-btn"
        @click="handleMembersClick"
        title="Show member list"
      >
        <svg viewBox="0 0 24 24" class="members-icon">
          <path d="M16,4C18.11,4 19.8,5.69 19.8,7.8C19.8,9.91 18.11,11.6 16,11.6C13.89,11.6 12.2,9.91 12.2,7.8C12.2,5.69 13.89,4 16,4M16,13.4C18.67,13.4 24,14.73 24,17.4V20H8V17.4C8,14.73 13.33,13.4 16,13.4M8.8,10C10.27,10 11.45,8.82 11.45,7.35C11.45,5.88 10.27,4.7 8.8,4.7C7.33,4.7 6.15,5.88 6.15,7.35C6.15,8.82 7.33,10 8.8,10M8.8,11.3C6.96,11.3 3.3,12.22 3.3,14.05V16.1H7.1V17.4C7.1,16.55 7.65,15.8 8.42,15.37C8.29,15.29 8.1,15.2 7.85,15.11C6.94,14.81 6,14.65 5.25,14.65C4.5,14.65 3.56,14.81 2.65,15.11C1.18,15.54 0,16.72 0,18.05V20H6V17.4C6,14.73 6.67,13.4 8.8,11.3Z" fill="currentColor"/>
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
import { ref } from 'vue'
import type { Channel, Server } from '@/types'

// Props
interface Props {
  channel: Channel
  server?: Server
  isMobile?: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'toggle-left-sidebar': []
  'toggle-voice-panel': []
}>()

// State
const showSearchModal = ref(false)
const showMembersList = ref(false)
const showOptionsMenu = ref(false)

// Methods
const handleSearchClick = () => {
  showSearchModal.value = true
}

const handleMembersClick = () => {
  showMembersList.value = !showMembersList.value
}

const handleMoreClick = () => {
  showOptionsMenu.value = !showOptionsMenu.value
}
</script>

<style scoped>
.chat-header {
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
  margin: 0 0 2px 0;
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

.voice-icon,
.search-icon,
.members-icon,
.more-icon {
  width: 20px;
  height: 20px;
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
  
  .voice-icon,
  .search-icon,
  .members-icon,
  .more-icon {
    width: 24px;
    height: 24px;
  }
  
  .channel-description {
    display: none;
  }
}
</style>