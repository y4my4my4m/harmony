<template>
  <div 
    class="server-folder"
    :class="{ 'is-expanded': folder.is_expanded, 'is-dragging-over': isDraggingOver }"
    @contextmenu.prevent="openContextMenu"
  >
    <!-- Collapsed folder view - shows 2x2 grid of server icons -->
    <Transition name="folder-collapse">
      <div 
        v-if="!folder.is_expanded"
        class="folder-collapsed"
        :style="{ '--folder-color': folder.color }"
        @click="toggleExpanded"
        @dragenter.prevent="handleDragEnter"
        @dragleave.prevent="handleDragLeave"
        @dragover.prevent
        @drop.prevent="handleDrop"
        @mouseenter="showFolderTooltip"
        @mouseleave="hideFolderTooltip"
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
    </Transition>

    <!-- Notification dot for collapsed folder (outside overflow:hidden container) -->
    <div v-if="!folder.is_expanded && folderHasNotifications" class="folder-notification-dot"></div>

    <!-- Expanded folder view -->
    <Transition name="folder-expand">
      <div 
        v-if="folder.is_expanded" 
        class="folder-expanded" 
        :class="{ 'is-drag-target': isDraggingOver }"
        :style="{ '--folder-color': folder.color }"
        @dragenter.prevent="handleDragEnter"
        @dragleave.prevent="handleDragLeave"
        @dragover.prevent
        @drop.prevent="handleDrop"
      >
        <!-- Folder top cap with folder icon -->
        <div 
          class="folder-cap folder-cap-top" 
          @click="toggleExpanded"
          @mouseenter="showFolderTooltip"
          @mouseleave="hideFolderTooltip"
        >
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
            :class="{
              'is-dragging': draggingServerIdInFolder === server.id,
              'drop-target-before': dropTargetServerId === server.id && dropPosition === 'before',
              'drop-target-after': dropTargetServerId === server.id && dropPosition === 'after',
              'external-drop-target': dropTargetServerId === server.id && isExternalDragOver
            }"
            draggable="true"
            @dragstart="handleServerDragStart($event, server)"
            @dragend="handleServerDragEnd"
            @dragenter.prevent="handleServerDragEnterItem($event, server)"
            @dragover="handleServerDragOverItem($event, server)"
            @dragleave="handleServerDragLeaveItem($event)"
            @drop="handleServerDropOnItem($event, server)"
            @click.stop="handleServerClick(server.id)"
            @contextmenu.prevent.stop="openServerContextMenu($event, server)"
            @mouseenter="showServerTooltip($event, server.name)"
            @mouseleave="hideServerTooltip"
          >
            <div class="server-pill" :class="{ 'visible': isSelected(server.id), 'has-unread': hasServerUnread(server.id) && !isSelected(server.id) }"></div>
            <ServerIcon
              :id="server.id"
              :src="server.icon"
              :alt="server.name"
              size="md"
              class="server-item"
              :class="{ selected: isSelected(server.id) }"
              shape="round"
              :interactive="true"
              :show-title="false"
            />
            <div v-if="getServerUnreadMentions(server.id) > 0" class="unread-badge">
              {{ getServerUnreadMentions(server.id) > 99 ? '99+' : getServerUnreadMentions(server.id) }}
            </div>
          </div>
        </div>
      </div>
    </Transition>

  </div>

  <!-- Server context menu - teleported to body to avoid stacking context issues -->
  <Teleport to="body">
    <div 
      v-if="showServerMenu" 
      class="server-folder-context-menu context-menu"
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
  </Teleport>
  
  <!-- Server Tooltip - Teleported to body -->
  <Teleport to="body">
    <Transition name="tooltip-fade">
      <div 
        v-if="serverTooltip.visible"
        class="server-tooltip"
        :style="{ top: serverTooltip.y + 'px' }"
      >
        <span class="server-tooltip-name">{{ serverTooltip.name }}</span>
        <div class="server-tooltip-arrow"></div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import ServerIcon from '@/components/common/ServerIcon.vue';
import { getServerIconUrl } from '@/utils/serverUtils';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useNotificationStore } from '@/stores/useNotification';
import { useUnreadCounts } from '@/composables/useUnreadCounts';
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
  (e: 'show-folder-tooltip', event: MouseEvent, name: string, serverCount: number): void;
  (e: 'hide-folder-tooltip'): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const serverChannelStore = useServerChannelStore();
const notificationStore = useNotificationStore();
const { getServerUnreadMessages } = useUnreadCounts();

const isDraggingOver = ref(false);
const showServerMenu = ref(false);
const menuPosition = ref({ x: 0, y: 0 });
const selectedServerForMenu = ref<Server | null>(null);

// Drag reordering state within folder
const draggingServerIdInFolder = ref<string | null>(null);
const dropTargetServerId = ref<string | null>(null);
const dropPosition = ref<'before' | 'after'>('after');
const isExternalDragOver = ref(false); // Track when external server is being dragged over

// Tooltip state
const serverTooltip = ref<{
  visible: boolean;
  name: string;
  y: number;
}>({ visible: false, name: '', y: 0 });
const tooltipTimer = ref<ReturnType<typeof setTimeout> | null>(null);

// First 4 servers for the grid preview
const previewServers = computed(() => {
  return props.servers.slice(0, 4);
});

const folderHasNotifications = computed(() => {
  return props.servers.some(s => getServerUnreadMentions(s.id) > 0);
});

const isSelected = (serverId: string) => {
  return serverId === props.selectedServerId;
};

const getServerUnreadMentions = (serverId: string): number => {
  return notificationStore.unreadServerMentions(serverId);
};

const hasServerUnread = (serverId: string): boolean => {
  return getServerUnreadMessages(serverId) > 0 || getServerUnreadMentions(serverId) > 0;
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
  draggingServerIdInFolder.value = server.id;
};

const handleServerDragEnd = () => {
  draggingServerIdInFolder.value = null;
  dropTargetServerId.value = null;
};

const handleServerDragEnterItem = (event: DragEvent, server: Server) => {
  const isInternalDrag = draggingServerIdInFolder.value && draggingServerIdInFolder.value !== server.id;
  const hasExternalData = event.dataTransfer?.types.includes('text/plain') ?? false;
  const isExternal = !draggingServerIdInFolder.value && hasExternalData;
  
  if (isInternalDrag || isExternal) {
    dropTargetServerId.value = server.id;
    isExternalDragOver.value = !!isExternal;
    // Determine if drop should be before or after based on mouse position
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    dropPosition.value = event.clientY < midY ? 'before' : 'after';
  }
};

const handleServerDragOverItem = (event: DragEvent, server: Server) => {
  event.preventDefault();
  const isInternalDrag = draggingServerIdInFolder.value && draggingServerIdInFolder.value !== server.id;
  const hasExternalData = event.dataTransfer?.types.includes('text/plain') ?? false;
  const isExternal = !draggingServerIdInFolder.value && hasExternalData;
  
  if (isInternalDrag || isExternal) {
    dropTargetServerId.value = server.id;
    isExternalDragOver.value = !!isExternal;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    dropPosition.value = event.clientY < midY ? 'before' : 'after';
  }
};

const handleServerDragLeaveItem = (event: DragEvent) => {
  const relatedTarget = event.relatedTarget as HTMLElement;
  if (!relatedTarget || !event.currentTarget || !(event.currentTarget as HTMLElement).contains(relatedTarget)) {
    dropTargetServerId.value = null;
    isExternalDragOver.value = false;
  }
};

const handleServerDropOnItem = (event: DragEvent, targetServer: Server) => {
  event.preventDefault();
  event.stopPropagation();
  
  const externalServerId = event.dataTransfer?.getData('text/plain');
  const isFromOutside = externalServerId && !draggingServerIdInFolder.value;
  
  if (isFromOutside) {
    // Server from outside - add to folder
    isDraggingOver.value = false;
    isExternalDragOver.value = false;
    dropTargetServerId.value = null;
    emit('server-dropped', externalServerId, props.folder.id);
    return;
  }
  
  if (!draggingServerIdInFolder.value || draggingServerIdInFolder.value === targetServer.id) {
    dropTargetServerId.value = null;
    return;
  }
  
  // Reorder servers within the folder
  const draggedIndex = props.servers.findIndex(s => s.id === draggingServerIdInFolder.value);
  const targetIndex = props.servers.findIndex(s => s.id === targetServer.id);
  
  if (draggedIndex === -1 || targetIndex === -1) {
    dropTargetServerId.value = null;
    return;
  }
  
  const newServers = [...props.servers];
  const [draggedServer] = newServers.splice(draggedIndex, 1);
  
  let newIndex = targetIndex;
  if (dropPosition.value === 'after') {
    newIndex = draggedIndex < targetIndex ? targetIndex : targetIndex + 1;
  } else {
    newIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
  }
  
  newServers.splice(newIndex, 0, draggedServer);
  emit('servers-reordered', newServers);
  
  dropTargetServerId.value = null;
  draggingServerIdInFolder.value = null;
};

const handleServerClick = (serverId: string) => {
  emit('select-server', serverId);
};

// Tooltip handlers
const isTouchDevice = typeof window !== 'undefined' && 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches;

const showServerTooltip = (event: MouseEvent, name: string) => {
  if (isTouchDevice) return;
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  
  const target = event.currentTarget as HTMLElement;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  
  tooltipTimer.value = setTimeout(() => {
    serverTooltip.value = {
      visible: true,
      name: name || 'Unnamed Server',
      y
    };
  }, 400);
};

const hideServerTooltip = () => {
  if (tooltipTimer.value) {
    clearTimeout(tooltipTimer.value);
    tooltipTimer.value = null;
  }
  serverTooltip.value.visible = false;
};

watch(() => props.folder.is_expanded, (expanded) => {
  if (!expanded) hideServerTooltip();
});

onBeforeUnmount(() => {
  hideServerTooltip();
  hideFolderTooltip();
});

// Folder tooltip handlers (emit to parent)
const showFolderTooltip = (event: MouseEvent) => {
  if (isTouchDevice) return;
  emit('show-folder-tooltip', event, props.folder.name || 'Folder', props.servers.length);
};

const hideFolderTooltip = () => {
  emit('hide-folder-tooltip');
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
    
    const remainingServers = props.servers.filter(s => s.id !== selectedServerForMenu.value!.id);
    if (remainingServers.length === 0) {
      await serverChannelStore.deleteFolder(props.folder.id);
    }
  }
  closeServerMenu();
};

const onIconError = (event: Event) => {
  const img = event.target as HTMLImageElement;
  img.src = '/default_server.webp';
};
</script>

<style scoped>
.server-folder {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: 4px 0;
  --folder-color: #0EA5E9;
  position: relative;
}

/* Collapsed folder - 2x2 grid */
.folder-collapsed {
  width: 48px;
  height: 48px;
  background: color-mix(in srgb, var(--folder-color) 40%, var(--background-quaternary, var(--background-tertiary)));
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
  width: 20px; /* 100% */
  height: 20px; /* 100% */
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
  background: transparent;
}

.folder-indicator {
  height: 4px;
  width: 100%;
  flex-shrink: 0;
  background: var(--folder-color);
}

.folder-notification-dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #f04747;
  border: 2px solid var(--background-tertiary, #1e1f22);
  z-index: 2;
  pointer-events: none;
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
  /* outline: 2px solid  color-mix(in srgb, var(--folder-color) 30%, transparent); */
  outline: 2px solid transparent;
  outline-offset: -2px;
}

.folder-expanded:hover {
  outline: 2px solid var(--folder-color);
}
.folder-expanded:hover .folder-cap {
  background: var(--folder-color);
  filter: brightness(1.1);
}

.folder-cap {
  width: 56px;
  /* background: var(--folder-color); */
  background: transparent;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
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
  color: var(--text-primary);
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
  transition: opacity 0.15s ease;
  padding: 2px 0;
}

/* Dragging state - ghost/transparent appearance */
.folder-server-item.is-dragging {
  opacity: 0.3;
}

.folder-server-item.is-dragging .server-item {
  outline: 2px dashed rgba(255, 255, 255, 0.4);
  outline-offset: 2px;
}

/* Drop indicator - green bar */
.folder-server-item.drop-target-before::before,
.folder-server-item.drop-target-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 4px;
  background: #3ba55d;
  border-radius: 2px;
  z-index: 10;
  box-shadow: 0 0 8px rgba(59, 165, 93, 0.8), 0 0 16px rgba(59, 165, 93, 0.4);
}

.folder-server-item.drop-target-before::before {
  top: -3px;
}

.folder-server-item.drop-target-after::after {
  bottom: -3px;
}

/* Server item styles */
.server-item {
  cursor: pointer;
  transition: transform 0.2s ease-in-out;
  user-select: none;
}

.server-item:hover {
  transform: translateX(5px);
}

.server-item.selected {
  border: 2px solid var(--harmony-secondary);
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
  color: var(--text-primary);
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

.server-pill {
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 0;
  background: #ffffff;
  border-radius: 0 4px 4px 0;
  opacity: 0;
  transition: all 0.15s ease;
}

.server-pill.visible {
  opacity: 1;
  height: 36px;
}

.server-pill.has-unread {
  opacity: 1;
  height: 8px;
}

.folder-server-item:hover .server-pill {
  opacity: 1;
  height: 20px;
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


/* Drag over expanded folder */
.folder-expanded.is-drag-target {
  outline: 2px solid var(--folder-color);
  filter: brightness(1.2);
}

/* Expand/Collapse animations - simple and clean */
.folder-expand-enter-active {
  transition: all 0.2s ease-out;
  overflow: hidden;
}

.folder-expand-leave-active {
  transition: all 0.15s ease-in;
  overflow: hidden;
  position: absolute;
}

.folder-expand-enter-from,
.folder-expand-leave-to {
  opacity: 0;
  max-height: 0;
}

.folder-expand-enter-to,
.folder-expand-leave-from {
  opacity: 1;
  max-height: 500px;
}

.folder-collapse-enter-active {
  transition: all 0.15s ease-out;
}

.folder-collapse-leave-active {
  transition: all 0.1s ease-in;
  position: absolute;
}

.folder-collapse-enter-from,
.folder-collapse-leave-to {
  opacity: 0;
}

.folder-collapse-enter-to,
.folder-collapse-leave-from {
  opacity: 1;
}

/* Server Tooltip */
.server-tooltip {
  position: fixed;
  left: 80px;
  transform: translateY(-50%);
  background: var(--tooltip-bg, #18191c);
  border-radius: 8px;
  padding: 10px 14px;
  box-shadow: var(--shadow-small);
  z-index: 1001;
  pointer-events: none;
  white-space: nowrap;
}

.server-tooltip-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--tooltip-text, var(--text-primary));
}

.server-tooltip-arrow {
  position: absolute;
  left: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-right: 6px solid var(--tooltip-arrow, #18191c);
}

/* Tooltip animation */
.tooltip-fade-enter-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.tooltip-fade-leave-active {
  transition: opacity 0.1s ease, transform 0.1s ease;
}

.tooltip-fade-enter-from {
  opacity: 0;
  transform: translateY(-50%) translateX(-5px);
}

.tooltip-fade-leave-to {
  opacity: 0;
  transform: translateY(-50%) translateX(-5px);
}

.tooltip-fade-enter-to,
.tooltip-fade-leave-from {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}
</style>

<!-- Non-scoped styles for teleported elements -->
<style>
.server-folder-context-menu.context-menu {
  position: fixed;
  background: #18191c;
  border: 1px solid var(--background-quinary);
  border-radius: 6px;
  padding: 6px 0;
  min-width: 180px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 10001;
}

.server-folder-context-menu .context-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  color: var(--text-secondary, #b9bbbe);
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.1s ease;
}

.server-folder-context-menu .context-menu-item:hover {
  background-color: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary);
}

.server-tooltip {
  position: fixed;
  left: 80px;
  transform: translateY(-50%);
  background: var(--tooltip-bg, #18191c);
  border-radius: 8px;
  padding: 10px 14px;
  box-shadow: var(--shadow-small);
  z-index: 10001;
  pointer-events: none;
  white-space: nowrap;
}

.server-tooltip-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--tooltip-text, var(--text-primary));
}

.server-tooltip-arrow {
  position: absolute;
  left: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-right: 6px solid var(--tooltip-arrow, #18191c);
}
</style>
