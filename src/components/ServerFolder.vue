<template>
  <div 
    class="server-folder"
    :class="{ 'is-expanded': folder.is_expanded, 'is-dragging-over': isDraggingOver }"
    @contextmenu.prevent="openContextMenu"
  >
    <!-- Collapsed folder view - shows 2x2 grid of server icons -->
    <div 
      v-if="!folder.is_expanded"
      class="folder-collapsed"
      :style="{ '--folder-color': folder.color }"
      @click="toggleExpanded"
      @dragenter.prevent="handleDragEnter"
      @dragleave.prevent="handleDragLeave"
      @dragover.prevent
      @drop.prevent="handleDrop"
    >
      <div class="folder-grid">
        <div 
          v-for="server in previewServers" 
          :key="server.id"
          class="folder-grid-item"
        >
          <img 
            :src="getServerIconUrl(server.icon)" 
            :alt="server.name"
            class="folder-grid-icon"
            draggable="false"
            @error="onIconError($event)"
          />
        </div>
        <!-- Empty slots -->
        <div 
          v-for="n in (4 - previewServers.length)" 
          :key="'empty-' + n"
          class="folder-grid-item folder-grid-empty"
        ></div>
      </div>
      <!-- Folder indicator bar -->
      <div class="folder-indicator"></div>
    </div>

    <!-- Expanded folder view -->
    <div v-else class="folder-expanded" :style="{ '--folder-color': folder.color }">
      <!-- Folder top cap with folder icon -->
      <div class="folder-cap folder-cap-top" @click="toggleExpanded">
        <svg class="folder-cap-icon" viewBox="0 0 24 24">
          <path fill="currentColor" d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/>
        </svg>
      </div>

      <!-- Servers in folder with colored border -->
      <div class="folder-content">
        <div 
          v-for="server in servers"
          :key="server.id"
          class="folder-server-item"
          draggable="true"
          @dragstart="handleServerDragStart($event, server)"
          @contextmenu.prevent.stop="openServerContextMenu($event, server)"
        >
          <ServerIcon
            :id="server.id"
            :src="server.icon"
            :alt="server.name"
            size="md"
            class="server-item"
            :class="{ selected: isSelected(server.id) }"
            shape="round"
            :interactive="true"
            @click="$emit('select-server', server.id)"
          />
          <div v-if="getServerUnreadMentions(server.id) > 0" class="unread-badge">
            {{ getServerUnreadMentions(server.id) > 99 ? '99+' : getServerUnreadMentions(server.id) }}
          </div>
        </div>
      </div>
    </div>

    <!-- Server context menu within folder -->
    <div 
      v-if="showServerMenu" 
      class="context-menu"
      :style="{ top: menuPosition.y + 'px', left: menuPosition.x + 'px' }"
      @click.stop
      v-click-outside="closeServerMenu"
    >
      <div class="context-menu-item" @click="removeFromFolder">
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
        </svg>
        <span>Remove from Folder</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import ServerIcon from '@/components/common/ServerIcon.vue';
import { getServerIconUrl } from '@/utils/serverUtils';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useNotificationStore } from '@/stores/useNotification';
import type { Server, ServerFolder } from '@/types';

interface Props {
  folder: ServerFolder;
  servers: Server[];
  selectedServerId: string | null;
}

interface Emits {
  (e: 'select-server', serverId: string): void;
  (e: 'open-context-menu', event: MouseEvent, folder: ServerFolder): void;
  (e: 'servers-reordered', servers: Server[]): void;
  (e: 'server-dropped', serverId: string, folderId: string): void;
  (e: 'server-removed', serverId: string): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const serverChannelStore = useServerChannelStore();
const notificationStore = useNotificationStore();

const isDraggingOver = ref(false);
const showServerMenu = ref(false);
const menuPosition = ref({ x: 0, y: 0 });
const selectedServerForMenu = ref<Server | null>(null);

// First 4 servers for the grid preview
const previewServers = computed(() => {
  return props.servers.slice(0, 4);
});

const isSelected = (serverId: string) => {
  return serverId === props.selectedServerId;
};

const getServerUnreadMentions = (serverId: string): number => {
  return notificationStore.unreadServerMentions(serverId);
};

const toggleExpanded = () => {
  serverChannelStore.toggleFolderExpanded(props.folder.id);
};

const openContextMenu = (event: MouseEvent) => {
  emit('open-context-menu', event, props.folder);
};

const handleDragEnter = () => {
  isDraggingOver.value = true;
};

const handleDragLeave = (event: DragEvent) => {
  // Only set to false if we're actually leaving the folder element
  const relatedTarget = event.relatedTarget as HTMLElement;
  if (!relatedTarget || !event.currentTarget || !(event.currentTarget as HTMLElement).contains(relatedTarget)) {
    isDraggingOver.value = false;
  }
};

const handleDrop = (event: DragEvent) => {
  isDraggingOver.value = false;
  
  const serverId = event.dataTransfer?.getData('text/plain');
  if (serverId) {
    emit('server-dropped', serverId, props.folder.id);
  }
};

const handleServerDragStart = (event: DragEvent, server: Server) => {
  event.dataTransfer?.setData('text/plain', server.id);
  event.dataTransfer?.setData('application/x-from-folder', props.folder.id);
  event.dataTransfer!.effectAllowed = 'move';
};

const openServerContextMenu = (event: MouseEvent, server: Server) => {
  selectedServerForMenu.value = server;
  menuPosition.value = { x: event.clientX, y: event.clientY };
  showServerMenu.value = true;
};

const closeServerMenu = () => {
  showServerMenu.value = false;
  selectedServerForMenu.value = null;
};

const removeFromFolder = async () => {
  if (selectedServerForMenu.value) {
    await serverChannelStore.moveServerToFolder(selectedServerForMenu.value.id, null);
    emit('server-removed', selectedServerForMenu.value.id);
    
    // Check if folder is now empty - if so, delete it
    const remainingServers = props.servers.filter(s => s.id !== selectedServerForMenu.value!.id);
    if (remainingServers.length === 0) {
      await serverChannelStore.deleteFolder(props.folder.id);
    }
  }
  closeServerMenu();
};

const onIconError = (event: Event) => {
  const img = event.target as HTMLImageElement;
  img.src = '/default_server.png';
};
</script>

<style scoped>
.server-folder {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: 4px 0;
  --folder-color: #5865f2;
}

/* Collapsed folder - 2x2 grid */
.folder-collapsed {
  width: 48px;
  height: 48px;
  background: var(--h-black-light, #2f3136);
  border-radius: 16px;
  cursor: pointer;
  position: relative;
  transition: all 0.2s ease-in-out;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.folder-collapsed:hover {
  transform: translateX(5px);
  border-radius: 12px;
}

.is-dragging-over .folder-collapsed {
  transform: scale(1.08);
  filter: brightness(1.3);
  box-shadow: 
    0 0 0 3px var(--folder-color),
    0 0 20px var(--folder-color),
    inset 0 0 0 48px rgba(255, 255, 255, 0.1);
}

/* Server outline indicator when dragging over */
.is-dragging-over .folder-collapsed::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 36px;
  height: 36px;
  border: 2px dashed rgba(255, 255, 255, 0.6);
  border-radius: 50%;
  animation: pulse-outline 0.8s ease-in-out infinite;
}

@keyframes pulse-outline {
  0%, 100% { opacity: 0.4; transform: translate(-50%, -50%) scale(0.9); }
  50% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

.folder-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
  padding: 3px;
  flex: 1;
}

.folder-grid-item {
  width: 100%;
  height: 100%;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.folder-grid-icon {
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

.folder-grid-empty {
  background: var(--h-chat-light, #40444b);
}

.folder-indicator {
  height: 4px;
  width: 100%;
  flex-shrink: 0;
  background: var(--folder-color);
}

/* Expanded folder - Discord style */
.folder-expanded {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  background: color-mix(in srgb, var(--folder-color) 30%, transparent);
  border-radius: 16px;
  padding: 0 0 4px 0;
  transition: all 0.2s ease;
  outline: 2px solid  color-mix(in srgb, var(--folder-color) 30%, transparent);
  outline-offset: -2px;
}

.folder-expanded:hover {
  outline: 2px solid var(--folder-color);
}

.folder-cap {
  width: 56px;
  background: var(--folder-color);
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}

.folder-cap:hover {
  filter: brightness(1.1);
}

.folder-cap-top {
  height: 24px;
  border-radius: 16px 16px 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
}



.folder-cap-icon {
  width: 16px;
  height: 16px;
  color: white;
  opacity: 0.9;
}

.folder-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: linear-gradient(
    to right,
    transparent 0%,
    transparent calc(50% - 26px),
    var(--folder-color) calc(50% - 26px),
    var(--folder-color) calc(50% - 24px),
    transparent calc(50% - 24px),
    transparent 100%
  );
}

.folder-server-item {
  position: relative;
}

/* Server item styles */
.server-item {
  cursor: pointer;
  transition: all 0.2s ease-in-out;
  user-select: none;
}

.server-item:hover {
  transform: translateX(5px);
}

.server-item.selected {
  border: 2px solid var(--h-secondary);
  border-radius: 50%;
}

/* Make server images non-draggable */
.server-item :deep(img) {
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

/* Unread badge */
.unread-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #f04747;
  color: white;
  font-size: 10px;
  font-weight: bold;
  padding: 2px 5px;
  border-radius: 10px;
  min-width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

/* Hover indicator for collapsed */
.folder-collapsed::before {
  content: "";
  position: absolute;
  left: -20px;
  top: 50%;
  transform: translateY(-50%);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vt-c-divider-dark-1);
  opacity: 0;
  transition: all 0.2s ease;
}

.folder-collapsed:hover::before {
  left: -12px;
  opacity: 1;
}

/* Context menu */
.context-menu {
  position: fixed;
  background: #18191c;
  border: 1px solid #40444b;
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
  background-color: var(--harmony-primary, #5865f2);
  color: #ffffff;
}
</style>
