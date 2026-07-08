<template>
  <div class="server-sidebar" data-testid="server-sidebar">
    <!-- Fixed header section - never scrolls -->
    <div class="fixed-header">

      <div
        class="portal"
        @click="togglePublicServers"
        @mouseenter="showSidebarTooltip($event, 'Harmony Portal')"
        @mouseleave="hideSidebarTooltip"
      >
      <span class="portal-icon" role="img" aria-label="Harmony Portal"></span>
      </div>

      <!-- Today Button (beta, only when enabled in Advanced settings) -->
      <div
        v-if="todayDashboardEnabled"
        class="header-item-wrapper"
        @mouseenter="showSidebarTooltip($event, 'Today')"
        @mouseleave="hideSidebarTooltip"
      >
        <div class="server-pill" :class="{ 'visible': isTodaySelected }"></div>
        <div
          class="dm-button today-button"
          :class="{ 'selected': isTodaySelected }"
          @click="goToToday"
        >
          <svg viewBox="0 0 24 24" class="dm-icon">
            <path d="M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.53,14.78 5.95,15.5C6.37,16.24 6.91,16.86 7.5,17.37L3.36,17M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.5,17.36C17.09,16.85 17.62,16.22 18.04,15.5C18.46,14.77 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.82,19 13.63,18.83 14.37,18.56L12,22Z" fill="currentColor"/>
          </svg>
        </div>
      </div>
      <!-- <div
        class="portal"
        @click="togglePublicServers"
        @mouseenter="showSidebarTooltip($event, 'Harmony Portal')"
        @mouseleave="hideSidebarTooltip"
      >
        <svg fill="#FFF" width="24px" height="24px" viewBox="0 0 24 24" role="img" xmlns="http://www.w3.org/2000/svg"><path d="M6.353 0v2.824H4.94v2.823H3.53v2.824H2.118v2.823H.706v2.824h8.47v2.823H7.765v2.824H6.353v2.823h1.412v-1.412h1.411v-1.411h1.412v-1.412H12V16.94h1.412v-1.41h1.412v-1.411h1.411v-1.412h1.412v-1.412h1.412V9.882h1.412V8.471h1.411V7.059h-4.235V5.647h1.412V4.235h1.412V2.824h1.411V1.412h1.412V0zm0 22.588H4.94V24h1.412zM7.765 2.824h9.882v1.411h-1.412v1.412h-1.411V7.06h-1.412v1.41H12v1.411h1.412v1.412H12V9.882h-1.412v1.412H9.176V9.882H7.765v1.412H6.353V9.882H4.94V8.471h1.412V5.647h1.412zM6.353 8.47v1.411h1.412v-1.41zm2.823 1.411h1.412v-1.41H9.176zm5.648 0h1.411v1.412h-1.411z"/></svg>
      </div> -->
      <!-- DM Button at the top -->
      <div
        class="header-item-wrapper"
        @mouseenter="showSidebarTooltip($event, 'Direct Messages')"
        @mouseleave="hideSidebarTooltip"
      >
        <div class="server-pill" :class="{ 'visible': isDMSelected, 'has-unread': dmUnreadMentions > 0 && !isDMSelected }"></div>
        <div
          class="dm-button"
          :class="{ 'selected': isDMSelected }"
          @click="goToDMs"
        >
          <svg viewBox="0 0 24 24" class="dm-icon">
            <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M4,4H20V16H5.17L4,17.17V4Z" fill="currentColor"/>
          </svg>
          <div v-if="dmUnreadMentions > 0" class="unread-badge">
            {{ dmUnreadMentions > 99 ? '99+' : dmUnreadMentions }}
          </div>
        </div>
      </div>

      <!-- Fediverse Button -->
      <div
        class="header-item-wrapper"
        @mouseenter="showSidebarTooltip($event, 'Fediverse')"
        @mouseleave="hideSidebarTooltip"
      >
        <div class="server-pill" :class="{ 'visible': isFediverseSelected, 'has-unread': unreadCount > 0 && !isFediverseSelected }"></div>
        <div
          class="fediverse-button"
          :class="{ 'selected': isFediverseSelected }"
          @click="goToFediverse"
        >
          <div class="fediverse-icon">#</div>
          <div v-if="unreadCount > 0" class="unread-badge">
            {{ unreadCount > 99 ? '99+' : unreadCount }}
          </div>
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
            :selected-server-id="activeServerId"
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
          <div class="server-pill" :class="{ 'visible': isSelected(item.id), 'has-unread': hasServerUnread(item.id) && !isSelected(item.id) }"></div>
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
      <div class="context-menu-item" @click="handleMarkServerAsRead">
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="currentColor" d="M0.41,13.41L6,19L7.41,17.58L1.83,12M22.24,5.58L11.66,16.17L7.5,12L6.07,13.41L11.66,19L23.66,7L22.24,5.58M18,7L16.59,5.58L10.24,11.93L11.66,13.34L18,7Z"/>
        </svg>
        <span>Mark as Read</span>
      </div>
      <div class="context-menu-item" @click="openInviteFromContextMenu">
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="currentColor" d="M15,14C12.33,14 7,15.33 7,18V20H23V18C23,15.33 17.67,14 15,14M6,10V7H4V10H1V12H4V15H6V12H9V10M15,12A4,4 0 0,0 19,8A4,4 0 0,0 15,4A4,4 0 0,0 11,8A4,4 0 0,0 15,12Z"/>
        </svg>
        <span>Invite People</span>
      </div>
      <div class="context-menu-divider"></div>
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

    <!-- Invite Modal (opened from the server context menu) -->
    <InviteModal
      :show="showInviteModal"
      :server-id="inviteServer?.id"
      :server-data="inviteServer || undefined"
      @close="showInviteModal = false"
    />

    <!-- Funding button (bottom of sidebar) -->
    <div v-if="fundingEnabled" class="fixed-footer">
      <div class="separator"></div>
      <div
        class="funding-button"
        @click="showFundingModal = true"
        @mouseenter="showSidebarTooltip($event, 'Instance Funding')"
        @mouseleave="hideSidebarTooltip"
      >
        <svg viewBox="0 0 24 24" class="funding-icon" width="22" height="22">
          <path fill="currentColor" d="M12,21.35L10.55,20.03C5.4,15.36 2,12.27 2,8.5C2,5.41 4.42,3 7.5,3C9.24,3 10.91,3.81 12,5.08C13.09,3.81 14.76,3 16.5,3C19.58,3 22,5.41 22,8.5C22,12.27 18.6,15.36 13.45,20.03L12,21.35Z"/>
        </svg>
      </div>
    </div>

    <FundingModal v-if="showFundingModal" @close="showFundingModal = false" />
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
// TODO: Consider virtualizing server list for users with many servers/folders
import { computed, ref, watch, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useNotificationStore } from '@/stores/useNotification';
import { useUnreadCounts } from '@/composables/useUnreadCounts';
import { isActivityPubRoute } from '@/types/viewTypes';
import ServerIcon from '@/components/common/ServerIcon.vue';
import ServerFolder from '@/components/ServerFolder.vue';
import ServerFolderContextMenu from '@/components/ServerFolderContextMenu.vue';
import ServerFolderSettingsModal from '@/components/ServerFolderSettingsModal.vue';
import InviteModal from '@/components/InviteModal.vue';
import FundingModal from '@/components/FundingModal.vue';
import { fundingService } from '@/services/FundingService';
import { useTodayDashboard } from '@/composables/useTodayDashboard';
import { useViewport } from '@/composables/useViewport';
import { debug } from '@/utils/debug';
import type { Server, ServerFolder as ServerFolderType } from '@/types';

const props = defineProps<{
  servers: Server[];
}>();

const emit = defineEmits<{
  (e: 'show-public-servers', value: boolean): void;
  (e: 'switch-to-activitypub'): void;
  (e: 'switch-to-chat'): void;
}>();

// Reactive state
const showPublicServers = ref(false);
const showFundingModal = ref(false);
const fundingEnabled = ref(false);

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
// eslint-disable-next-line unused-imports/no-unused-vars
const draggingServerId = computed(() => draggingItemType.value === 'server' ? draggingItemId.value : null);
// eslint-disable-next-line unused-imports/no-unused-vars
const dragOverServerId = computed(() => dropPosition.value === 'into' ? dragOverItemId.value : null);

// Context menu state
const showFolderContextMenu = ref(false);
const showServerContextMenu = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const selectedFolder = ref<ServerFolderType | null>(null);
const selectedServer = ref<Server | null>(null);
const showInviteModal = ref(false);
const inviteServer = ref<Server | null>(null);

const openInviteFromContextMenu = () => {
  inviteServer.value = selectedServer.value;
  showInviteModal.value = false;
  closeServerContextMenu();
  showInviteModal.value = !!inviteServer.value;
};

// Folder modal state
const showFolderModal = ref(false);
const editingFolder = ref<ServerFolderType | null>(null);

// Composables and Stores
const serverChannelStore = useServerChannelStore();
const activityPubStore = useActivityPubStore();
const { todayDashboardEnabled } = useTodayDashboard();
const notificationStore = useNotificationStore();
const { getServerUnreadMessages } = useUnreadCounts();
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

const isTodaySelected = computed(() => route.name === 'Today');

const isFediverseSelected = computed(() => {
  return isActivityPubRoute(route.name as string);
});

// Count only `activitypub_mention`: /social/mentions is driven by those notifications
// (useActivityPub.loadMentionedPosts), so other AP types (follows/reblogs/favorites)
// would strand the badge since clicking through can't clear them. They still show in
// the bell-icon panel.
const unreadCount = computed(() => {
  return notificationStore.notifications.filter(
    n => !n.is_read && n.type === 'activitypub_mention'
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

const hasServerUnread = (serverId: string): boolean => {
  return getServerUnreadMessages(serverId) > 0 || getServerUnreadMentions(serverId) > 0;
};

const activeServerId = computed(() => {
  if (isDMSelected.value || isFediverseSelected.value || isTodaySelected.value) return null;
  return serverChannelStore.currentServerId;
});

const isSelected = (serverId: string) => {
  return serverId === activeServerId.value;
};

onMounted(async () => {
  const config = await fundingService.getFundingConfig()
  fundingEnabled.value = config?.enabled ?? false
})

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

  // setCurrentServer synchronously swaps in this server's cached channel
  // structure (or clears it), so the previous server's channels never linger.
  serverChannelStore.setCurrentServer(serverId);

  const hasCachedStructure =
    serverChannelStore._loadedCategoriesServerId === serverId &&
    serverChannelStore.channels.length > 0;

  if (hasCachedStructure) {
    // Instant path: navigate immediately off the snapshot, refresh behind it.
    const defaultChannelId = serverChannelStore.getDefaultChannel();
    if (defaultChannelId) {
      router.push({ name: 'ChatChannel', params: { serverId, channelId: defaultChannelId } });
    } else {
      router.push({ name: 'Chat' });
    }
    void serverChannelStore.fetchCategoriesAndChannels(serverId, undefined, true);
    return;
  }

  // First visit: the structure is already cleared - also clear the message
  // pane and land on the bare chat route so the user sees a clean loading
  // state instead of the previous server's content.
  const { useChatStore } = await import('@/stores/useChat');
  useChatStore().clearMessages();
  router.push({ name: 'Chat' });

  await serverChannelStore.fetchCategoriesAndChannels(serverId);

  // The user may have clicked another server while this one loaded.
  if (serverChannelStore.currentServerId !== serverId) return;

  const defaultChannelId = serverChannelStore.getDefaultChannel();
  if (defaultChannelId) {
    router.push({
      name: 'ChatChannel',
      params: {
        serverId: serverId,
        channelId: defaultChannelId
      }
    });
  }
};

const goToDMs = () => {
  emit('switch-to-chat');
  router.push({ name: 'DMHome' });
};

const goToToday = () => {
  router.push({ name: 'Today' });
};

const goToFediverse = () => {
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
  const isDraggingFromFolder = event.dataTransfer?.types.includes('application/x-from-folder');
  const isDragging = draggingItemId.value || isDraggingFromFolder;
  
  if (isDragging && draggingItemId.value !== item.id) {
    dragOverItemId.value = item.id;
    isDraggingOverBottom.value = false; // Clear bottom indicator when over an item
    updateDropPosition(event, item, isDraggingFromFolder);
  }
};

const handleItemDragOver = (event: DragEvent, item: Server | ServerFolderType) => {
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
  
  const draggedId = draggingItemId.value || event.dataTransfer?.getData('text/plain');
  const fromFolderId = event.dataTransfer?.getData('application/x-from-folder');
  const isDraggingFromFolder = !!fromFolderId;
  
  if (!draggedId || draggedId === targetItem.id) {
    resetDragState();
    return;
  }

  const targetIsFolder = isFolder(targetItem);
  
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
      // Use the actual index in the sorted list to get proper position
      const targetIndex = sortedSidebarItems.value.findIndex(i => i.id === targetServer.id);
      await createFolderFromServers(draggedId, targetServer.id, targetIndex >= 0 ? targetIndex : 0);
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
    
    serverUpdates.push({ serverId: draggedId, folderId: null, position: targetPosition });
    
    if (serverUpdates.length > 0) {
      await serverChannelStore.updateServerPositions(serverUpdates);
    }
    if (folderUpdates.length > 0) {
      await serverChannelStore.updateFolderPositions(folderUpdates);
    }
    
    if (serversInFolder.length <= 1) {
      await serverChannelStore.deleteFolder(fromFolderId);
    }
    
    resetDragState();
    return;
  }
  
  if (draggingItemType.value === 'server' && !targetIsFolder && dropPosition.value === 'into') {
    const targetServer = targetItem as Server;
    // Use the actual index in the sorted list to get proper position
    const targetIndex = sortedSidebarItems.value.findIndex(i => i.id === targetServer.id);
    await createFolderFromServers(draggingItemId.value!, targetServer.id, targetIndex >= 0 ? targetIndex : 0);
    resetDragState();
    return;
  }
  
  await reorderItems(draggingItemId.value!, draggingItemType.value!, targetItem.id, targetIsFolder, dropPosition.value);
  resetDragState();
};

const createFolderFromServers = async (draggedServerId: string, targetServerId: string, position: number) => {
  // First, shift all items at or after this position to make room
  const items = sortedSidebarItems.value;
  const serverUpdates: { serverId: string; folderId: string | null; position: number }[] = [];
  const folderUpdates: { folderId: string; position: number }[] = [];
  
  items.forEach((item, index) => {
    if (index >= position && item.id !== draggedServerId && item.id !== targetServerId) {
      if (isFolder(item)) {
        folderUpdates.push({ folderId: item.id, position: index + 1 });
      } else {
        serverUpdates.push({ serverId: (item as Server).id, folderId: null, position: index + 1 });
      }
    }
  });
  
  if (serverUpdates.length > 0 || folderUpdates.length > 0) {
    await serverChannelStore.updateServerPositions(serverUpdates);
    if (folderUpdates.length > 0) {
      await serverChannelStore.updateFolderPositions(folderUpdates);
    }
  }
  
  const folder = await serverChannelStore.createFolder('', '#0EA5E9', position);
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
  const items = sortedSidebarItems.value;
  const draggedIndex = items.findIndex(i => i.id === draggedId);
  const targetIndex = items.findIndex(i => i.id === targetId);
  
  if (draggedIndex === -1 || targetIndex === -1) return;
  
  let newPosition: number;
  if (position === 'before') {
    newPosition = targetIndex <= draggedIndex ? targetIndex : targetIndex - 1;
  } else {
    newPosition = targetIndex >= draggedIndex ? targetIndex : targetIndex + 1;
  }
  
  const newItems = [...items];
  const [draggedItem] = newItems.splice(draggedIndex, 1);
  newItems.splice(newPosition, 0, draggedItem);
  
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
// Hide tooltip on route changes (fixes mobile where mouseleave doesn't fire reliably)
watch(() => route.fullPath, () => {
  hideSidebarTooltip();
});

const { isTouchOnly } = useViewport();
const isTouchDevice = ref(isTouchOnly);

const showSidebarTooltip = (event: MouseEvent, name: string, serverCount?: number) => {
  if (isTouchDevice.value) return;
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  
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
  const target = event.target as HTMLElement;
  const isOverItem = target.closest('.sidebar-item-wrapper') || 
                     target.closest('.folder-expanded') || 
                     target.closest('.folder-collapsed') ||
                     target.closest('.server-folder');
  
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

const handleServerRemovedFromFolder = (_serverId: string) => {
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
  
  const maxPosition = Math.max(
    ...sortedSidebarItems.value.map(i => i.position || 0),
    0
  ) + 1;
  
  if (fromFolderId) {
    const serversInFolder = props.servers.filter(s => s.folder_id === fromFolderId);
    
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

const handleMarkServerAsRead = async () => {
  const serverId = selectedServer.value?.id;
  closeServerContextMenu();
  if (!serverId) return;

  try {
    const { supabase } = await import('@/supabase');
    await supabase.rpc('mark_server_as_read', { p_server_id: serverId });
  } catch (err) {
    console.error('Failed to mark server as read:', err);
  }
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

const handleFolderSaved = (_folder: ServerFolderType) => {
  // Folder saved - state is updated in store
};

const handleDeleteFolder = async (folder: ServerFolderType) => {
  await serverChannelStore.deleteFolder(folder.id);
  closeFolderContextMenu();
};

const handleToggleFolderExpanded = (folder: ServerFolderType) => {
  serverChannelStore.toggleFolderExpanded(folder.id);
};

const handleMarkFolderAsRead = async (folder: ServerFolderType) => {
  closeFolderContextMenu();
  if (!folder.servers?.length) return;

  try {
    const { authContextService } = await import('@/services/AuthContextService');
    const context = await authContextService.getCurrentContext();
    const profileId = context.profileId;
    if (!profileId) return;

    const { supabase } = await import('@/supabase');
    const serverIds = folder.servers.map(s => s.id);

    const { data: channels } = await supabase
      .from('channels')
      .select('id')
      .in('server_id', serverIds);

    const channelIds = (channels || []).map(c => c.id);
    if (channelIds.length > 0) {
      const { error: unreadError } = await supabase
        .from('unread_counts')
        .update({
          unread_messages: 0,
          unread_mentions: 0,
          last_read_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('user_id', profileId)
        .in('channel_id', channelIds);
      if (unreadError) {
        debug.error('Failed to clear folder unread counts:', unreadError);
      }
    }

    // Also mark in-app notifications belonging to these channels as read so
    // the bell badge and channel-mention counts catch up immediately.
    if (channelIds.length > 0) {
      const channelIdSet = new Set(channelIds);
      const serverIdSet = new Set(serverIds);
      const notificationStore = useNotificationStore();
      const matching = notificationStore.notifications.filter(n => {
        if (n.is_read) return false;
        const d: any = n.data || {};
        const channelId = d.channel_id ?? d.message?.channel_id ?? d.location?.channel_id;
        const serverId = d.server_id ?? d.location?.server_id;
        if (channelId && channelIdSet.has(channelId)) return true;
        if (serverId && serverIdSet.has(serverId)) return true;
        return false;
      });
      if (matching.length > 0) {
        await Promise.all(matching.map(n => notificationStore.markAsRead(n.id).catch(() => {})));
      }
    }
  } catch (e) {
    debug.error('Failed to mark folder as read:', e);
  }
};

// Server context menu actions
const createFolderFromServer = async () => {
  if (!selectedServer.value) return;
  
  const folderPosition = selectedServer.value.position || 0;
  const folder = await serverChannelStore.createFolder('', '#0EA5E9', folderPosition);
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

/* Fixed footer section */
.fixed-footer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  padding-bottom: 8px;
}

.funding-button {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--background-secondary, #2b2d31);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-top: 4px;
}

.funding-button:hover {
  background: var(--harmony-primary, #0EA5E9);
  border-radius: 16px;
}

.funding-icon {
  color: var(--text-secondary);
  transition: color 0.2s;
}

.funding-button:hover .funding-icon {
  color: var(--text-on-primary, #ffffff);
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

/* Header item wrapper - same pattern as .server-item-wrapper */
.header-item-wrapper {
  position: relative;
  margin: 10px;
}

/* Portal bear – PNG is white-on-black; mask drops the black box so we can
   tint the bear shape with theme-aware icon colors. */
.portal-icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  background-color: var(--nav-rail-button-icon, var(--icon-primary));
  mask-image: url('/img/app_icon_badge.png');
  mask-size: contain;
  mask-repeat: no-repeat;
  mask-position: center;
  -webkit-mask-image: url('/img/app_icon_badge.png');
  -webkit-mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  transition: background-color 0.2s ease;
}

.portal:hover .portal-icon {
  background-color: var(--text-on-primary, #ffffff);
}

/* DM Button */
.dm-button {
  width: 48px;
  height: 48px;
  background-color: var(--nav-rail-button-bg, var(--background-secondary));
  color: var(--nav-rail-button-icon, var(--icon-primary));
  padding: 4px;
  border-radius: 12px;
  cursor: pointer;
  position: relative;
  transition: background 0.2s ease-in-out, border-radius 0.2s ease-in-out, transform 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dm-icon {
  width: 24px;
  height: 24px;
  transition: color 0.2s ease;
}

.dm-button:hover {
  background: var(--harmony-primary, #0284C7);
  transform: translateX(5px);
}

.dm-button:hover .dm-icon {
  color: var(--text-on-primary, #ffffff);
}

.dm-button.selected {
  background: var(--harmony-primary, #0284C7);
  border-radius: 50%;
}

.dm-button.selected .dm-icon {
  color: var(--text-on-primary, #ffffff);
}

/* Fediverse Button */
.fediverse-button {
  width: 48px;
  height: 48px;
  background-color: var(--nav-rail-button-bg, var(--background-secondary));
  padding: 4px;
  border-radius: 12px;
  cursor: pointer;
  position: relative;
  transition: background 0.2s ease-in-out, border-radius 0.2s ease-in-out, transform 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fediverse-icon {
  font-size: 24px;
  font-weight: bold;
  color: var(--nav-rail-button-icon, var(--icon-primary));
  font-family: var(--font-family);
  transition: color 0.2s ease;
}

.fediverse-button:hover {
  background: var(--harmony-primary, #0284C7);
  transform: translateX(5px);
}

.fediverse-button.selected {
  background: var(--harmony-primary, #0284C7);
  border-radius: 50%;
}
.fediverse-button:hover .fediverse-icon,
.fediverse-button.selected .fediverse-icon {
  color: var(--text-on-primary, #ffffff);
}

/* Unread badge */
.unread-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: #f04747;
  color: var(--text-primary);
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
  left: 0;
  margin: 10px;
  /* Optimize for smooth drag animations */
  will-change: transform, opacity;
  transition: transform 0.15s ease-out, left 0.2s ease-out, opacity 0.15s ease-out;
}

.server-item-wrapper:hover {
  left: 5px;
}

.server-item-wrapper.drop-target-into:hover {
  left: 0;
}

.portal,
.server-item {
  width: 48px;
  height: 48px;
  background-color: var(--background-secondary);
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
  width: 48px;
  height: 48px;
  /* background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover)); */
  /* background: transparent; */
  background-color: var(--nav-rail-button-bg, var(--background-secondary));
  margin: 10px 10px 5px 10px;
  transition: background 0.2s ease-in-out;
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
.portal:hover {
  /* background: var(--h-black-light); */
  background: var(--harmony-primary);
  transform: translateX(5px);
}

.separator {
  position: relative;
  width: 80%;
  border-top: 1px solid var(--border-secondary);
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 5px;
}

/*  white pill indicator */
.server-pill {
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 0;
  background: var(--text-primary, #ffffff);
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

/* Server wrappers move via left, so pill counter-shifts to stay in gutter */
.server-item-wrapper:hover .server-pill {
  opacity: 1;
  height: 20px;
  transform: translate(-5px, -50%);
}

.server-item-wrapper:hover .server-pill.visible {
  height: 36px;
}

/* Header wrappers stay still - pill just grows, no counter-shift */
.header-item-wrapper:hover .server-pill {
  opacity: 1;
  height: 20px;
}

.header-item-wrapper:hover .server-pill.visible {
  height: 36px;
}

/* .dm-button.selected,
.fediverse-button.selected,
.portal.selected {
} */
 
.server-item.selected {
  border: 2px solid var(--harmony-secondary);
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
  border: 2px dashed var(--harmony-primary, #0EA5E9);
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
  /* Optimize for smooth drag animations */
  will-change: transform, opacity;
  transition: transform 0.15s ease-out, opacity 0.15s ease-out;
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
  background: var(--harmony-primary, #0EA5E9);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
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
  background: var(--background-floating, #18191c);
  border: 1px solid var(--border-color);
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
  color: var(--text-on-primary, #ffffff);
}

.context-menu-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 8px;
}

.context-menu-label {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
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
  background: var(--tooltip-bg, #18191c);
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
  color: var(--tooltip-text, var(--text-primary));
}

.sidebar-tooltip-count {
  font-size: 12px;
  color: var(--tooltip-text, #b9bbbe);
  opacity: 0.9;
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

<!-- Non-scoped styles for teleported tooltip -->
<style>
.sidebar-tooltip {
  position: fixed;
  left: 80px;
  transform: translateY(-50%);
  background: var(--tooltip-bg, #18191c);
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
  color: var(--tooltip-text, var(--text-primary));
}

.sidebar-tooltip-count {
  font-size: 12px;
  color: var(--tooltip-text, #b9bbbe);
  opacity: 0.9;
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
  border-right: 6px solid var(--tooltip-arrow, #18191c);
}
</style>
