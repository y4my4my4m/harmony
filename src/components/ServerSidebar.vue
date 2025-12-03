<template>
  <div class="server-sidebar">
    <!-- Fixed header section - never scrolls -->
    <div class="fixed-header">
      <div
        :style="{ backgroundImage: 'url(/icon16.png)', margin: '8px' }"
        class="portal"
        @click="togglePublicServers"
        @mouseenter="showSidebarTooltip($event, 'Harmony Portal')"
        @mouseleave="hideSidebarTooltip"
      >
      </div>
      <!-- DM Button at the top -->
      <div
        class="dm-button"
        :class="{ 'selected': isDMSelected }"
        @click="goToDMs"
        @mouseenter="showSidebarTooltip($event, 'Direct Messages')"
        @mouseleave="hideSidebarTooltip"
      >
        <svg viewBox="0 0 24 24" class="dm-icon">
          <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M4,4H20V16H5.17L4,17.17V4Z" fill="currentColor"/>
        </svg>
        <div v-if="dmUnreadMentions > 0" class="unread-badge">
          {{ dmUnreadMentions > 99 ? '99+' : dmUnreadMentions }}
        </div>
      </div>

      <!-- Monyverse Button -->
      <div
        class="monyverse-button"
        :class="{ 'selected': isMonyverseSelected }"
        @click="goToMonyverse"
        @mouseenter="showSidebarTooltip($event, 'Monyverse')"
        @mouseleave="hideSidebarTooltip"
      >
        <div class="monyverse-icon">#</div>
        <div v-if="unreadCount > 0" class="unread-badge">
          {{ unreadCount > 99 ? '99+' : unreadCount }}
        </div>
      </div>

      <div class="separator"></div>
    </div>

    <!-- Scrollable servers section -->
    <div 
      class="servers-scroll-area"
      :class="{ 'drag-over-bottom': isDraggingOverBottom }"
      @dragover.prevent="handleScrollAreaDragOver"
      @dragleave.prevent="handleScrollAreaDragLeave"
      @drop.prevent="handleDropOnScrollArea"
    >
      <!-- Combined folders and servers, sorted by position -->
      <template v-for="item in sortedSidebarItems" :key="item.id">
        <!-- Folder -->
        <div
          v-if="isFolder(item)"
          class="sidebar-item-wrapper folder-wrapper"
          :class="{
            'is-dragging': draggingItemId === item.id,
            'drop-target-before': dragOverItemId === item.id && dropPosition === 'before',
            'drop-target-after': dragOverItemId === item.id && dropPosition === 'after'
          }"
          draggable="true"
          @dragstart.stop="handleFolderDragStart($event, item)"
          @dragend="handleItemDragEnd"
        >
          <ServerFolder
            :folder="item"
            :servers="getFolderServers(item.id)"
            :selected-server-id="serverChannelStore.currentServerId"
            @select-server="selectServer"
            @open-context-menu="openFolderContextMenu"
            @servers-reordered="handleFolderServersReorder(item.id, $event)"
            @server-dropped="handleServerDroppedOnFolder"
            @server-removed="handleServerRemovedFromFolder"
            @show-folder-tooltip="showSidebarTooltip"
            @hide-folder-tooltip="hideSidebarTooltip"
          />
          <!-- Invisible drop zones for reordering folders -->
          <div 
            class="folder-drop-zone folder-drop-zone-top"
            @dragenter.prevent="handleItemDragEnter($event, item)"
            @dragover.prevent="handleFolderDropZoneOver($event, item, 'before')"
            @dragleave.prevent="handleItemDragLeave"
            @drop.prevent="handleItemDrop($event, item)"
          ></div>
          <div 
            class="folder-drop-zone folder-drop-zone-bottom"
            @dragenter.prevent="handleItemDragEnter($event, item)"
            @dragover.prevent="handleFolderDropZoneOver($event, item, 'after')"
            @dragleave.prevent="handleItemDragLeave"
            @drop.prevent="handleItemDrop($event, item)"
          ></div>
        </div>

        <!-- Root-level server -->
        <div
          v-else
          class="sidebar-item-wrapper server-item-wrapper"
          :class="{ 
            'drop-target-into': dragOverItemId === item.id && dropPosition === 'into' && draggingItemType === 'server',
            'drop-target-before': dragOverItemId === item.id && dropPosition === 'before',
            'drop-target-after': dragOverItemId === item.id && dropPosition === 'after',
            'is-dragging': draggingItemId === item.id
          }"
          draggable="true"
          @dragstart="handleServerDragStart($event, item)"
          @dragend="handleItemDragEnd"
          @dragenter.prevent="handleItemDragEnter($event, item)"
          @dragover.prevent="handleItemDragOver($event, item)"
          @dragleave.prevent="handleItemDragLeave"
          @drop.prevent="handleItemDrop($event, item)"
          @click.stop="selectServer(item.id)"
          @contextmenu.prevent="openServerContextMenu($event, item)"
          @mouseenter="showSidebarTooltip($event, item.name)"
          @mouseleave="hideSidebarTooltip"
        >
          <ServerIcon
            :id="item.id"
            :src="item.icon"
            :alt="item.name"
            size="md"
            class="server-item"
            :class="{ selected: isSelected(item.id) }"
            shape="round"
            :interactive="true"
            :show-title="false"
          />
          <div v-if="getServerUnreadMentions(item.id) > 0" class="unread-badge">
            {{ getServerUnreadMentions(item.id) > 99 ? '99+' : getServerUnreadMentions(item.id) }}
          </div>
          <!-- Folder creation indicator -->
          <div v-if="dragOverItemId === item.id && dropPosition === 'into' && draggingItemType === 'server'" class="folder-create-indicator">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/>
            </svg>
          </div>
        </div>
      </template>
      
      <!-- Bottom drop indicator -->
      <div v-if="isDraggingOverBottom" class="bottom-drop-indicator"></div>
    </div>

    <!-- Folder Context Menu -->
    <ServerFolderContextMenu
      :is-visible="showFolderContextMenu"
      :position="contextMenuPosition"
      :folder="selectedFolder"
      :servers="selectedFolder ? getFolderServers(selectedFolder.id) : []"
      @close="closeFolderContextMenu"
      @edit-folder="openEditFolderModal"
      @delete-folder="handleDeleteFolder"
      @toggle-expanded="handleToggleFolderExpanded"
      @mark-as-read="handleMarkFolderAsRead"
    />

    <!-- Server Context Menu (for creating folder from server) -->
    <div 
      v-if="showServerContextMenu" 
      class="context-menu"
      :style="{ top: contextMenuPosition.y + 'px', left: contextMenuPosition.x + 'px' }"
      @click.stop
      v-click-outside="closeServerContextMenu"
    >
      <div class="context-menu-item" @click="createFolderFromServer">
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="currentColor" d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/>
        </svg>
        <span>Create Folder</span>
      </div>
      <template v-if="serverChannelStore.folders.length > 0">
        <div class="context-menu-divider"></div>
        <div class="context-menu-label">Move to Folder</div>
        <div 
          v-for="folder in serverChannelStore.folders" 
          :key="folder.id"
          class="context-menu-item"
          @click="moveServerToFolder(folder.id)"
        >
          <div class="folder-color-dot" :style="{ backgroundColor: folder.color }"></div>
          <span>{{ folder.name }}</span>
        </div>
      </template>
      <template v-if="selectedServer?.folder_id">
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" @click="removeServerFromFolder">
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
          </svg>
          <span>Remove from Folder</span>
        </div>
      </template>
    </div>

    <!-- Folder Settings Modal -->
    <ServerFolderSettingsModal
      :is-open="showFolderModal"
      :folder="editingFolder"
      @close="closeFolderModal"
      @saved="handleFolderSaved"
    />
  </div>
  
  <!-- Sidebar Tooltip - Teleported to body to avoid overflow clipping -->
  <Teleport to="body">
    <Transition name="tooltip-fade">
      <div 
        v-if="sidebarTooltip.visible"
        class="sidebar-tooltip"
        :style="{ top: sidebarTooltip.y + 'px' }"
      >
        <div class="sidebar-tooltip-content">
          <span class="sidebar-tooltip-name">{{ sidebarTooltip.name }}</span>
          <span v-if="sidebarTooltip.serverCount" class="sidebar-tooltip-count">
            {{ sidebarTooltip.serverCount }} server{{ sidebarTooltip.serverCount !== 1 ? 's' : '' }}
          </span>
        </div>
        <div class="sidebar-tooltip-arrow"></div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useNotificationStore } from '@/stores/useNotification';
import { isActivityPubRoute } from '@/types/viewTypes';
import ServerIcon from '@/components/common/ServerIcon.vue';
import ServerFolder from '@/components/ServerFolder.vue';
import ServerFolderContextMenu from '@/components/ServerFolderContextMenu.vue';
import ServerFolderSettingsModal from '@/components/ServerFolderSettingsModal.vue';
import type { Server, ServerFolder as ServerFolderType } from '@/types';

// Define Props
const props = defineProps<{
  servers: Server[];
}>();

// Define Emits for type safety
const emit = defineEmits<{
  (e: 'show-public-servers', value: boolean): void;
  (e: 'switch-to-activitypub'): void;
  (e: 'switch-to-chat'): void;
}>();

// Reactive state
const showPublicServers = ref(false);

// Drag state for reordering and creating folders
const draggingItemId = ref<string | null>(null);
const draggingItemType = ref<'server' | 'folder' | null>(null);
const dragOverItemId = ref<string | null>(null);
const dropPosition = ref<'before' | 'after' | 'into'>('after');
const folderWasExpanded = ref<boolean>(false); // Track if folder was expanded before drag
const isDraggingOverBottom = ref(false); // Track when dragging over empty bottom area

// Tooltip state
const sidebarTooltip = ref<{
  visible: boolean;
  name: string;
  y: number;
  serverCount?: number;
}>({ visible: false, name: '', y: 0 });
const tooltipTimer = ref<ReturnType<typeof setTimeout> | null>(null);

// Legacy refs for backwards compatibility
const draggingServerId = computed(() => draggingItemType.value === 'server' ? draggingItemId.value : null);
const dragOverServerId = computed(() => dropPosition.value === 'into' ? dragOverItemId.value : null);

// Context menu state
const showFolderContextMenu = ref(false);
const showServerContextMenu = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const selectedFolder = ref<ServerFolderType | null>(null);
const selectedServer = ref<Server | null>(null);

// Folder modal state
const showFolderModal = ref(false);
const editingFolder = ref<ServerFolderType | null>(null);

// Composables and Stores
const serverChannelStore = useServerChannelStore();
const activityPubStore = useActivityPubStore();
const notificationStore = useNotificationStore();
const router = useRouter();
const route = useRoute();

// Combined and sorted sidebar items (folders and root servers interleaved by position)
const sortedSidebarItems = computed(() => {
  const folders = serverChannelStore.folders.map(f => ({ ...f, _type: 'folder' as const }));
  const rootServers = props.servers
    .filter(s => !s.folder_id)
    .map(s => ({ ...s, _type: 'server' as const }));
  
  // Combine and sort by position
  return [...folders, ...rootServers].sort((a, b) => (a.position || 0) - (b.position || 0));
});

// Computed properties
const isDMSelected = computed(() => {
  return route.name === 'DM' || route.name === 'DMHome' || route.name === 'DMConversation';
});

const isMonyverseSelected = computed(() => {
  return isActivityPubRoute(route.name as string);
});

const unreadCount = computed(() => {
  return notificationStore.notifications.filter(
    n => !n.is_read && n.type.startsWith('activitypub_')
  ).length;
});

const dmUnreadMentions = computed(() => {
  return notificationStore.unreadDMs;
});

// Methods
const isFolder = (item: ServerFolderType | Server): item is ServerFolderType => {
  return 'is_expanded' in item;
};

const getFolderServers = (folderId: string): Server[] => {
  return props.servers
    .filter(s => s.folder_id === folderId)
    .sort((a, b) => (a.position || 0) - (b.position || 0));
};

const getServerUnreadMentions = (serverId: string): number => {
  return notificationStore.unreadServerMentions(serverId);
};

const isSelected = (serverId: string) => {
  return serverId === serverChannelStore.currentServerId && !isDMSelected.value && !isMonyverseSelected.value;
};

// Watchers
watch(showPublicServers, (value) => {
  if (value) {
    emit('show-public-servers', value);
  }
});

// Navigation methods
const togglePublicServers = () => {
  showPublicServers.value = !showPublicServers.value;
};

const selectServer = async (serverId?: string) => {
  if (!serverId) return;
  
  emit('switch-to-chat');
  
  serverChannelStore.setCurrentServer(serverId);
  await serverChannelStore.fetchCategoriesAndChannels(serverId);
  
  const defaultChannelId = serverChannelStore.getDefaultChannel();
  
  if (defaultChannelId) {
    router.push({ 
      name: 'ChatChannel', 
      params: { 
        serverId: serverId, 
        channelId: defaultChannelId 
      } 
    });
  } else {
    router.push({ name: 'Chat' });
  }
};

const goToDMs = () => {
  emit('switch-to-chat');
  router.push({ name: 'DMHome' });
};

const goToMonyverse = () => {
  activityPubStore.clearUnreadCount();
  emit('switch-to-activitypub');
  router.push({ name: 'SocialHome' });
};

// Drag and drop handlers for reordering and creating folders
const handleServerDragStart = (event: DragEvent, server: Server) => {
  draggingItemId.value = server.id;
  draggingItemType.value = 'server';
  event.dataTransfer?.setData('text/plain', server.id);
  event.dataTransfer?.setData('application/x-item-type', 'server');
  event.dataTransfer!.effectAllowed = 'move';
};

const handleFolderDragStart = (event: DragEvent, folder: ServerFolderType) => {
  const target = event.target as HTMLElement;
  
  // Only handle if drag started on folder UI elements, not on servers inside
  // Check if drag started on a server item inside the folder
  if (target.closest('.folder-server-item') || target.closest('.server-item')) {
    // Let the server handle its own drag
    return;
  }
  
  draggingItemId.value = folder.id;
  draggingItemType.value = 'folder';
  folderWasExpanded.value = folder.is_expanded;
  
  // Collapse folder while dragging
  if (folder.is_expanded) {
    serverChannelStore.toggleFolderExpanded(folder.id);
  }
  
  event.dataTransfer?.setData('text/plain', folder.id);
  event.dataTransfer?.setData('application/x-item-type', 'folder');
  event.dataTransfer!.effectAllowed = 'move';
};

const handleItemDragEnd = () => {
  // Only handle if we were dragging something from this sidebar (not from inside a folder)
  if (!draggingItemId.value) {
    return;
  }
  
  // Re-expand folder if it was expanded before drag
  if (draggingItemType.value === 'folder' && folderWasExpanded.value) {
    const folder = serverChannelStore.folders.find(f => f.id === draggingItemId.value);
    if (folder && !folder.is_expanded) {
      serverChannelStore.toggleFolderExpanded(folder.id);
    }
  }
  
  draggingItemId.value = null;
  draggingItemType.value = null;
  dragOverItemId.value = null;
  folderWasExpanded.value = false;
};

const handleItemDragEnter = (event: DragEvent, item: Server | ServerFolderType) => {
  // Handle both root-level drags and drags from inside folders
  const isDraggingFromFolder = event.dataTransfer?.types.includes('application/x-from-folder');
  const isDragging = draggingItemId.value || isDraggingFromFolder;
  
  if (isDragging && draggingItemId.value !== item.id) {
    dragOverItemId.value = item.id;
    isDraggingOverBottom.value = false; // Clear bottom indicator when over an item
    updateDropPosition(event, item, isDraggingFromFolder);
  }
};

const handleItemDragOver = (event: DragEvent, item: Server | ServerFolderType) => {
  // Handle both root-level drags and drags from inside folders
  const isDraggingFromFolder = event.dataTransfer?.types.includes('application/x-from-folder');
  const isDragging = draggingItemId.value || isDraggingFromFolder;
  
  if (isDragging && draggingItemId.value !== item.id) {
    isDraggingOverBottom.value = false; // Clear bottom indicator when over an item
    updateDropPosition(event, item, isDraggingFromFolder);
  }
};

const handleFolderDropZoneOver = (event: DragEvent, item: ServerFolderType, position: 'before' | 'after') => {
  event.preventDefault();
  if (draggingItemId.value && draggingItemId.value !== item.id) {
    dragOverItemId.value = item.id;
    dropPosition.value = position;
  }
};

const updateDropPosition = (event: DragEvent, item: Server | ServerFolderType, isDraggingFromFolder: boolean = false) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const relativeY = event.clientY - rect.top;
  const height = rect.height;
  
  // Servers from folders or root servers being dragged over servers can create folders
  const canCreateFolder = (draggingItemType.value === 'server' || isDraggingFromFolder) && !isFolder(item);
  
  if (canCreateFolder) {
    if (relativeY < height * 0.25) {
      dropPosition.value = 'before';
    } else if (relativeY > height * 0.75) {
      dropPosition.value = 'after';
    } else {
      dropPosition.value = 'into'; // Create folder
    }
  } else {
    // For folders or folder being dragged, just before/after
    dropPosition.value = relativeY < height / 2 ? 'before' : 'after';
  }
};

const handleItemDragLeave = (event: DragEvent) => {
  const relatedTarget = event.relatedTarget as HTMLElement;
  if (!relatedTarget || !event.currentTarget || !(event.currentTarget as HTMLElement).contains(relatedTarget)) {
    dragOverItemId.value = null;
  }
};

const handleItemDrop = async (event: DragEvent, targetItem: Server | ServerFolderType) => {
  event.stopPropagation();
  
  // Get dragged item info from either state or dataTransfer
  const draggedId = draggingItemId.value || event.dataTransfer?.getData('text/plain');
  const fromFolderId = event.dataTransfer?.getData('application/x-from-folder');
  const isDraggingFromFolder = !!fromFolderId;
  
  if (!draggedId || draggedId === targetItem.id) {
    resetDragState();
    return;
  }

  const targetIsFolder = isFolder(targetItem);
  
  // Handle server from folder being dropped
  if (isDraggingFromFolder) {
    const serversInFolder = props.servers.filter(s => s.folder_id === fromFolderId);
    
    // If dropping into center of a server, create folder
    if (!targetIsFolder && dropPosition.value === 'into') {
      // First move to root, then create folder
      await serverChannelStore.moveServerToFolder(draggedId, null);
      if (serversInFolder.length <= 1) {
        await serverChannelStore.deleteFolder(fromFolderId);
      }
      const targetServer = targetItem as Server;
      await createFolderFromServers(draggedId, targetServer.id, targetServer.position || 0);
      resetDragState();
      return;
    }
    
    // Calculate target position first
    const items = sortedSidebarItems.value;
    let targetPosition: number;
    
    if (dropPosition.value === 'before') {
      targetPosition = targetItem.position || 0;
    } else {
      targetPosition = (targetItem.position || 0) + 1;
    }
    
    // Shift existing items to make room
    const serverUpdates: { serverId: string; folderId: string | null; position: number }[] = [];
    const folderUpdates: { folderId: string; position: number }[] = [];
    
    items.forEach((item) => {
      const itemPosition = item.position || 0;
      if (itemPosition >= targetPosition) {
        if (isFolder(item)) {
          folderUpdates.push({ folderId: item.id, position: itemPosition + 1 });
        } else {
          serverUpdates.push({ serverId: (item as Server).id, folderId: null, position: itemPosition + 1 });
        }
      }
    });
    
    // Add the dragged server at the target position
    serverUpdates.push({ serverId: draggedId, folderId: null, position: targetPosition });
    
    // Apply all updates
    if (serverUpdates.length > 0) {
      await serverChannelStore.updateServerPositions(serverUpdates);
    }
    if (folderUpdates.length > 0) {
      await serverChannelStore.updateFolderPositions(folderUpdates);
    }
    
    // Delete empty folder
    if (serversInFolder.length <= 1) {
      await serverChannelStore.deleteFolder(fromFolderId);
    }
    
    resetDragState();
    return;
  }
  
  // Handle creating a folder when dropping server onto server (center zone)
  if (draggingItemType.value === 'server' && !targetIsFolder && dropPosition.value === 'into') {
    const targetServer = targetItem as Server;
    await createFolderFromServers(draggingItemId.value!, targetServer.id, targetServer.position || 0);
    resetDragState();
    return;
  }
  
  // Handle reordering root-level items
  await reorderItems(draggingItemId.value!, draggingItemType.value!, targetItem.id, targetIsFolder, dropPosition.value);
  resetDragState();
};

const createFolderFromServers = async (draggedServerId: string, targetServerId: string, position: number) => {
  const folder = await serverChannelStore.createFolder('', '#5865f2', position);
  if (folder) {
    await serverChannelStore.moveServerToFolder(draggedServerId, folder.id);
    await serverChannelStore.moveServerToFolder(targetServerId, folder.id);
  }
};

const reorderItems = async (
  draggedId: string, 
  draggedType: 'server' | 'folder', 
  targetId: string, 
  targetIsFolder: boolean,
  position: 'before' | 'after' | 'into'
) => {
  // Get current list
  const items = sortedSidebarItems.value;
  const draggedIndex = items.findIndex(i => i.id === draggedId);
  const targetIndex = items.findIndex(i => i.id === targetId);
  
  if (draggedIndex === -1 || targetIndex === -1) return;
  
  // Calculate new position
  let newPosition: number;
  if (position === 'before') {
    newPosition = targetIndex <= draggedIndex ? targetIndex : targetIndex - 1;
  } else {
    newPosition = targetIndex >= draggedIndex ? targetIndex : targetIndex + 1;
  }
  
  // Create new order
  const newItems = [...items];
  const [draggedItem] = newItems.splice(draggedIndex, 1);
  newItems.splice(newPosition, 0, draggedItem);
  
  // Update positions in database
  const serverUpdates: { serverId: string; folderId: string | null; position: number }[] = [];
  const folderUpdates: { folderId: string; position: number }[] = [];
  
  newItems.forEach((item, index) => {
    if (isFolder(item)) {
      folderUpdates.push({ folderId: item.id, position: index });
    } else {
      serverUpdates.push({ serverId: (item as Server).id, folderId: null, position: index });
    }
  });
  
  if (serverUpdates.length > 0) {
    await serverChannelStore.updateServerPositions(serverUpdates);
  }
  if (folderUpdates.length > 0) {
    await serverChannelStore.updateFolderPositions(folderUpdates);
  }
};

const resetDragState = () => {
  draggingItemId.value = null;
  draggingItemType.value = null;
  dragOverItemId.value = null;
  folderWasExpanded.value = false;
  isDraggingOverBottom.value = false;
};

// Tooltip handlers
const showSidebarTooltip = (event: MouseEvent, name: string, serverCount?: number) => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  
  // Capture rect immediately before it becomes null in the timeout
  const target = event.currentTarget as HTMLElement;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  
  tooltipTimer.value = setTimeout(() => {
    sidebarTooltip.value = {
      visible: true,
      name: name || 'Unnamed',
      y,
      serverCount
    };
  }, 400);
};

const hideSidebarTooltip = () => {
  if (tooltipTimer.value) {
    clearTimeout(tooltipTimer.value);
    tooltipTimer.value = null;
  }
  sidebarTooltip.value.visible = false;
};

const handleScrollAreaDragOver = (event: DragEvent) => {
  // Check if we're over an item, folder content, or the empty bottom area
  const target = event.target as HTMLElement;
  const isOverItem = target.closest('.sidebar-item-wrapper') || 
                     target.closest('.folder-expanded') || 
                     target.closest('.folder-collapsed') ||
                     target.closest('.server-folder');
  
  // Check if something is being dragged (either from root or from a folder)
  const isDragging = draggingItemId.value || event.dataTransfer?.types.includes('text/plain');
  
  if (!isOverItem && isDragging) {
    isDraggingOverBottom.value = true;
    dragOverItemId.value = null; // Clear item hover
  } else {
    isDraggingOverBottom.value = false;
  }
};

const handleScrollAreaDragLeave = (event: DragEvent) => {
  const relatedTarget = event.relatedTarget as HTMLElement;
  if (!relatedTarget || !event.currentTarget || !(event.currentTarget as HTMLElement).contains(relatedTarget)) {
    isDraggingOverBottom.value = false;
  }
};

const handleFolderServersReorder = (folderId: string, servers: Server[]) => {
  const positions = servers.map((s, index) => ({
    serverId: s.id,
    folderId: folderId,
    position: index
  }));
  serverChannelStore.updateServerPositions(positions);
};

const handleServerDroppedOnFolder = (serverId: string, folderId: string) => {
  serverChannelStore.moveServerToFolder(serverId, folderId);
};

const handleServerRemovedFromFolder = (serverId: string) => {
  // Server was removed from folder via context menu - already handled in ServerFolder
};

const handleDropOnScrollArea = async (event: DragEvent) => {
  // If we dropped on an item or folder, don't handle here
  const target = event.target as HTMLElement;
  const isOverItem = target.closest('.sidebar-item-wrapper') || 
                     target.closest('.folder-expanded') || 
                     target.closest('.folder-collapsed') ||
                     target.closest('.server-folder');
  if (isOverItem) {
    return;
  }
  
  const itemId = event.dataTransfer?.getData('text/plain');
  const fromFolderId = event.dataTransfer?.getData('application/x-from-folder');
  
  if (!itemId) {
    resetDragState();
    return;
  }
  
  // Get the highest position to place item at the end
  const maxPosition = Math.max(
    ...sortedSidebarItems.value.map(i => i.position || 0),
    0
  ) + 1;
  
  // Handle server dragged from a folder
  if (fromFolderId) {
    const serversInFolder = props.servers.filter(s => s.folder_id === fromFolderId);
    
    // Remove from folder and place at end
    await serverChannelStore.moveServerToFolder(itemId, null);
    await serverChannelStore.updateServerPositions([{
      serverId: itemId,
      folderId: null,
      position: maxPosition
    }]);
    
    // If folder is now empty, delete it
    if (serversInFolder.length <= 1) {
      await serverChannelStore.deleteFolder(fromFolderId);
    }
  } else if (draggingItemId.value) {
    // Move existing item to the end
    if (draggingItemType.value === 'folder') {
      await serverChannelStore.updateFolderPositions([{
        folderId: itemId,
        position: maxPosition
      }]);
    } else {
      await serverChannelStore.updateServerPositions([{
        serverId: itemId,
        folderId: null,
        position: maxPosition
      }]);
    }
  }
  
  resetDragState();
};

// Context menu handlers
const openFolderContextMenu = (event: MouseEvent, folder: ServerFolderType) => {
  closeServerContextMenu();
  selectedFolder.value = folder;
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
  showFolderContextMenu.value = true;
};

const closeFolderContextMenu = () => {
  showFolderContextMenu.value = false;
  selectedFolder.value = null;
};

const openServerContextMenu = (event: MouseEvent, server: Server) => {
  closeFolderContextMenu();
  selectedServer.value = server;
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
  showServerContextMenu.value = true;
};

const closeServerContextMenu = () => {
  showServerContextMenu.value = false;
  selectedServer.value = null;
};

// Folder actions
const openEditFolderModal = (folder: ServerFolderType) => {
  editingFolder.value = folder;
  showFolderModal.value = true;
  closeFolderContextMenu();
};

const closeFolderModal = () => {
  showFolderModal.value = false;
  editingFolder.value = null;
};

const handleFolderSaved = (folder: ServerFolderType) => {
  // Folder saved - state is updated in store
};

const handleDeleteFolder = async (folder: ServerFolderType) => {
  await serverChannelStore.deleteFolder(folder.id);
  closeFolderContextMenu();
};

const handleToggleFolderExpanded = (folder: ServerFolderType) => {
  serverChannelStore.toggleFolderExpanded(folder.id);
};

const handleMarkFolderAsRead = (folder: ServerFolderType) => {
  // TODO: Implement mark as read for all servers in folder
  closeFolderContextMenu();
};

// Server context menu actions
const createFolderFromServer = async () => {
  if (!selectedServer.value) return;
  
  // Create a new folder at the server's position (empty name by default)
  const folderPosition = selectedServer.value.position || 0;
  const folder = await serverChannelStore.createFolder('', '#5865f2', folderPosition);
  if (folder) {
    // Move the server to the new folder
    await serverChannelStore.moveServerToFolder(selectedServer.value.id, folder.id);
  }
  
  closeServerContextMenu();
};

const moveServerToFolder = async (folderId: string) => {
  if (!selectedServer.value) return;
  await serverChannelStore.moveServerToFolder(selectedServer.value.id, folderId);
  closeServerContextMenu();
};

const removeServerFromFolder = async () => {
  if (!selectedServer.value) return;
  await serverChannelStore.moveServerToFolder(selectedServer.value.id, null);
  closeServerContextMenu();
};
</script>

<style scoped>
.server-sidebar {
  width: 72px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* Fixed header section */
.fixed-header {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

/* Scrollable servers section */
.servers-scroll-area {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 0; /* Allow flex item to shrink below content size */
  
  /* Hide scrollbar */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

/* Large drop zone at the bottom */
.servers-scroll-area::after {
  content: '';
  display: block;
  width: 100%;
  min-height: 200px;
  flex-shrink: 0;
}

/* Bottom drop indicator - green bar */
.bottom-drop-indicator {
  width: calc(100% - 16px);
  height: 4px;
  background: #3ba55d;
  border-radius: 2px;
  margin: 8px auto;
  box-shadow: 0 0 8px rgba(59, 165, 93, 0.8), 0 0 16px rgba(59, 165, 93, 0.4);
  flex-shrink: 0;
}


.servers-scroll-area::-webkit-scrollbar {
  display: none;
}

.servers-draggable {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

/* DM Button */
.dm-button {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  margin: 10px;
  padding: 4px;
  border-radius: 50%;
  text-align: center;
  vertical-align: middle;
  cursor: pointer;
  position: relative;
  left: 0;
  transition: border 0.6s ease-in-out, all 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}

.dm-icon {
  width: 24px;
  height: 24px;
  transition: color 0.2s ease;
}

.dm-button:hover .dm-icon {
  color: #ffffff;
}

.dm-button.selected {
  background: var(--harmony-primary, --harmony-primary-hover);
  border-radius: 50%;
}

.dm-button.selected .dm-icon {
  color: #ffffff;
}

/* Monyverse Button */
.monyverse-button {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  margin: 10px;
  padding: 4px;
  border-radius: 12px;
  text-align: center;
  vertical-align: middle;
  cursor: pointer;
  position: relative;
  left: 0;
  transition: border 0.6s ease-in-out, all 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
}

.monyverse-icon {
  font-size: 24px;
  font-weight: bold;
  color: #ffffff;
  font-family: 'Inter', sans-serif;
  transition: transform 0.2s ease;
}

.monyverse-button:hover {
  left: 5px;
  transform: scale(1.05);
}

.monyverse-button.selected {
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  border: 3px solid var(--h-primary);
  border-radius: 50%;
}

/* Unread badge */
.unread-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: #f04747;
  color: white;
  font-size: 10px;
  font-weight: bold;
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); }
}

/* Server item */
.sidebar-item-wrapper {
  position: relative;
  margin: 4px 0;
  padding: 2px 0;
}

.sidebar-item-wrapper.is-dragging {
  opacity: 0.3;
}

/* Drop position indicators - green bar */
.sidebar-item-wrapper.drop-target-before::before,
.sidebar-item-wrapper.drop-target-after::after {
  content: '';
  position: absolute;
  left: -8px;
  right: -8px;
  height: 4px;
  background: #3ba55d;
  border-radius: 2px;
  z-index: 10;
  box-shadow: 0 0 3px rgba(59, 165, 93, 0.8), 0 0 8px rgba(59, 165, 93, 0.4);
}

.sidebar-item-wrapper.drop-target-before::before {
  top: -4px;
}

.sidebar-item-wrapper.drop-target-after::after {
  bottom: -4px;
}

.server-item-wrapper {
  position: relative;
  margin: 10px;
}

.portal,
.server-item {
  width: 48px;
  height: 48px;
  background-color: var(--h-black-light);
  margin: 0;
  border-radius: 50%;
  cursor: pointer;
  position: relative;
  left: 0;
  transition: border 0.6s ease-in-out, all 0.2s ease-in-out;
  background-origin: content-box;
  background-position: center;
  background-size: cover;
}

.portal {
  border-radius: 12px;
}

.separator {
  position: relative;
  width: 80%;
  border-top: 1px solid var(--border-secondary);
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 5px;
}

.dm-button:hover,
.monyverse-button:hover,
.portal:hover,
.server-item:hover {
  left: 5px;
}

.dm-button::before,
.monyverse-button::before,
.portal::before,
.server-item::before {
  opacity: 0;
  content: "";
  position: absolute;
  transition: all 0.2s ease-in-out;
  left: -25px;
  top: 17px;
  border-radius: 50%;
  width: 8px;
  height: 8px;
  background-color: var(--vt-c-divider-dark-1);
}

.dm-button:hover::before,
.monyverse-button:hover::before,
.portal:hover::before,
.server-item:hover::before {
  left: -16px;
  opacity: 1;
}

.dm-button.selected,
.monyverse-button.selected,
.portal.selected,
.server-item.selected {
  border: 2px solid var(--h-secondary);
  border-radius: 50%;
}

/* Make server images non-selectable/non-draggable */
.server-item :deep(img) {
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

/* Drag to create folder */
/* Drop into center - create folder indicator */
.server-item-wrapper.drop-target-into {
  transform: scale(1.1);
}

.server-item-wrapper.drop-target-into .server-item {
  border: 2px dashed var(--harmony-primary, #5865f2);
  border-radius: 16px;
}

.server-item-wrapper.is-dragging {
  opacity: 0.3;
}

.server-item-wrapper.is-dragging .server-item {
  outline: 2px dashed rgba(255, 255, 255, 0.4);
  outline-offset: 2px;
}

/* Folder wrapper dragging state */
.folder-wrapper.is-dragging {
  opacity: 0.3;
}

/* Folder wrapper positioning for drop zones */
.folder-wrapper {
  position: relative;
}

/* Invisible drop zones for folder reordering */
.folder-drop-zone {
  position: absolute;
  left: 0;
  right: 0;
  height: 20px;
  z-index: 5;
}

.folder-drop-zone-top {
  top: -10px;
}

.folder-drop-zone-bottom {
  bottom: -10px;
}

.folder-create-indicator {
  position: absolute;
  bottom: -4px;
  right: -4px;
  width: 20px;
  height: 20px;
  background: var(--harmony-primary, #5865f2);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  animation: pulse-folder 0.5s ease-in-out infinite alternate;
}

@keyframes pulse-folder {
  from { transform: scale(1); }
  to { transform: scale(1.15); }
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

.context-menu-divider {
  height: 1px;
  background-color: #40444b;
  margin: 4px 0;
}

.context-menu-label {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: #72767d;
  text-transform: uppercase;
}

.folder-color-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* Sidebar Tooltip */
.sidebar-tooltip {
  position: fixed;
  left: 80px;
  transform: translateY(-50%);
  background: #18191c;
  border-radius: 8px;
  padding: 6px 14px;
  box-shadow: var(--shadow-small);
  z-index: 1001;
  pointer-events: none;
  white-space: nowrap;
}

.sidebar-tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar-tooltip-name {
  font-size: 15px;
  font-weight: 600;
  color: #ffffff;
}

.sidebar-tooltip-count {
  font-size: 12px;
  color: #b9bbbe;
}

.sidebar-tooltip-arrow {
  position: absolute;
  left: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-right: 6px solid #18191c;
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

<!-- Non-scoped styles for teleported tooltip -->
<style>
.sidebar-tooltip {
  position: fixed;
  left: 80px;
  transform: translateY(-50%);
  background: #18191c;
  border-radius: 8px;
  padding: 6px 14px;
  box-shadow: var(--shadow-small);
  z-index: 10001;
  pointer-events: none;
  white-space: nowrap;
}

.sidebar-tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar-tooltip-name {
  font-size: 15px;
  font-weight: 600;
  color: #ffffff;
}

.sidebar-tooltip-count {
  font-size: 12px;
  color: #b9bbbe;
}

.sidebar-tooltip-arrow {
  position: absolute;
  left: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-right: 6px solid #18191c;
}
</style>
