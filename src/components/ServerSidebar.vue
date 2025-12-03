<template>
  <div class="server-sidebar">
    <!-- Fixed header section - never scrolls -->
    <div class="fixed-header">
      <div
        :style="{ backgroundImage: 'url(/icon16.png)', margin: '8px' }"
        class="portal"
        title="Harmony Portal"
        @click="togglePublicServers"
      >
      </div>
      <!-- DM Button at the top -->
      <div
        class="dm-button"
        :class="{ 'selected': isDMSelected }"
        @click="goToDMs"
        title="Direct Messages"
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
        title="Monyverse - Federated Social"
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
      @dragover.prevent
      @drop.prevent="handleDropOnScrollArea"
    >
      <!-- Combined folders and servers, sorted by position -->
      <template v-for="item in sortedSidebarItems" :key="item.id">
        <!-- Folder -->
        <ServerFolder
          v-if="isFolder(item)"
          :folder="item"
          :servers="getFolderServers(item.id)"
          :selected-server-id="serverChannelStore.currentServerId"
          @select-server="selectServer"
          @open-context-menu="openFolderContextMenu"
          @servers-reordered="handleFolderServersReorder(item.id, $event)"
          @server-dropped="handleServerDroppedOnFolder"
          @server-removed="handleServerRemovedFromFolder"
        />

        <!-- Root-level server -->
        <div
          v-else
          class="server-item-wrapper"
          :class="{ 
            'drop-target': dragOverServerId === item.id && draggingServerId !== item.id,
            'is-dragging': draggingServerId === item.id
          }"
          draggable="true"
          @dragstart="handleServerDragStart($event, item)"
          @dragend="handleServerDragEnd"
          @dragenter.prevent="handleServerDragEnter(item.id)"
          @dragleave.prevent="handleServerDragLeave"
          @dragover.prevent
          @drop.prevent="handleServerDrop($event, item)"
          @contextmenu.prevent="openServerContextMenu($event, item)"
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
            @click="selectServer(item.id)"
          />
          <div v-if="getServerUnreadMentions(item.id) > 0" class="unread-badge">
            {{ getServerUnreadMentions(item.id) > 99 ? '99+' : getServerUnreadMentions(item.id) }}
          </div>
          <!-- Folder creation indicator -->
          <div v-if="dragOverServerId === item.id && draggingServerId !== item.id" class="folder-create-indicator">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/>
            </svg>
          </div>
        </div>
      </template>
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

// Drag state for creating folders
const draggingServerId = ref<string | null>(null);
const dragOverServerId = ref<string | null>(null);

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

// Drag and drop handlers for creating folders
const handleServerDragStart = (event: DragEvent, server: Server) => {
  draggingServerId.value = server.id;
  event.dataTransfer?.setData('text/plain', server.id);
  event.dataTransfer!.effectAllowed = 'move';
};

const handleServerDragEnd = () => {
  draggingServerId.value = null;
  dragOverServerId.value = null;
};

const handleServerDragEnter = (serverId: string) => {
  if (draggingServerId.value && draggingServerId.value !== serverId) {
    dragOverServerId.value = serverId;
  }
};

const handleServerDragLeave = () => {
  // Small delay to prevent flickering when moving between elements
  setTimeout(() => {
    if (dragOverServerId.value) {
      dragOverServerId.value = null;
    }
  }, 50);
};

const handleServerDrop = async (event: DragEvent, targetServer: Server) => {
  const draggedServerId = event.dataTransfer?.getData('text/plain');
  
  if (!draggedServerId || draggedServerId === targetServer.id) {
    dragOverServerId.value = null;
    return;
  }

  const draggedServer = props.servers.find(s => s.id === draggedServerId);
  if (!draggedServer) {
    dragOverServerId.value = null;
    return;
  }

  // Create a new folder at the target server's position (empty name by default)
  const folderPosition = targetServer.position || 0;
  const folder = await serverChannelStore.createFolder('', '#5865f2', folderPosition);
  
  if (folder) {
    // Move both servers to the new folder
    await serverChannelStore.moveServerToFolder(draggedServerId, folder.id);
    await serverChannelStore.moveServerToFolder(targetServer.id, folder.id);
  }

  dragOverServerId.value = null;
  draggingServerId.value = null;
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
  // Check if this server was dragged from a folder
  const serverId = event.dataTransfer?.getData('text/plain');
  const fromFolderId = event.dataTransfer?.getData('application/x-from-folder');
  
  if (serverId && fromFolderId) {
    // Count servers in the folder before removing
    const serversInFolder = props.servers.filter(s => s.folder_id === fromFolderId);
    
    // Server was dragged from a folder to the scroll area - remove from folder
    await serverChannelStore.moveServerToFolder(serverId, null);
    
    // If folder is now empty (had only this server), delete it
    if (serversInFolder.length <= 1) {
      await serverChannelStore.deleteFolder(fromFolderId);
    }
  }
  
  dragOverServerId.value = null;
  draggingServerId.value = null;
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
  padding-bottom: 100px; /* Extra space for user status bar at bottom */
  
  /* Hide scrollbar */
  scrollbar-width: none;
  -ms-overflow-style: none;
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
.server-item-wrapper.drop-target {
  transform: scale(1.1);
}

.server-item-wrapper.drop-target .server-item {
  border: 2px dashed var(--harmony-primary, #5865f2);
  border-radius: 16px;
}

.server-item-wrapper.is-dragging {
  opacity: 0.5;
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
</style>
