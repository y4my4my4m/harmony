<template>
  <div class="channel-sidebar">
    <CategoryCreator
      v-if="isCategoryCreatorOpen"
      @showCategoryCreator="showCategoryCreator"
      @createCategory="createCategory"
    />
    <div class="server-header">
      <div class="server-name" @click.stop="toggleDropdown">
        {{ currentServer.name }}
      </div>
      <ServerDropdown
        :serverId="currentServer.id"
        :isVisible="isDropdownOpen"
        @toggle="toggleDropdown"
        @showCategoryCreator="showCategoryCreator"
        @createChannel="emitCreateChannel"
        @openInviteModal="openInviteModal"
      />
    </div>
    
    <!-- Orphan Channels (not in any category) -->
    <div class="orphan-channels">
      <draggable
        v-model="orphanChannels"
        :group="dragGroup"
        :disabled="!canDragAndDrop || isMobile"
        @start="onDragStart"
        @end="onDragEnd"
        @add="onChannelAddedToOrphans"
        item-key="id"
        tag="div"
        :class="{ 'drag-disabled': !canDragAndDrop || isMobile }"
      >
        <template #item="{ element }">
          <div 
            :key="element.id" 
            class="channel-wrapper"
            :data-channel-id="element.id"
            :data-category-id="null"
          >
            <div 
              :class="['channel-item', { 
                'selected': element.id === currentChannelId && !selectedThreadId,
                'dragging': dragState.isDragging && dragState.draggedItem?.id === element.id,
                'voice-channel': isVoiceType(element.type),
                'voice-connected': isVoiceType(element.type) && isUserInVoiceChannel(element.id),
                'channel-unread': hasUnreadMessages(element.id) && element.id !== currentChannelId,
                'muted': mutedChannelIds.has(element.id)
              }]" 
              @click="isVoiceType(element.type) ? handleVoiceChannelClick(element.id) : selectChannel(element.id)"
              @contextmenu="openChannelContextMenu($event, element)"
              :style="{ cursor: getDragCursor('channel', dragState.isDragging && dragState.draggedItem?.id === element.id) }"
            >
              <div class="unread-dot" v-if="hasUnreadMessages(element.id) && element.id !== currentChannelId"></div>
              <div class="channel-content">
                <HashTagIcon v-if="!isVoiceType(element.type)" />
                <SpeakerIcon v-else /> 
                <span class="channel-name">{{ element.name }}</span>
              </div>
              <Icon v-if="mutedChannelIds.has(element.id)" name="bell-off" :size="12" class="muted-icon" />
              <div v-if="getChannelUnreadMentions(element.id) > 0" class="notification-badge">
                {{ getChannelUnreadMentions(element.id) > 99 ? '99+' : getChannelUnreadMentions(element.id) }}
              </div>
              <!-- Voice channel controls -->
              <div v-if="isVoiceType(element.type)" class="voice-controls">
                <span v-if="getUsersInVoiceChannel(element.id).length > 0" class="user-count">
                  {{ getUsersInVoiceChannel(element.id).length }}
                </span>
                <button
                  @click.stop="openVoiceChannelChat(element.id)"
                  class="voice-btn chat-btn"
                  title="Open Chat"
                >
                  <ChatBubbleIcon />
                </button>
              </div>
            </div>
            <!-- Voice channel participants -->
            <VoiceChannelParticipants
              v-if="isVoiceType(element.type) && isUserInVoiceChannel(element.id)"
              :participants="getVoiceChannelParticipants(element.id)"
              :session-start-time="getVoiceSessionStartTime(element.id)"
            />
            <!-- Voice channel users (for channels we're NOT in) -->
            <VoiceChannelUserList
              v-else-if="isVoiceType(element.type) && getUsersInVoiceChannel(element.id).length > 0"
              :user-ids="getUsersInVoiceChannel(element.id)"
              :call-start-time="getChannelCallStartTime(element.id)"
            />
            <!-- Active threads under this channel () -->
            <div 
              v-for="thread in getChannelActiveThreads(element.id)"
              :key="thread.id"
              class="channel-thread-item"
              :class="{ 'selected': selectedThreadId === thread.id }"
              @click.stop="openThread(thread)"
              @contextmenu.stop="openThreadContextMenu($event, thread)"
            >
              <div class="thread-branch"></div>
              <span class="thread-name">{{ thread.name }}</span>
            </div>
          </div>
        </template>
      </draggable>
    </div>

    <!-- Categories and Channels -->
    <draggable
      v-model="reorderableCategories"
      :group="{ name: 'categories', put: false, pull: false }"
      :disabled="!canDragAndDrop || isMobile"
      :key="categoriesKey"
      item-key="id"
      tag="div"
      class="categories-container"
    >
      <template #item="{ element: category }">
        <div :key="category.id" class="category-section">
          <!-- Category Header -->
          <div 
            class="category-header"
            @click="toggleCategory(category.id)"
            @contextmenu="openCategoryContextMenu($event, category)"
            :class="{ 
              'collapsed': collapsedCategories.has(category.id),
              'has-visible-channels': shouldShowCategoryContent(category)
            }"
          >
            <Icon 
              name="chevron-down" 
              class="category-arrow" 
              :class="{ 'rotated': collapsedCategories.has(category.id) }"
              :size="12"
            />
            <span class="category-name">{{ category.name.toUpperCase() }}</span>
          </div>

          <!-- Channel List - Always show for drag & drop, even if empty -->
          <div 
            class="channel-list"
            :class="{ 
              'collapsed-list': collapsedCategories.has(category.id),
              'empty-category': getCachedCategoryChannels(category.id).value.length === 0
            }"
          >
            <draggable
              v-model="getCachedCategoryChannels(category.id).value"
              :group="dragGroup"
              :disabled="!canDragAndDrop || isMobile"
              @start="onDragStart"
              @end="onDragEnd"
              @add="(evt: any) => onChannelAddedToCategory(evt, category.id)"
              @remove="onChannelRemovedFromCategory"
              item-key="id"
              tag="div"
              class="category-channels"
              :class="{ 'empty-drop-zone': getCachedCategoryChannels(category.id).value.length === 0 }"
            >
              <template #item="{ element: channel }">
                <div 
                  :key="channel.id" 
                  class="channel-wrapper"
                  :data-channel-id="channel.id"
                  :data-category-id="category.id"
                >
                  <div
                    class="channel-item"
                    :class="{ 
                      'selected': currentChannelId === channel.id && !selectedThreadId,
                      'in-collapsed-category': collapsedCategories.has(category.id),
                      'dragging': dragState.isDragging && dragState.draggedItem?.id === channel.id,
                      'voice-channel': isVoiceType(channel.type),
                      'voice-connected': isVoiceType(channel.type) && isUserInVoiceChannel(channel.id),
                      'channel-unread': hasUnreadMessages(channel.id) && channel.id !== currentChannelId,
                      'muted': mutedChannelIds.has(channel.id)
                    }"
                    @click="isVoiceType(channel.type) ? handleVoiceChannelClick(channel.id) : selectChannel(channel.id)"
                    @contextmenu="openChannelContextMenu($event, channel)"
                    :style="{ cursor: getDragCursor('channel', dragState.isDragging && dragState.draggedItem?.id === channel.id) }"
                  >
                    <div class="unread-dot" v-if="hasUnreadMessages(channel.id) && channel.id !== currentChannelId"></div>
                    <div class="channel-content">
                      <HashTagIcon v-if="!isVoiceType(channel.type)" />
                      <SpeakerIcon v-else />
                      <span class="channel-name">{{ channel.name }}</span>
                    </div>
                    <Icon v-if="mutedChannelIds.has(channel.id)" name="bell-off" :size="12" class="muted-icon" />
                    <div v-if="getChannelUnreadMentions(channel.id) > 0" class="notification-badge">
                      {{ getChannelUnreadMentions(channel.id) > 99 ? '99+' : getChannelUnreadMentions(channel.id) }}
                    </div>
                    <!-- Voice channel controls -->
                    <div v-if="isVoiceType(channel.type)" class="voice-controls">
                      <span v-if="getUsersInVoiceChannel(channel.id).length > 0" class="user-count">
                        {{ getUsersInVoiceChannel(channel.id).length }}
                      </span>
                      <button
                        @click.stop="openVoiceChannelChat(channel.id)"
                        class="voice-btn chat-btn"
                        title="Open Chat"
                      >
                        <ChatBubbleIcon />
                      </button>
                    </div>
                  </div>
                  <!-- Voice channel participants -->
                  <VoiceChannelParticipants
                    v-if="isVoiceType(channel.type) && isUserInVoiceChannel(channel.id)"
                    :participants="getVoiceChannelParticipants(channel.id)"
                    :session-start-time="getVoiceSessionStartTime(channel.id)"
                  />
                  <!-- Voice channel users (for channels we're NOT in) -->
                  <VoiceChannelUserList
                    v-else-if="isVoiceType(channel.type) && getUsersInVoiceChannel(channel.id).length > 0"
                    :user-ids="getUsersInVoiceChannel(channel.id)"
                    :call-start-time="getChannelCallStartTime(channel.id)"
                  />
                  <!-- Active threads under this channel () -->
                  <div 
                    v-for="thread in getChannelActiveThreads(channel.id)"
                    :key="thread.id"
                    class="channel-thread-item"
                    :class="{ 'selected': selectedThreadId === thread.id }"
                    @click.stop="openThread(thread)"
                    @contextmenu.stop="openThreadContextMenu($event, thread)"
                  >
                    <div class="thread-branch"></div>
                    <span class="thread-name">{{ thread.name }}</span>
                  </div>
                </div>
              </template>
              <!-- Empty state for drag target - only show when dragging channels -->
              <template #footer v-if="getCachedCategoryChannels(category.id).value.length === 0 && dragState.isDragging">
                <div class="empty-category-placeholder">
                  Drop channels here
                </div>
              </template>
            </draggable>
          </div>
        </div>
      </template>
    </draggable>

    <!-- Invite Modal -->
    <InviteModal 
      :show="showInviteModal" 
      :server-id="currentServer.id"
      :server-data="currentServerData"
      @close="closeInviteModal"
    />

    <!-- Context Menus (teleported to body to avoid will-change:transform breaking position:fixed) -->
    <Teleport to="body">
      <ChannelContextMenu
        :is-visible="showChannelContextMenu"
        :position="contextMenuPosition"
        :channel="selectedChannel"
        @close="closeContextMenus"
        @invite-users="handleInviteUsers"
        @edit-channel="handleEditChannel"
        @delete-channel="handleDeleteChannel"
      />

      <CategoryContextMenu
        :is-visible="showCategoryContextMenu"
        :position="contextMenuPosition"
        :category="selectedCategory"
        @close="closeContextMenus"
        @create-channel="handleCreateChannelInCategory"
        @edit-category="handleEditCategory"
        @delete-category="handleDeleteCategory"
      />

      <ThreadContextMenu
        :is-visible="showThreadContextMenu"
        :position="contextMenuPosition"
        :thread="selectedThread"
        :server-id="currentServer?.id"
        @close="closeContextMenus"
        @leave="handleLeaveThread"
        @edit="handleEditThread"
        @open-split-view="handleOpenSplitView"
        @close-thread="handleCloseThread"
        @reopen="handleReopenThread"
        @lock="handleLockThread"
        @unlock="handleUnlockThread"
        @delete="handleDeleteThread"
      />
    </Teleport>

    <!-- Edit Modals -->
    <ChannelEditModal
      :show="showChannelEditModal"
      :channel="selectedChannel"
      @close="closeChannelEditModal"
      @updated="handleChannelUpdated"
    />

    <CategoryEditModal
      :show="showCategoryEditModal"
      :category="selectedCategory"
      @close="closeCategoryEditModal"
      @updated="handleCategoryUpdated"
    />

    <ThreadEditModal
      :show="showThreadEditModal"
      :thread="selectedThread"
      @close="closeThreadEditModal"
      @updated="handleThreadUpdated"
    />

    <!-- Confirmation Modal -->
    <ConfirmationModal
      :show="showConfirmationModal"
      :title="confirmationConfig.title"
      :message="confirmationConfig.message"
      :secondary-message="confirmationConfig.secondaryMessage"
      :confirm-button-text="confirmationConfig.confirmButtonText"
      :require-confirmation="confirmationConfig.requireConfirmation"
      :confirmation-text="confirmationConfig.confirmationText"
      @close="closeConfirmationModal"
      @confirm="confirmationConfig.onConfirm"
    />

    <!-- Mobile Voice Channel Preview -->
    <MobileVoiceChannelPreview
      :is-visible="showMobileVoicePreview"
      :channel-id="mobileVoicePreviewChannel?.id || ''"
      :channel-name="mobileVoicePreviewChannel?.name || ''"
      :participants="getMobileVoicePreviewParticipants"
      @close="closeMobileVoicePreview"
      @join="handleMobileVoiceJoin"
      @open-chat="handleMobileVoiceOpenChat"
    />
  </div>
</template>

<script setup lang="ts">
// TODO: Consider virtualizing channel/category lists for servers with many channels
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { debug } from '@/utils/debug'
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useRouter, useRoute } from 'vue-router';
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useNotificationStore } from '@/stores/useNotification';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useThemeStore } from '@/stores/useTheme';
import { statePersistence } from '@/services/StatePersistence';

import type { PropType } from 'vue';
import type { Channel, Category } from '@/types';

import HashTagIcon from '@/components/icons/HashTag.vue';
import SpeakerIcon from '@/components/icons/Speaker.vue';
import ChatBubbleIcon from '@/components/icons/ChatBubble.vue';
import Icon from '@/components/common/Icon.vue';
import ServerDropdown from './ServerDropdown.vue';
import CategoryCreator from './CategoryCreator.vue';
import InviteModal from './InviteModal.vue';
import VoiceChannelParticipants from '@/components/voice/VoiceChannelParticipants.vue';
import VoiceChannelUserList from '@/components/voice/VoiceChannelUserList.vue';
import MobileVoiceChannelPreview from '@/components/voice/MobileVoiceChannelPreview.vue';
import ChannelContextMenu from './ChannelContextMenu.vue';
import CategoryContextMenu from './CategoryContextMenu.vue';
import ChannelEditModal from './ChannelEditModal.vue';
import CategoryEditModal from './CategoryEditModal.vue';
import ConfirmationModal from './ConfirmationModal.vue';
import ThreadContextMenu from './threads/ThreadContextMenu.vue';
import ThreadEditModal from './ThreadEditModal.vue';
import { threadService, type ThreadWithDetails } from '@/services/ThreadService';
import { useUnreadCounts } from '@/composables/useUnreadCounts';
import { supabase } from '@/supabase';
import { authContextService } from '@/services/AuthContextService';

import draggable from "vuedraggable";

interface DragState {
  isDragging: boolean;
  draggedItem: Channel | null;
  sourceCategoryId: string | null;
  targetCategoryId: string | null;
  isOver: boolean;
}

// Props and Emits
const props = defineProps({
  currentServer: {
    type: Object,
    required: true
  },
  channels: {
    type: Array as PropType<Channel[]>,
    required: true
  },
  categories: {
    type: Array as PropType<Category[]>,
  },
  categoryChannels: {
    type: Object as PropType<{ [key: string]: Channel[] }>,
    required: true
  },
  currentChannelId: {
    type: String,
    required: true
  },
});

const emit = defineEmits<{
  (e: 'createChannel', categoryId?: string): void
  (e: 'openThread', thread: ThreadWithDetails): void
}>();

// State
const isDropdownOpen = ref(false);
const showInviteModal = ref(false);
const isCategoryCreatorOpen = ref(false);

// Threads state - keyed by channel ID
const channelThreads = ref<Map<string, ThreadWithDetails[]>>(new Map());
const selectedThreadId = ref<string | null>(null);
const loadingThreads = ref(false);
// Thread caching - track which server's threads are loaded and when
const loadedThreadsServerId = ref<string | null>(null);
const threadsLastFetchedAt = ref<Date | null>(null);
const THREAD_CACHE_VALIDITY_MS = 60 * 1000; // 1 minute cache validity

// Context menu state
const showChannelContextMenu = ref(false);
const showCategoryContextMenu = ref(false);
const showThreadContextMenu = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const selectedChannel = ref<Channel | null>(null);
const selectedCategory = ref<Category | null>(null);
const selectedThread = ref<ThreadWithDetails | null>(null);

// Modal state
const showChannelEditModal = ref(false);
const showCategoryEditModal = ref(false);
const showThreadEditModal = ref(false);
const showConfirmationModal = ref(false);

// Mobile voice channel preview state
const showMobileVoicePreview = ref(false);
const mobileVoicePreviewChannel = ref<Channel | null>(null);
const confirmationConfig = ref({
  title: '',
  message: '',
  secondaryMessage: '',
  confirmButtonText: 'Delete',
  requireConfirmation: false,
  confirmationText: 'DELETE',
  onConfirm: () => {}
});

// Drag state
const dragState = ref<DragState>({
  isDragging: false,
  draggedItem: null,
  sourceCategoryId: null,
  targetCategoryId: null,
  isOver: false,
});

// Stores and Composables
const serverChannelStore = useServerChannelStore();
const router = useRouter();
const route = useRoute();
const serverUsersStore = useServerUsersStore();
const voiceChannelStore = useUnifiedVoiceChannelStore();
const themeStore = useThemeStore();
const { 
  canManageChannels, 
  isCurrentUserServerOwner,
  channelPermissions 
} = useServerPermissions();

// Channel management permissions
const canDragAndDrop = computed(() => isCurrentUserServerOwner.value || canManageChannels.value);
const canMoveChannelsBetweenCategories = computed(() => channelPermissions.value.canReorderChannels);

const getDragCursor = (itemType: 'channel' | 'category', isDragging = false) => {
  return canDragAndDrop.value ? (isDragging ? 'grabbing' : 'grab') : 'pointer';
};
const { triggerVoice } = useHapticSettings();

// Computed Properties
// Only consider mobile if screen is actually small (touch-enabled desktops should still allow drag)
const isVoiceType = (type: any): boolean => Number(type) === 1;

const isMobile = computed(() => {
  const hasSmallScreen = window.innerWidth <= 768;
  const isTouchOnlyDevice = 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches;
  return hasSmallScreen || isTouchOnlyDevice;
});

const dragGroup = computed(() => ({
  name: 'channels',
  put: true,
  pull: true,
}));

// Pass the raw server row through - InviteModal normalizes `icon`/`banner`
// via serverUtils and fetches the live member count itself.
//
// Returns `undefined` (not `null`) when there's no server, because that's
// what InviteModal's optional `server-data` prop type accepts; returning
// `null` produces a TS2322 error since the prop signature is `T | undefined`.
const currentServerData = computed(() => {
  if (!props.currentServer) return undefined;
  return {
    id: props.currentServer.id,
    name: props.currentServer.name,
    icon: props.currentServer.icon,
    banner: props.currentServer.banner,
    description: props.currentServer.description,
    member_count: Object.keys(serverUsersStore.userProfiles).length || props.currentServer.member_count || 0,
  };
});

// Category & Channel Data Management
const collapsedCategories = ref(new Set<string>());

const orphanChannels = computed({
  get: () => {
    if (!props.channels || !Array.isArray(props.channels)) return [];
    const categoryChannelIds = new Set(Object.values(props.categoryChannels || {}).flat().map(c => c.id));
    return props.channels
      .filter(channel => !categoryChannelIds.has(channel.id))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  },
  set: async (newChannels) => {
    try {
      await serverChannelStore.reorderChannelsInCategory(null, newChannels);
    } catch (error) {
      debug.error('Failed to reorder orphan channels:', error);
    }
  }
});

const categoryChannelsCache = ref<Map<string, any>>(new Map());

const getCategoryChannelsComputed = (categoryId: string) => {
  return computed({
    get: () => {
      const categoryChannels = props.categoryChannels?.[categoryId] || [];
      const channelsInCategory = props.channels
        .filter(channel => categoryChannels.some(catChannel => catChannel.id === channel.id))
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      
      if (collapsedCategories.value.has(categoryId)) {
        return channelsInCategory.filter(channel => 
          channel.id === props.currentChannelId || hasNotifications(channel)
        );
      }
      return channelsInCategory;
    },
    set: async (newChannels: Channel[]) => {
      try {
        await serverChannelStore.reorderChannelsInCategory(categoryId, newChannels);
      } catch (error) {
        debug.error(`Failed to reorder channels in category ${categoryId}:`, error);
      }
    }
  });
};

const getCachedCategoryChannels = (categoryId: string) => {
  if (!categoryChannelsCache.value.has(categoryId)) {
    categoryChannelsCache.value.set(categoryId, getCategoryChannelsComputed(categoryId));
  }
  return categoryChannelsCache.value.get(categoryId);
};

const storeCategories = computed(() => serverChannelStore.categories);

const reorderableCategories = computed({
  get: () => {
    if (!Array.isArray(storeCategories.value)) return [];
    return storeCategories.value.map(category => ({
      ...category,
      channels: props.categoryChannels[category.id] || [],
    }));
  },
  set: (newCategories) => {
    serverChannelStore.updateCategoryOrder(newCategories);
  }
});

const categoriesKey = computed(() => serverChannelStore.categories.map((c: any) => `${c.id}-${c.order}`).join(','));

// Methods
const initializeCategoryStates = async () => {
  if (!props.currentServer?.id) return;
  try {
    await statePersistence.initialize();
    const savedStates = statePersistence.getServerCategoryStates(props.currentServer.id);
    const newCollapsedSet = new Set<string>();
    Object.entries(savedStates).forEach(([categoryId, isCollapsed]) => {
      if (isCollapsed) newCollapsedSet.add(categoryId);
    });
    collapsedCategories.value = newCollapsedSet;
  } catch (error) {
    debug.warn('⚠️ Failed to initialize category states:', error);
  }
};

const onDragStart = (evt: any) => {
  if (!canDragAndDrop.value || isMobile.value) {
    evt.preventDefault();
    return false;
  }
  
  const channelId = evt.item.dataset.channelId;
  const categoryId = evt.item.dataset.categoryId;
  const allChannels = [...orphanChannels.value, ...Object.values(props.categoryChannels).flat()];
  const draggedChannel = allChannels.find(ch => ch.id === channelId) || null;

  if (!draggedChannel) {
    evt.preventDefault();
    return false;
  }
  
  dragState.value = {
    isDragging: true,
    draggedItem: draggedChannel,
    sourceCategoryId: categoryId === 'null' ? null : categoryId,
    targetCategoryId: null,
    isOver: false,
  };
  document.body.classList.add('dragging-channel');
};

const onDragEnd = () => {
  document.body.classList.remove('dragging-channel');
  dragState.value = { isDragging: false, draggedItem: null, sourceCategoryId: null, targetCategoryId: null, isOver: false };
};

const onChannelAddedToCategory = async (evt: { item: HTMLElement }, categoryId: string) => {
  if (!canMoveChannelsBetweenCategories.value) return;
  const channelId = evt.item.dataset.channelId;
  if (!dragState.value.draggedItem || dragState.value.draggedItem.id !== channelId) return;
  try {
    await serverChannelStore.moveChannelToCategory(channelId, categoryId);
  } catch (error) {
    debug.error('Failed to move channel to category:', error);
  }
};

const onChannelAddedToOrphans = async (evt: any) => {
  if (!canMoveChannelsBetweenCategories.value) return;
  const channelId = evt.item.dataset.channelId;
  if (!dragState.value.draggedItem || dragState.value.draggedItem.id !== channelId) return;
  try {
    await serverChannelStore.moveChannelToCategory(channelId, null);
  } catch (error) {
    debug.error('Failed to move channel to orphan channels:', error);
  }
};

const onChannelRemovedFromCategory = (_evt: any) => {
  // This handles when a channel is removed from a category during drag operations
  // The actual move logic is handled by the corresponding @add event handler
  // This is mainly for cleanup or visual feedback if needed
  debug.log('Channel removed from category during drag operation');
};



const notificationStore = useNotificationStore();
const { getUnreadMessages } = useUnreadCounts();

const mutedChannelIds = ref<Set<string>>(new Set());

const loadMutedChannels = async () => {
  try {
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated || !props.currentServer?.id) return

    const { data } = await supabase
      .from('notification_channels')
      .select('channel_id')
      .eq('user_id', ctx.profileId)
      .eq('server_id', props.currentServer.id)
      .eq('muted', true)

    mutedChannelIds.value = new Set((data || []).map((r: any) => r.channel_id).filter(Boolean))
  } catch (error) {
    debug.error('Failed to load muted channels:', error)
  }
}

const getChannelUnreadMentions = (channelId: string): number => {
  return notificationStore.unreadChannelMentions(channelId);
};

const hasNotifications = (channel: Channel): boolean => {
  return getChannelUnreadMentions(channel.id) > 0;
};

const hasUnreadMessages = (channelId: string): boolean => {
  if (mutedChannelIds.value.has(channelId)) return false
  return getUnreadMessages({ channelId }) > 0;
};

const shouldShowCategoryContent = (category: Category): boolean => {
  const categoryChannelsList = props.categoryChannels?.[category.id] || [];
  if (!collapsedCategories.value.has(category.id)) return categoryChannelsList.length > 0;
  return categoryChannelsList.some(channel => channel.id === props.currentChannelId || hasNotifications(channel));
};

const toggleCategory = async (categoryId: string) => {
  const wasCollapsed = collapsedCategories.value.has(categoryId);
  wasCollapsed ? collapsedCategories.value.delete(categoryId) : collapsedCategories.value.add(categoryId);
  if (props.currentServer?.id) {
    try {
      await statePersistence.setCategoryCollapseState(props.currentServer.id, categoryId, !wasCollapsed);
    } catch (error) {
      debug.warn('⚠️ Failed to persist category collapse state:', error);
    }
  }
};

const toggleDropdown = () => isDropdownOpen.value = !isDropdownOpen.value;
const selectChannel = (channelId: string) => {
  // Professional navigation with proper route structure
  const serverId = props.currentServer.id;
  if (!serverId) {
    debug.warn('Cannot navigate to channel: No server ID available');
    return;
  }
  
  router.push({ 
    name: 'ChatChannel', 
    params: { 
      serverId, 
      channelId 
    } 
  });
};

// Handler for voice channel clicks - Discord-like behavior
// On mobile, show preview instead of auto-joining
const handleVoiceChannelClick = async (channelId: string) => {
  // If already in this voice channel, just navigate to its text chat
  if (isUserInVoiceChannel(channelId)) {
    selectChannel(channelId);
    return;
  }
  
  // On mobile, show the preview modal instead of auto-joining
  if (isMobile.value) {
    const channel = props.channels.find(c => c.id === channelId);
    if (channel) {
      mobileVoicePreviewChannel.value = channel;
      showMobileVoicePreview.value = true;
    }
    return;
  }
  
  // Desktop: Navigate to channel text chat + join voice
  selectChannel(channelId);
  await joinVoiceChannel(channelId);
};

// Mobile voice preview handlers
const closeMobileVoicePreview = () => {
  showMobileVoicePreview.value = false;
  mobileVoicePreviewChannel.value = null;
};

const handleMobileVoiceJoin = async (startMuted: boolean) => {
  if (!mobileVoicePreviewChannel.value) return;
  
  const channelId = mobileVoicePreviewChannel.value.id;
  closeMobileVoicePreview();
  
  // Join the voice channel
  const success = await joinVoiceChannel(channelId);
  
  // If user chose to start muted, set mute state after joining
  if (success && startMuted) {
    voiceChannelStore.setMuted(true);
  }
};

const handleMobileVoiceOpenChat = () => {
  if (!mobileVoicePreviewChannel.value) return;
  
  const channelId = mobileVoicePreviewChannel.value.id;
  closeMobileVoicePreview();
  openVoiceChannelChat(channelId);
};

// Get participants for mobile voice preview
const getMobileVoicePreviewParticipants = computed(() => {
  if (!mobileVoicePreviewChannel.value) return [];
  
  const userIds = getUsersInVoiceChannel(mobileVoicePreviewChannel.value.id);
  return userIds.map(id => ({ id }));
});

// Open voice channel text chat
const openVoiceChannelChat = (channelId: string) => {
  selectChannel(channelId);
};
const emitCreateChannel = (categoryId?: string) => emit('createChannel', categoryId);
const showCategoryCreator = () => isCategoryCreatorOpen.value = !isCategoryCreatorOpen.value;
const openInviteModal = () => showInviteModal.value = true;
const closeInviteModal = () => showInviteModal.value = false;

watch(() => serverChannelStore.pendingInviteOpen, (pending) => {
  if (pending) {
    serverChannelStore.pendingInviteOpen = false
    openInviteModal()
  }
});

// Threads methods
const loadActiveThreads = async (forceRefresh = false) => {
  if (!props.currentServer?.id) return;
  
  const serverId = props.currentServer.id;
  
  // Check cache validity - skip fetch if data is fresh and for the same server
  // Note: We don't check channelThreads.value.size > 0 because "zero threads" is also a valid cached state
  if (!forceRefresh && 
      loadedThreadsServerId.value === serverId && 
      threadsLastFetchedAt.value) {
    const cacheAge = Date.now() - threadsLastFetchedAt.value.getTime();
    if (cacheAge < THREAD_CACHE_VALIDITY_MS) {
      debug.log(`📦 Threads cache still valid (${Math.round(cacheAge / 1000)}s old, ${channelThreads.value.size} threads), skipping fetch`);
      return;
    }
  }
  
  loadingThreads.value = true;
  try {
    // Run auto-archive first so the query only returns truly active threads
    supabase.rpc('auto_archive_threads').then(({ error }) => {
      if (error) debug.warn('auto_archive_threads RPC failed:', error);
    });

    const threads = await threadService.getServerThreads(serverId, { archived: false });

    // Client-side safety net: filter out threads that should have been archived
    const now = Date.now();
    const activeThreads = threads.filter(thread => {
      if (!thread.last_message_at || !thread.auto_archive_duration) return true;
      const lastActivity = new Date(thread.last_message_at as any).getTime();
      const expiresAt = lastActivity + (thread.auto_archive_duration as number) * 60 * 1000;
      return expiresAt > now;
    });

    // Group threads by channel ID
    const grouped = new Map<string, ThreadWithDetails[]>();
    for (const thread of activeThreads) {
      const channelId = thread.channel_id;
      if (!grouped.has(channelId)) {
        grouped.set(channelId, []);
      }
      grouped.get(channelId)!.push(thread);
    }
    channelThreads.value = grouped;
    // Update cache metadata
    loadedThreadsServerId.value = serverId;
    threadsLastFetchedAt.value = new Date();
    debug.log(`✅ Loaded ${threads.length} threads for server, cached at ${threadsLastFetchedAt.value.toISOString()}`);
  } catch (error) {
    debug.error('Failed to load threads:', error);
    channelThreads.value = new Map();
  } finally {
    loadingThreads.value = false;
  }
};

const getChannelActiveThreads = (channelId: string): ThreadWithDetails[] => {
  return channelThreads.value.get(channelId) || [];
};

const openThread = (thread: ThreadWithDetails) => {
  selectedThreadId.value = thread.id;
  // Navigate to full thread view
  router.push({
    name: 'ThreadView',
    params: {
      serverId: props.currentServer.id,
      threadId: thread.id
    }
  });
};

const createCategory = async (categoryName: string) => {
  try {
    await serverChannelStore.createCategory(categoryName, props.currentServer.id);
  } catch (error) {
    debug.error('Failed to create category:', error);
  } finally {
    isCategoryCreatorOpen.value = false;
  }
};

// NOTE: Channel creation is handled by CreateChannel.vue which emits to ChatLayout.vue
// The realtime subscription automatically adds new channels to the store via _handleChannelInsert

// Check if user is in voice channel (or optimistically joining it)
const isUserInVoiceChannel = (channelId: string): boolean => {
  // Check real connection
  if (voiceChannelStore.isConnected && voiceChannelStore.currentChannelId === channelId) {
    return true;
  }
  // Check optimistic state (joining in progress)
  if (voiceChannelStore.optimisticChannelId === channelId) {
    return true;
  }
  return false;
};
const getUsersInVoiceChannel = (channelId: string): string[] => serverUsersStore.getUsersInVoiceChannel(channelId);
const getChannelCallStartTime = (channelId: string): Date | null => serverUsersStore.getCallStartTime(channelId);

const getVoiceChannelParticipants = (channelId: string) => {
  // Only return participants if the current user is in this specific channel
  if (voiceChannelStore.currentChannelId === channelId) {
    return voiceChannelStore.allParticipants;
  }
  return [];
};

const getVoiceSessionStartTime = (channelId: string) => {
  // Only return session start time if the current user is in this specific channel
  if (voiceChannelStore.currentChannelId === channelId) {
    return voiceChannelStore.sessionStartTime;
  }
  return null;
};

const joinVoiceChannel = async (channelId: string): Promise<boolean> => {
  // Play sound and haptic immediately for optimistic UX (don't wait for connection)
  themeStore.playAudio('voice_connect');
  triggerVoice('success');
  
  // Then attempt the actual connection
  const success = await voiceChannelStore.joinVoiceChannel(channelId, props.currentServer.id);
  
  if (!success) {
    // Connection failed - play disconnect sound to indicate failure
    themeStore.playAudio('voice_disconnect');
    triggerVoice('warning');
  }
  
  return success;
};

// eslint-disable-next-line unused-imports/no-unused-vars
const leaveVoiceChannel = async (_channelId: string) => {
  if (await voiceChannelStore.leaveVoiceChannel()) {
    themeStore.playAudio('voice_disconnect');
    // Haptic feedback for voice disconnect
    triggerVoice('warning');
  }
};

const openContextMenu = (event: MouseEvent, item: Channel | Category, type: 'channel' | 'category') => {
  event.preventDefault();
  event.stopPropagation();
  closeContextMenus();
  if (type === 'channel') {
    selectedChannel.value = item as Channel;
    showChannelContextMenu.value = true;
  } else {
    selectedCategory.value = item as Category;
    showCategoryContextMenu.value = true;
  }
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
};

const openChannelContextMenu = (event: MouseEvent, channel: Channel) => openContextMenu(event, channel, 'channel');
const openCategoryContextMenu = (event: MouseEvent, category: Category) => openContextMenu(event, category, 'category');

const closeContextMenus = () => {
  showChannelContextMenu.value = false;
  showCategoryContextMenu.value = false;
  showThreadContextMenu.value = false;
};

// Thread context menu handler
const openThreadContextMenu = (event: MouseEvent, thread: ThreadWithDetails) => {
  event.preventDefault();
  event.stopPropagation();
  closeContextMenus();
  selectedThread.value = thread;
  showThreadContextMenu.value = true;
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
};

const handleInviteUsers = () => openInviteModal();

const handleEditChannel = (channel: Channel) => {
  selectedChannel.value = channel;
  showChannelEditModal.value = true;
};

const handleDeleteChannel = (channel: Channel) => {
  selectedChannel.value = channel;
  confirmationConfig.value = {
    title: 'Delete Channel',
    message: `Are you sure you want to delete #${channel.name}?`,
    secondaryMessage: 'This action cannot be undone. All messages in this channel will be permanently deleted.',
    confirmButtonText: 'Delete Channel',
    requireConfirmation: true,
    confirmationText: channel.name,
    onConfirm: async () => {
      try {
        await serverChannelStore.deleteChannel(channel.id);
        closeConfirmationModal();
      } catch (error) {
        debug.error('Failed to delete channel:', error);
        closeConfirmationModal();
      }
    }
  };
  showConfirmationModal.value = true;
};

const handleCreateChannelInCategory = (category: Category) => emit('createChannel', category.id);

const handleEditCategory = (category: Category) => {
  selectedCategory.value = category;
  showCategoryEditModal.value = true;
};

// State for category deletion with channels option
const deleteCategoryWithChannels = ref(false);

const handleDeleteCategory = (category: Category) => {
  selectedCategory.value = category;
  const channelCount = (props.categoryChannels[category.id] || []).length;
  deleteCategoryWithChannels.value = false; // Reset on each delete attempt
  
  let secondaryMsg = 'This action cannot be undone.';
  if (channelCount > 0) {
    secondaryMsg = `This category contains ${channelCount} channel(s). Channels will be moved to the top of the channel list (uncategorized). To also delete all channels, type "${category.name} DELETE" instead of just "${category.name}".`;
  }
  
  confirmationConfig.value = {
    title: 'Delete Category',
    message: `Are you sure you want to delete "${category.name}"?`,
    secondaryMessage: secondaryMsg,
    confirmButtonText: 'Delete Category',
    requireConfirmation: true,
    confirmationText: category.name,
    onConfirm: async () => {
      try {
        // Check if user wants to delete channels too (typed "NAME DELETE")
        const confirmInput = document.querySelector<HTMLInputElement>('.confirmation-section input');
        const deleteChannels = confirmInput?.value?.trim().toUpperCase().endsWith(' DELETE') || false;
        
        await serverChannelStore.deleteCategory(category.id, deleteChannels);
        closeConfirmationModal();
      } catch (error) {
        debug.error('Failed to delete category:', error);
        closeConfirmationModal();
      }
    }
  };
  showConfirmationModal.value = true;
};

// Thread context menu action handlers
const handleLeaveThread = async () => {
  if (!selectedThread.value) return;
  try {
    await threadService.leaveThread(selectedThread.value.id);
    await loadActiveThreads(true); // Force refresh after mutation
  } catch (error) {
    debug.error('Failed to leave thread:', error);
  }
};

const handleEditThread = (thread: ThreadWithDetails) => {
  selectedThread.value = thread;
  showThreadEditModal.value = true;
};

const handleOpenSplitView = (thread: ThreadWithDetails) => {
  // Emit the thread to open it in the panel (split view) instead of navigating to full-page view
  emit('openThread', thread);
};

const handleCloseThread = async (thread: ThreadWithDetails) => {
  try {
    await threadService.archiveThread(thread.id);
    await loadActiveThreads(true); // Force refresh after mutation
  } catch (error) {
    debug.error('Failed to close thread:', error);
  }
};

const handleReopenThread = async (thread: ThreadWithDetails) => {
  try {
    await threadService.unarchiveThread(thread.id);
    await loadActiveThreads(true); // Force refresh after mutation
  } catch (error) {
    debug.error('Failed to reopen thread:', error);
  }
};

const handleLockThread = async (thread: ThreadWithDetails) => {
  try {
    await threadService.lockThread(thread.id);
    await loadActiveThreads(true); // Force refresh after mutation
  } catch (error) {
    debug.error('Failed to lock thread:', error);
  }
};

const handleUnlockThread = async (thread: ThreadWithDetails) => {
  try {
    await threadService.unlockThread(thread.id);
    await loadActiveThreads(true); // Force refresh after mutation
  } catch (error) {
    debug.error('Failed to unlock thread:', error);
  }
};

const handleDeleteThread = (thread: ThreadWithDetails) => {
  confirmationConfig.value = {
    title: 'Delete Thread',
    message: `Are you sure you want to delete "${thread.name}"?`,
    secondaryMessage: 'This will permanently delete the thread and all its messages. This action cannot be undone.',
    confirmButtonText: 'Delete Thread',
    requireConfirmation: false,
    confirmationText: thread.name,
    onConfirm: async () => {
      try {
        await threadService.deleteThread(thread.id);
        await loadActiveThreads(true); // Force refresh after mutation
        closeConfirmationModal();
        // Navigate back to channel if we were viewing this thread
        if (selectedThreadId.value === thread.id) {
          selectedThreadId.value = null;
          if (thread.channel_id) {
            router.push({
              name: 'ChatChannel',
              params: {
                serverId: props.currentServer?.id,
                channelId: thread.channel_id
              }
            });
          }
        }
      } catch (error) {
        debug.error('Failed to delete thread:', error);
        closeConfirmationModal();
      }
    }
  };
  showConfirmationModal.value = true;
};

const closeChannelEditModal = () => showChannelEditModal.value = false;
const closeCategoryEditModal = () => showCategoryEditModal.value = false;
const closeThreadEditModal = () => showThreadEditModal.value = false;
const closeConfirmationModal = () => showConfirmationModal.value = false;
const handleChannelUpdated = (_updatedChannel: Channel) => {}; // Store handles updates
const handleCategoryUpdated = (_updatedCategory: Category) => {}; // Store handles updates
const handleThreadUpdated = () => {
  // Refresh threads list after editing
  loadActiveThreads(true); // Force refresh after mutation
};

// Lifecycle Hooks
watch(() => props.currentServer?.id, async (newServerId, oldServerId) => {
  debug.log('🔄 Server changed:', { old: oldServerId, new: newServerId });
  if (newServerId) {
    initializeCategoryStates();
    // Setup voice channel broadcast for real-time updates
    // Await this to ensure voice channel state is fetched before rendering
    debug.log('📞 Setting up voice channel broadcast for server:', newServerId);
    await serverUsersStore.setupVoiceChannelBroadcast(newServerId);
    debug.log('✅ Voice channel broadcast setup complete for server:', newServerId);
    debug.log('👥 Users in voice channels:', serverUsersStore.usersInVoiceChannels);
  }
}, { immediate: true });

// NOTE: Voice channel broadcast setup is handled by the watch above with { immediate: true }
// No need for duplicate setup in onMounted - it was causing double initialization

watch(() => serverChannelStore.categories, () => categoryChannelsCache.value.clear(), { deep: true });
watch(() => serverChannelStore.categoryChannels, () => categoryChannelsCache.value.clear(), { deep: true });

// Load threads and muted state when server changes
watch(() => props.currentServer?.id, (newServerId) => {
  if (newServerId) {
    loadActiveThreads();
    loadMutedChannels();
  }
}, { immediate: true });

// Sync selectedThreadId with route (for thread full view)
watch(() => route.params.threadId, (threadId) => {
  if (threadId && typeof threadId === 'string') {
    selectedThreadId.value = threadId;
  } else {
    selectedThreadId.value = null;
  }
}, { immediate: true });

// Thread changes now arrive via server-structure broadcast

const threadChangeHandler = () => {
  debug.log('🧵 Thread change detected via broadcast');
  loadActiveThreads(true);
};

const setupThreadsSubscription = () => {
  if (!props.currentServer?.id) return;
  window.addEventListener('server-structure:thread-change', threadChangeHandler);
};

// Local update for channel mute toggles so the sidebar reflects the change
// immediately. The full refetch via `loadMutedChannels()` is reserved for
// server switches and component mount.
const channelMuteChangedHandler = (event: Event) => {
  const detail = (event as CustomEvent).detail as { channelId?: string; muted?: boolean } | undefined;
  if (!detail?.channelId) return;
  const next = new Set(mutedChannelIds.value);
  if (detail.muted) {
    next.add(detail.channelId);
  } else {
    next.delete(detail.channelId);
  }
  mutedChannelIds.value = next;
};

onMounted(() => {
  document.addEventListener('click', closeContextMenus);
  setupThreadsSubscription();
  window.addEventListener('channel-mute-changed', channelMuteChangedHandler);
});

onUnmounted(() => {
  document.removeEventListener('click', closeContextMenus);
  window.removeEventListener('server-structure:thread-change', threadChangeHandler);
  window.removeEventListener('channel-mute-changed', channelMuteChangedHandler);
});

// Re-setup subscription when server changes
watch(() => props.currentServer?.id, () => {
  setupThreadsSubscription();
});


</script>

<style scoped>
/* .channel-sidebar {
  width: 240px;
  min-width: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  height: 100vh;
} 
.channel-sidebar {
  background: var(--h-channel-sidebar, var(--background-tertiary));
  height: 100%;
}
*/

.server-header {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
}

.server-name {
  font-size: 1.2rem;
  font-weight: 500;
  background: var(--background-tertiary);
  color: var(--text-primary);
  position: relative;
  z-index: 1;
  text-align: center;
  cursor: pointer;
  transition: 0.2s ease-in-out;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1.2rem;
  border-bottom: 1px solid var(--border-color);
}

.server-name:hover {
  box-shadow: 0 1px 5px 0px rgba(0,0,0,0.25);
  background: var(--background-secondary);
}

/* Wrapper for channel + participants (required for draggable) */
.channel-wrapper {
  display: block;
  width: 100%;
}

.channel-item {
  padding: 6px 10px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  align-items: center;
  width: calc(100% - 8px);
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary, #949BA4);
  position: relative;
  border-radius: 4px;
  margin: 1px 4px;
}

.channel-item:hover {
  transform: translateX(2px);
  background-color: var(--channel-item-hover-bg, var(--background-quaternary));
}

.channel-item.selected {
  position: relative;
  background-color: var(--channel-item-selected-bg, var(--background-quaternary));
  color: var(--text-primary);
}

/* Voice channel connected state */
.channel-item.voice-connected {
  background-color: rgba(87, 242, 135, 0.1);
}

.channel-item.voice-connected:hover {
  background-color: rgba(87, 242, 135, 0.15);
}

/* Muted channels: dim the name + icon, but keep the bell-off indicator and
   the mention badge at full opacity. Mentions still cut through mute, and
   the bell-off icon is the visual cue that the channel IS muted. */
.channel-item.muted .channel-content {
  opacity: 0.5;
}

.channel-item.muted:hover .channel-content {
  opacity: 0.75;
}

/* The unread "channel-unread" bold/white styling shouldn't fire on muted
   channels even if some other store thinks there are unread messages. */
.channel-item.muted.channel-unread {
  color: var(--text-secondary, #949BA4);
}

.channel-item.muted.channel-unread .channel-name {
  font-weight: 400;
}

.muted-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  margin-left: auto;
}

.channel-item.dragging {
  opacity: 0.6;
  transform: scale(1.02) rotate(2deg);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
  z-index: 1000;
  background-color: rgba(14, 165, 233, 0.2);
  border: 1px solid #0EA5E9;
}

.channel-item.channel-unread {
  color: var(--text-primary, #f2f3f5);
}

.channel-item.channel-unread .channel-name {
  font-weight: 600;
}

.unread-dot {
  position: absolute;
  left: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-primary, #f2f3f5);
  flex-shrink: 0;
}

.channel-content {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.channel-content > svg {
  margin-right: 8px;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.channel-name {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category .channel-item {
  padding-left: 20px;
}

.category-section {
  margin-bottom: 8px;
}

.category-header {
  cursor: pointer;
  padding: 8px 10px;
  margin-top: 6px;
  display: flex;
  font-size: 12px;
  font-weight: 600;
  align-items: center;
  transition: all 0.15s ease;
  border-radius: 4px;
  margin: 2px 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary, #949BA4);
}

.category-header:hover {
  background-color: rgba(255, 255, 255, 0.05);
}

.category-arrow {
  width: 12px;
  height: 12px;
  transition: transform 0.2s ease;
  flex-shrink: 0;
  margin: auto 3px auto 0;
}

.category-arrow.rotated {
  transform: rotate(-90deg);
}

.channel-list {
  transition: all 0.2s ease;
}

.collapsed-list {
  display: block; /* Always show if there are important channels */
}

/* Channels in collapsed categories should be styled differently */
.channel-item.in-collapsed-category {
  opacity: 0.8;
}

.channel-item.in-collapsed-category.selected {
  opacity: 1;
  background-color: var(--channel-item-selected-bg, var(--background-quaternary));
  color: var(--text-primary);
}

/* Category header styling when collapsed but has visible channels */
.category-header.has-visible-channels.collapsed {
  opacity: 0.8;
}

/* .category-header.has-visible-channels.collapsed .category-name {
  font-size: 12px;
} */

/* Notification badge for channels with notifications */
.notification-badge {
  min-width: 18px;
  height: 18px;
  background-color: #f23f42;
  border-radius: 9px;
  margin-left: auto;
  margin-right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1;
  flex-shrink: 0;
}

/* Voice channel controls */
.voice-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.channel-item:hover .voice-controls {
  opacity: 1;
}

/* Always show controls when connected to voice */
.channel-item.voice-connected .voice-controls {
  opacity: 1;
}

.voice-btn {
  background: none;
  border: none;
  padding: 4px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #b5bac1);
}

.voice-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
  color: var(--text-normal, #fff);
}

.voice-btn svg {
  width: 16px;
  height: 16px;
}

.chat-btn {
  color: var(--text-muted, #b5bac1);
}

.chat-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
  color: var(--text-normal, #fff);
}

.user-count {
  font-size: 10px;
  background-color: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 10px;
  color: var(--text-primary);
  font-weight: 600;
  min-width: 16px;
  text-align: center;
}

/* Enhanced Drag & Drop Styles */
.orphan-channels {
  min-height: 20px;
  transition: all 0.2s ease;
  border-radius: 4px;
  position: relative;
  margin-bottom: 12px;
  padding: 4px;
}

.categories-container {
  flex: 1;
}

/* Channel Thread Items ( nested under channels) */
.channel-thread-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 2px 34px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary, #949BA4);
  font-size: 14px;
  transition: all 0.1s ease;
  position: relative;
  margin: 0 auto;
  width: calc(100% - 8px);
}
.channel-thread-item .thread-name {
  padding: 6px;
  border-radius: 4px;
  width: 100%;
}
.channel-thread-item .thread-name:hover {
  background: var(--channel-item-hover-bg, var(--background-quaternary));
}

.channel-thread-item.selected {
  color: var(--text-primary, #FFFFFF);
}
.channel-thread-item.selected .thread-name {
  color: var(--text-primary, #FFFFFF);
  background: var(--channel-item-selected-bg, var(--background-quaternary));
}

/* Thread branch/tree-line - vertical line connecting to parent */
.channel-thread-item .thread-branch {
  position: absolute;
  left: 16px;
  width: 10px;
  height: 100%;
  pointer-events: none;
}

/* Vertical line */
.channel-thread-item .thread-branch::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 50%;
  width: 2px;
  background: var(--text-muted, #4f545c);
  opacity: 0.5;
}

/* Horizontal line to text */
.channel-thread-item .thread-branch::after {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 2px;
  background: var(--text-muted, #4f545c);
  opacity: 0.5;
  border-radius: 0 2px 2px 0;
}

/* Last thread item - rounded corner */
.channel-thread-item:last-of-type .thread-branch::before {
  border-bottom-left-radius: 4px;
}

/* Not last - extend vertical line down */
.channel-thread-item:not(:last-of-type) .thread-branch::before {
  bottom: 0;
}

.channel-thread-item .thread-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

/* Global drag feedback */
:global(.dragging-channel) {
  cursor: grabbing !important;
}

:global(.dragging-channel *) {
  cursor: grabbing !important;
}

/* Empty category placeholder */
.empty-category-placeholder {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: rgb(142, 146, 151);
  border: 1px dashed rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  margin: 4px 0;
  transition: background-color 0.2s ease;
}

.empty-category-placeholder:hover {
  background-color: rgba(255, 255, 255, 0.05);
}

/* Context menu styles */
.channel-context-menu,
.category-context-menu {
  position: absolute;
  z-index: 1000;
  background: var(--background-tertiary);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
  padding: 8px 0;
  width: 200px;
}

.context-menu-item {
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.2s ease;
  font-size: 14px;
  color: rgb(220, 220, 220);
}

.context-menu-item:hover {
  background: rgba(255, 255, 255, 0.1);
}

/* Hide context menus by default */
.channel-context-menu,
.category-context-menu {
  display: none;
}

/* Show context menu when active */
.channel-context-menu.active,
.category-context-menu.active {
  display: block;
}

/* =====================================
   MOBILE RESPONSIVE STYLES
   ===================================== */

@media (max-width: 768px) {
  .server-header {
    width:100%;
  }
  /* Enhanced touch targets for mobile */
  .channel-item,
  .category-header {
    min-height: 48px;
    padding: 12px 24px;
    border-radius: 12px;
    margin: 4px 8px;
  }

  .channel-item {
    display: flex;
    align-items: center;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    width: calc(100% - 18px);
  }

  .channel-item:active {
    transform: scale(0.98);
    background: rgba(255, 255, 255, 0.08);
  }

  .channel-content {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
  }

  .channel-name {
    font-size: 16px;
    font-weight: 500;
  }

  .category-header {
    margin: 16px 0 8px;
  }

  .category-name {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  /* Voice channel mobile optimizations */
  .voice-channel-item {
    padding: 16px;
    border-radius: 12px;
  }

  .voice-info {
    padding: 12px 0;
  }

  .voice-users {
    gap: 8px;
  }

  .voice-user {
    padding: 8px 12px;
    border-radius: 8px;
    min-height: 44px;
  }


  /* Context menu adjustments for mobile */
  .channel-context-menu,
  .category-context-menu {
    width: 90vw;
    max-width: 280px;
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  }

  .context-menu-item {
    padding: 16px 20px;
    font-size: 16px;
    min-height: 52px;
    display: flex;
    align-items: center;
  }

  /* Reduce drag and drop functionality on mobile */
  .drag-disabled {
    user-select: none;
    -webkit-user-select: none;
  }

  .drag-disabled .channel-item,
  .drag-disabled .category-header {
    cursor: pointer !important;
  }
}

/* Tablet responsive adjustments */
@media (max-width: 1024px) and (min-width: 769px) {
  .channel-item,
  .category-header {
    min-height: 44px;
    padding: 10px 14px;
  }

  .channel-name {
    font-size: 15px;
  }

  .category-arrow {
    margin: 5px 3px auto 0;
  }
}
</style>