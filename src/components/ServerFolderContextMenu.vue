<template>
  <div 
    v-if="isVisible" 
    class="context-menu"
    :style="{ top: position.y + 'px', left: position.x + 'px' }"
    @click.stop
    v-click-outside="closeMenu"
  >
    <!-- Edit Folder -->
    <div class="context-menu-item" @click="editFolder">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
      </svg>
      <span>Edit Folder</span>
    </div>
    
    <div class="context-menu-divider"></div>

    <!-- Mark as Read (if has unread) -->
    <div v-if="hasUnread" class="context-menu-item" @click="markAsRead">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
      </svg>
      <span>Mark All as Read</span>
    </div>

    <!-- Expand/Collapse -->
    <div class="context-menu-item" @click="toggleExpanded">
      <svg v-if="folder?.is_expanded" width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M19,13H5V11H19V13Z"/>
      </svg>
      <svg v-else width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
      </svg>
      <span>{{ folder?.is_expanded ? 'Collapse Folder' : 'Expand Folder' }}</span>
    </div>
    
    <div class="context-menu-divider"></div>
    
    <!-- Delete Folder -->
    <div class="context-menu-item danger" @click="deleteFolder">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
      </svg>
      <span>Delete Folder</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useNotificationStore } from '@/stores/useNotification';
import type { ServerFolder, Server } from '@/types';

interface Props {
  isVisible: boolean;
  position: { x: number; y: number };
  folder: ServerFolder | null;
  servers: Server[];
}

interface Emits {
  (e: 'close'): void;
  (e: 'edit-folder', folder: ServerFolder): void;
  (e: 'delete-folder', folder: ServerFolder): void;
  (e: 'toggle-expanded', folder: ServerFolder): void;
  (e: 'mark-as-read', folder: ServerFolder): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const notificationStore = useNotificationStore();

const hasUnread = computed(() => {
  if (!props.folder || !props.servers) return false;
  return props.servers.some(s => notificationStore.unreadServerMentions(s.id) > 0);
});

const closeMenu = () => {
  emit('close');
};

const editFolder = () => {
  if (props.folder) {
    emit('edit-folder', props.folder);
  }
  closeMenu();
};

const deleteFolder = () => {
  if (props.folder) {
    emit('delete-folder', props.folder);
  }
  closeMenu();
};

const toggleExpanded = () => {
  if (props.folder) {
    emit('toggle-expanded', props.folder);
  }
  closeMenu();
};

const markAsRead = () => {
  if (props.folder) {
    emit('mark-as-read', props.folder);
  }
  closeMenu();
};
</script>

<style scoped>
.context-menu {
  position: fixed;
  background: #18191c;
  border: 1px solid var(--background-quinary);
  border-radius: 6px;
  padding: 6px 0;
  min-width: 180px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  color: var(--text-secondary, #b9bbbe);
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.1s ease;
}

.context-menu-item:hover {
  background-color: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary);
}

.context-menu-item.danger {
  color: #ed4245;
}

.context-menu-item.danger:hover {
  background-color: #ed4245;
  color: var(--text-primary);
}

.context-menu-divider {
  height: 1px;
  background: var(--border-color, var(--background-quinary));
  margin: 4px 8px;
}
</style>

