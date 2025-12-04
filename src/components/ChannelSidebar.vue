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
        :class="{ 'drag-disabled': !canDragAndDrop || isMobile }"
        tag="div"
      >
        <template #item="{ element }">
          <div :key="element.id" class="channel-wrapper">
            <div 
              :class="['channel-item', { 
                'selected': element.id === currentChannelId,
                'dragging': dragState.isDragging && dragState.draggedItem?.id === element.id,
                'voice-channel': element.type === 1,
                'voice-connected': element.type === 1 && isUserInVoiceChannel(element.id)
              }]" 
              @click="element.type === 1 ? handleVoiceChannelClick(element.id) : selectChannel(element.id)"
              @contextmenu="openChannelContextMenu($event, element)"
              :style="{ cursor: getDragCursor('channel', dragState.isDragging && dragState.draggedItem?.id === element.id) }"
              :data-channel-id="element.id"
              :data-category-id="null"
            >
              <div class="channel-content">
                <HashTagIcon v-if="element.type === 0" />
                <SpeakerIcon v-else /> 
                <span class="channel-name">{{ element.name }}</span>
              </div>
              <!-- Unread badge for channels without categories -->
              <div v-if="getChannelUnreadMentions(element.id) > 0" class="notification-badge">
                {{ getChannelUnreadMentions(element.id) > 99 ? '99+' : getChannelUnreadMentions(element.id) }}
              </div>
              <!-- Voice channel controls -->
              <div v-if="element.type === 1" class="voice-controls">
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
              v-if="element.type === 1 && isUserInVoiceChannel(element.id)"
              :participants="getVoiceChannelParticipants(element.id)"
              :session-start-time="getVoiceSessionStartTime(element.id)"
            />
            <!-- Voice channel users (for channels we're NOT in) -->
            <VoiceChannelUserList
              v-else-if="element.type === 1 && getUsersInVoiceChannel(element.id).length > 0"
              :user-ids="getUsersInVoiceChannel(element.id)"
              :call-start-time="getChannelCallStartTime(element.id)"
            />
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
            <ArrowDownIcon 
              class="category-arrow" 
              :class="{ 'rotated': collapsedCategories.has(category.id) }"
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
                <div :key="channel.id" class="channel-wrapper">
                  <div
                    class="channel-item"
                    :class="{ 
                      'selected': currentChannelId === channel.id,
                      'in-collapsed-category': collapsedCategories.has(category.id),
                      'dragging': dragState.isDragging && dragState.draggedItem?.id === channel.id,
                      'voice-channel': channel.type === 1,
                      'voice-connected': channel.type === 1 && isUserInVoiceChannel(channel.id)
                    }"
                    @click="channel.type === 1 ? handleVoiceChannelClick(channel.id) : selectChannel(channel.id)"
                    @contextmenu="openChannelContextMenu($event, channel)"
                    :style="{ cursor: getDragCursor('channel', dragState.isDragging && dragState.draggedItem?.id === channel.id) }"
                    :data-channel-id="channel.id"
                    :data-category-id="category.id"
                  >
                    <div class="channel-content">
                      <HashTagIcon v-if="channel.type === 0" />
                      <SpeakerIcon v-else />
                      <span class="channel-name">{{ channel.name }}</span>
                    </div>
                    <div v-if="getChannelUnreadMentions(channel.id) > 0" class="notification-badge">
                      {{ getChannelUnreadMentions(channel.id) > 99 ? '99+' : getChannelUnreadMentions(channel.id) }}
                    </div>
                    <!-- Voice channel controls -->
                    <div v-if="channel.type === 1" class="voice-controls">
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
                    v-if="channel.type === 1 && isUserInVoiceChannel(channel.id)"
                    :participants="getVoiceChannelParticipants(channel.id)"
                    :session-start-time="getVoiceSessionStartTime(channel.id)"
                  />
                  <!-- Voice channel users (for channels we're NOT in) -->
                  <VoiceChannelUserList
                    v-else-if="channel.type === 1 && getUsersInVoiceChannel(channel.id).length > 0"
                    :user-ids="getUsersInVoiceChannel(channel.id)"
                    :call-start-time="getChannelCallStartTime(channel.id)"
                  />
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

    <!-- Context Menus -->
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { debug } from '@/utils/debug'
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import { useChannelPermissions } from '@/composables/useChannelPermissions';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useNotificationStore } from '@/stores/useNotification';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useThemeStore } from '@/stores/useTheme';
import { statePersistence } from '@/services/StatePersistence';

import type { PropType } from 'vue';
import type { Channel, Category } from '@/types';

import ArrowDownIcon from '@/components/icons/ArrowDown.vue';
import HashTagIcon from '@/components/icons/HashTag.vue';
import SpeakerIcon from '@/components/icons/Speaker.vue';
import ChatBubbleIcon from '@/components/icons/ChatBubble.vue';
import ServerDropdown from './ServerDropdown.vue';
import CategoryCreator from './CategoryCreator.vue';
import InviteModal from './InviteModal.vue';
import VoiceChannelParticipants from '@/components/voice/VoiceChannelParticipants.vue';
import VoiceChannelUserList from '@/components/voice/VoiceChannelUserList.vue';
import ChannelContextMenu from './ChannelContextMenu.vue';
import CategoryContextMenu from './CategoryContextMenu.vue';
import ChannelEditModal from './ChannelEditModal.vue';
import CategoryEditModal from './CategoryEditModal.vue';
import ConfirmationModal from './ConfirmationModal.vue';

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
}>();

// State
const isDropdownOpen = ref(false);
const showInviteModal = ref(false);
const isCategoryCreatorOpen = ref(false);

// Context menu state
const showChannelContextMenu = ref(false);
const showCategoryContextMenu = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const selectedChannel = ref<Channel | null>(null);
const selectedCategory = ref<Category | null>(null);

// Modal state
const showChannelEditModal = ref(false);
const showCategoryEditModal = ref(false);
const showConfirmationModal = ref(false);
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
const serverUsersStore = useServerUsersStore();
const voiceChannelStore = useUnifiedVoiceChannelStore();
const themeStore = useThemeStore();
const { canDragAndDrop, canCreateChannels, canMoveChannelsBetweenCategories, getDragCursor } = useChannelPermissions();
const { triggerVoice } = useHapticSettings();

// Computed Properties
const isMobile = computed(() => 'ontouchstart' in window || navigator.maxTouchPoints > 0);

const dragGroup = computed(() => ({
  name: 'channels',
  put: canDragAndDrop.value && !isMobile.value,
  pull: canDragAndDrop.value && !isMobile.value,
}));

const currentServerData = computed(() => {
  const memberCount = Object.keys(serverUsersStore.userProfiles).length || props.currentServer.member_count || 0;
  return {
    id: props.currentServer.id,
    name: props.currentServer.name,
    icon_url: props.currentServer.icon_url,
    member_count: memberCount
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
  if (!canDragAndDrop.value) {
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

const onDragEnd = (evt: any) => {
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

const onChannelRemovedFromCategory = (evt: any) => {
  // This handles when a channel is removed from a category during drag operations
  // The actual move logic is handled by the corresponding @add event handler
  // This is mainly for cleanup or visual feedback if needed
  debug.log('Channel removed from category during drag operation');
};



const notificationStore = useNotificationStore();

const getChannelUnreadMentions = (channelId: string): number => {
  return notificationStore.unreadChannelMentions(channelId);
};

const hasNotifications = (channel: Channel): boolean => {
  return getChannelUnreadMentions(channel.id) > 0;
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
const handleVoiceChannelClick = async (channelId: string) => {
  if (isUserInVoiceChannel(channelId)) {
    await leaveVoiceChannel(channelId);
  } else {
    await joinVoiceChannel(channelId);
  }
};

// Open voice channel text chat
const openVoiceChannelChat = (channelId: string) => {
  selectChannel(channelId);
};
const emitCreateChannel = (categoryId?: string) => emit('createChannel', categoryId);
const showCategoryCreator = () => isCategoryCreatorOpen.value = !isCategoryCreatorOpen.value;
const openInviteModal = () => showInviteModal.value = true;
const closeInviteModal = () => showInviteModal.value = false;

const createCategory = async (categoryName: string) => {
  try {
    await serverChannelStore.createCategory(categoryName, props.currentServer.id);
  } catch (error) {
    debug.error('Failed to create category:', error);
  } finally {
    isCategoryCreatorOpen.value = false;
  }
};

const handleChannelCreated = (channel: Channel) => {
  selectChannel(channel.id);
  serverChannelStore.fetchChannels(props.currentServer.id);
};

const isUserInVoiceChannel = (channelId: string): boolean => voiceChannelStore.isConnected && voiceChannelStore.currentChannelId === channelId;
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

const joinVoiceChannel = async (channelId: string) => {
  if (await voiceChannelStore.joinVoiceChannel(channelId, props.currentServer.id)) {
    themeStore.testAudio('voice_connect');
    // Haptic feedback for voice connect
    triggerVoice('success');
  }
};

const leaveVoiceChannel = async (channelId: string) => {
  if (await voiceChannelStore.leaveVoiceChannel()) {
    themeStore.testAudio('voice_disconnect');
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

const handleDeleteCategory = (category: Category) => {
  selectedCategory.value = category;
  const channelCount = (props.categoryChannels[category.id] || []).length;
  confirmationConfig.value = {
    title: 'Delete Category',
    message: `Are you sure you want to delete "${category.name}"?`,
    secondaryMessage: channelCount > 0 ? `This category contains ${channelCount} channel(s). All channels will be moved to the top of the channel list.` : 'This action cannot be undone.',
    confirmButtonText: 'Delete Category',
    requireConfirmation: true,
    confirmationText: category.name,
    onConfirm: async () => {
      try {
        await serverChannelStore.deleteCategory(category.id);
        closeConfirmationModal();
      } catch (error) {
        debug.error('Failed to delete category:', error);
        closeConfirmationModal();
      }
    }
  };
  showConfirmationModal.value = true;
};

const closeChannelEditModal = () => showChannelEditModal.value = false;
const closeCategoryEditModal = () => showCategoryEditModal.value = false;
const closeConfirmationModal = () => showConfirmationModal.value = false;
const handleChannelUpdated = (updatedChannel: Channel) => {}; // Store handles updates
const handleCategoryUpdated = (updatedCategory: Category) => {}; // Store handles updates

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

onMounted(() => document.addEventListener('click', closeContextMenus));
onUnmounted(() => document.removeEventListener('click', closeContextMenus));


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
  background: var(--h-channel-sidebar, #2f3136);
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
  color: rgb(173, 173, 173);
  position: relative;
  border-radius: 4px;
  margin: 1px 4px;
}

.channel-item:hover {
  transform: translateX(2px);
  background-color: var(--h-sidebar-light);
}

.channel-item.selected {
  position: relative;
  background-color: var(--h-sidebar-light);
  color: #FFF;
}

/* Voice channel connected state */
.channel-item.voice-connected {
  background-color: rgba(87, 242, 135, 0.1);
}

.channel-item.voice-connected:hover {
  background-color: rgba(87, 242, 135, 0.15);
}

.channel-item.dragging {
  opacity: 0.6;
  transform: scale(1.02) rotate(2deg);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
  z-index: 1000;
  background-color: rgba(88, 101, 242, 0.2);
  border: 1px solid #5865f2;
}

.channel-content {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0; /* Prevents flex item from growing beyond container */
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
  color: rgb(142, 146, 151);
}

.category-header:hover {
  background-color: rgba(255, 255, 255, 0.05);
}

.category-arrow {
  width: 12px;
  height: 12px;
  transition: transform 0.2s ease;
  flex-shrink: 0;
  margin: 2px 3px auto 0;
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
  background-color: var(--h-sidebar-light);
  color: #FFF;
}

/* Category header styling when collapsed but has visible channels */
.category-header.has-visible-channels.collapsed {
  opacity: 0.8;
}

.category-header.has-visible-channels.collapsed .category-name {
  font-size: 12px;
}

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
  color: #ffffff;
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
  color: #ffffff;
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
  background: var(--h-sidebar);
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
}
</style>