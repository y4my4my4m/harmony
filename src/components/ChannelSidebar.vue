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
        :disabled="!canDragAndDrop"
        @start="onDragStart"
        @end="onDragEnd"
        @add="onChannelAddedToOrphans"
        item-key="id"
        :class="{ 'drag-disabled': !canDragAndDrop }"
        tag="div"
      >
        <template #item="{ element }">
          <div 
            :key="element.id" 
            :class="['channel-item', { 
              'selected': element.id === currentChannelId,
              'dragging': dragState.isDragging && dragState.draggedItem?.id === element.id,
              'mobile-disabled': isMobile && element.type === 1
            }]" 
            @click="selectChannel(element.id)"
            @contextmenu="openChannelContextMenu($event, element)"
            :style="{ cursor: element.type === 1 && isMobile ? 'pointer' : getDragCursor('channel', dragState.isDragging && dragState.draggedItem?.id === element.id) }"
            :data-channel-id="element.id"
            :data-category-id="null"
          >
            <div class="channel-content">
              <HashTagIcon v-if="element.type === 0" />
              <SpeakerIcon v-else /> 
              <span class="channel-name">{{ element.name }}</span>
            </div>
            <!-- Voice channel controls -->
            <div v-if="element.type === 1" class="voice-controls">                    <button
                      v-if="!isUserInVoiceChannel(element.id)"
                      @click.stop="joinVoiceChannel(element.id)"
                      @touchstart.stop="handleVoiceChannelTouch"
                      @touchend.stop="handleVoiceChannelTouch"
                      class="voice-btn join-btn"
                      title="Join voice channel"
                    >
                      🎤
                    </button>
                    <button
                      v-else
                      @click.stop="leaveVoiceChannel(element.id)"
                      @touchstart.stop="handleVoiceChannelTouch"
                      @touchend.stop="handleVoiceChannelTouch"
                      class="voice-btn leave-btn"
                      title="Leave voice channel"
                    >
                      🔇
                    </button>
              <span v-if="getUsersInVoiceChannel(element.id).length > 0" class="user-count">
                {{ getUsersInVoiceChannel(element.id).length }}
              </span>
            </div>
          </div>
        </template>
      </draggable>
    </div>

    <!-- Categories and Channels -->
    <draggable
      v-model="reorderableCategories"
      :group="{ name: 'categories', put: false, pull: false }"
      :disabled="!canDragAndDrop"
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
              :disabled="!canDragAndDrop"
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
                  class="channel-item"
                  :class="{ 
                    'selected': currentChannelId === channel.id,
                    'in-collapsed-category': collapsedCategories.has(category.id),
                    'dragging': dragState.isDragging && dragState.draggedItem?.id === channel.id,
                    'mobile-disabled': isMobile && channel.type === 1
                  }"
                  @click="selectChannel(channel.id)"
                  @contextmenu="openChannelContextMenu($event, channel)"
                  :style="{ cursor: channel.type === 1 && isMobile ? 'pointer' : getDragCursor('channel', dragState.isDragging && dragState.draggedItem?.id === channel.id) }"
                  :data-channel-id="channel.id"
                  :data-category-id="category.id"
                >
                  <div class="channel-content">
                    <HashTagIcon v-if="channel.type === 0" />
                    <SpeakerIcon v-else />
                    <span class="channel-name">{{ channel.name }}</span>
                  </div>
                  <div v-if="hasNotifications(channel)" class="notification-badge"></div>
                  <!-- Voice channel controls -->
                  <div v-if="channel.type === 1" class="voice-controls">
                    <button
                      v-if="!isUserInVoiceChannel(channel.id)"
                      @click.stop="joinVoiceChannel(channel.id)"
                      @touchstart.stop="handleVoiceChannelTouch"
                      @touchend.stop="handleVoiceChannelTouch"
                      class="voice-btn join-btn"
                      title="Join voice channel"
                    >
                      🎤
                    </button>
                    <button
                      v-else
                      @click.stop="leaveVoiceChannel(channel.id)"
                      @touchstart.stop="handleVoiceChannelTouch"
                      @touchend.stop="handleVoiceChannelTouch"
                      class="voice-btn leave-btn"
                      title="Leave voice channel"
                    >
                      🔇
                    </button>
                    <span v-if="getUsersInVoiceChannel(channel.id).length > 0" class="user-count">
                      {{ getUsersInVoiceChannel(channel.id).length }}
                    </span>
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

<script lang="ts">
import { defineComponent, ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import { useChannelPermissions } from '@/composables/useChannelPermissions';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useThemeStore } from '@/stores/useTheme';
import { statePersistence } from '@/services/StatePersistence';

import type { PropType } from 'vue';
import type { Channel, Category } from '@/types';

import ArrowDownIcon from '@/components/icons/ArrowDown.vue';
import HashTagIcon from '@/components/icons/HashTag.vue';
import SpeakerIcon from '@/components/icons/Speaker.vue';
import ServerDropdown from './ServerDropdown.vue';
import CategoryCreator from './CategoryCreator.vue';
import InviteModal from './InviteModal.vue';
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

export default defineComponent({
  name: 'ChannelSidebar',
  components: {
    ServerDropdown,
    CategoryCreator,
    ArrowDownIcon,
    HashTagIcon,
    SpeakerIcon,
    draggable,
    InviteModal,
    ChannelContextMenu,
    CategoryContextMenu,
    ChannelEditModal,
    CategoryEditModal,
    ConfirmationModal,
  },
  props: {
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
  },
  setup(props, { emit }) {
    const isDropdownOpen = ref(false);
    const showInviteModal = ref(false);
    const isCategoryCreatorOpen = ref(false);
    const serverChannelStore = useServerChannelStore();
    const authStore = useAuthStore();
    const router = useRouter();
    
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
    
    // Use the channel permissions composable
    const {
      canDragAndDrop,
      canCreateChannels,
      canMoveChannelsBetweenCategories,
      getDragCursor,
    } = useChannelPermissions();

    // Drag state management
    const dragState = ref<DragState>({
      isDragging: false,
      draggedItem: null,
      sourceCategoryId: null,
      targetCategoryId: null,
      isOver: false,
    });

    // Check if we're on mobile device
    const isMobile = computed(() => {
      return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    });

    // Modify drag group to disable on mobile for voice channels
    const dragGroup = computed(() => ({
      name: 'channels',
      put: canDragAndDrop.value && !isMobile.value,
      pull: canDragAndDrop.value && !isMobile.value,
    }));

    // Handle voice channel touch events to prevent drag conflict
    const handleVoiceChannelTouch = (event: TouchEvent) => {
      // Stop event propagation to prevent drag and drop from interfering
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const userId = computed(() => {
      return authStore.session?.user?.id || '';
    });

    // Enhanced collapsed categories state with persistence
    const collapsedCategories = ref(new Set<string>())

    // Initialize category collapse states from persistence
    const initializeCategoryStates = async () => {
      if (!props.currentServer?.id) return
      
      try {
        await statePersistence.initialize()
        const savedStates = statePersistence.getServerCategoryStates(props.currentServer.id)
        
        // Apply saved collapse states
        const newCollapsedSet = new Set<string>()
        Object.entries(savedStates).forEach(([categoryId, isCollapsed]) => {
          if (isCollapsed) {
            newCollapsedSet.add(categoryId)
          }
        })
        
        collapsedCategories.value = newCollapsedSet
        console.log('📂 Initialized category states for server:', props.currentServer.id, savedStates)
      } catch (error) {
        console.warn('⚠️ Failed to initialize category states:', error)
      }
    }

    // Watch for server changes to load category states
    watch(() => props.currentServer?.id, async (newServerId) => {
      if (newServerId) {
        await initializeCategoryStates()
      }
    }, { immediate: true })

    // Compute orphan channels (channels not in any category)
    const orphanChannels = computed({
      get: () => {
        if (!props.channels || !Array.isArray(props.channels)) {
          return [];
        }
        
        const categoryChannelIds = new Set();
        Object.values(props.categoryChannels || {}).forEach(channels => {
          channels.forEach(channel => categoryChannelIds.add(channel.id));
        });
        
        return props.channels
          .filter(channel => !categoryChannelIds.has(channel.id))
          .sort((a, b) => (a.order || 0) - (b.order || 0));
      },
      set: async (newChannels) => {
        // Handle reordering of orphan channels
        try {
          await serverChannelStore.reorderChannelsInCategory(null, newChannels);
        } catch (error) {
          console.error('Failed to reorder orphan channels:', error);
        }
      }
    });

    // Create computed properties for each category's channels with proper setters
    const getCategoryChannelsComputed = (categoryId: string) => {
      return computed({
        get: () => {
          const categoryChannels = props.categoryChannels?.[categoryId] || [];
          const channelsInCategory = props.channels
            .filter(channel => categoryChannels.some(catChannel => catChannel.id === channel.id))
            .sort((a, b) => (a.order || 0) - (b.order || 0));
          
          // If category is collapsed, only show selected channel and channels with notifications
          if (collapsedCategories.value.has(categoryId)) {
            return channelsInCategory.filter(channel => 
              channel.id === props.currentChannelId || hasNotifications(channel)
            );
          }
          
          // If expanded, show all channels
          return channelsInCategory;
        },
        set: async (newChannels: Channel[]) => {
          // Handle reordering within the same category
          try {
            await serverChannelStore.reorderChannelsInCategory(categoryId, newChannels);
          } catch (error) {
            console.error(`Failed to reorder channels in category ${categoryId}:`, error);
          }
        }
      });
    };

    // Cache computed properties for categories to avoid recreation
    const categoryChannelsCache = ref<Map<string, any>>(new Map());
    
    const getCachedCategoryChannels = (categoryId: string) => {
      if (!categoryChannelsCache.value.has(categoryId)) {
        categoryChannelsCache.value.set(categoryId, getCategoryChannelsComputed(categoryId));
      }
      return categoryChannelsCache.value.get(categoryId);
    };

    // Clear cache when categories change - watch store categories instead of props
    watch(() => serverChannelStore.categories, () => {
      categoryChannelsCache.value.clear();
    }, { deep: true });

    // Also clear cache when store categoryChannels mapping changes
    watch(() => serverChannelStore.categoryChannels, () => {
      categoryChannelsCache.value.clear();
    }, { deep: true });

    // Instead of using props.categories, read directly from store for immediate reactivity
    const storeCategories = computed(() => serverChannelStore.categories);

    const combinedCategories = computed(() => {
      if (!Array.isArray(storeCategories.value)) {
        return [];
      }
      return storeCategories.value.map(category => {
        return {
          ...category,
          expanded: !collapsedCategories.value.has(category.id), // Use our centralized state
          channels: props.categoryChannels[category.id] || [],
        };
      });
    });

    // Force reactivity by using a key that changes when categories change
    const categoriesKey = computed(() => {
      return serverChannelStore.categories.map((c: any) => `${c.id}-${c.order}`).join(',');
    });

    // Reorderable categories for drag and drop - now reactive to store changes
    const reorderableCategories = computed({
      get: () => {
        // console.log('🔄 Categories getter called, current order:', serverChannelStore.categories.map(c => `${c.name}(${c.order})`));
        return combinedCategories.value;
      },
      set: (newCategories) => {
        // console.log('🎯 Setting new category order:', newCategories.map(c => `${c.name}(${c.order})`));
        // Handle category reordering
        serverChannelStore.updateCategoryOrder(newCategories);
      }
    });

    // Drag event handlers
    const onDragStart = (evt: any) => {
      if (!canDragAndDrop.value) {
        evt.preventDefault();
        return false;
      }

      const channelId = evt.item.dataset.channelId;
      const categoryId = evt.item.dataset.categoryId;
      
      // Find the channel being dragged
      let draggedChannel: Channel | null = null;
      
      if (categoryId === 'null' || !categoryId) {
        // Dragging from orphan channels
        draggedChannel = orphanChannels.value.find(ch => ch.id === channelId) || null;
      } else {
        // Dragging from a category
        const categoryChannels = props.categoryChannels[categoryId] || [];
        draggedChannel = categoryChannels.find(ch => ch.id === channelId) || null;
      }

      if (!draggedChannel) {
        console.error('Could not find dragged channel:', channelId);
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

      // Add visual feedback
      document.body.classList.add('dragging-channel');
    };

    const onDragEnd = async (evt: any) => {
      // Clean up visual feedback
      document.body.classList.remove('dragging-channel');
      
      const wasSuccessfulMove = evt.to !== evt.from || evt.newIndex !== evt.oldIndex;
      
      if (wasSuccessfulMove && dragState.value.draggedItem) {
        console.log('Drag completed successfully');
      }

      // Reset drag state
      dragState.value = {
        isDragging: false,
        draggedItem: null,
        sourceCategoryId: null,
        targetCategoryId: null,
        isOver: false,
      };
    };

    const onChannelAddedToCategory = async (evt: { item: HTMLElement }, categoryId: string) => {
      if (!canMoveChannelsBetweenCategories.value) {
        console.warn('No permission to move channels between categories');
        return;
      }

      const channelId = evt.item.dataset.channelId;
      const draggedChannel = dragState.value.draggedItem;

      if (!draggedChannel || draggedChannel.id !== channelId) {
        console.error('Channel data mismatch during category move');
        return;
      }

      try {
        console.log(`Moving channel ${channelId} to category ${categoryId}`);
        await serverChannelStore.moveChannelToCategory(channelId, categoryId);
        // No need to refresh data - optimistic updates handle this
      } catch (error) {
        console.error('Failed to move channel to category:', error);
        // The store will automatically rollback on error
      }
    };

    const onChannelAddedToOrphans = async (evt: any) => {
      if (!canMoveChannelsBetweenCategories.value) {
        console.warn('No permission to move channels');
        return;
      }

      const channelId = evt.item.dataset.channelId;
      const draggedChannel = dragState.value.draggedItem;

      if (!draggedChannel || draggedChannel.id !== channelId) {
        console.error('Channel data mismatch during orphan move');
        return;
      }

      try {
        console.log(`Moving channel ${channelId} to orphan channels (no category)`);
        await serverChannelStore.moveChannelToCategory(channelId, null);
        // No need to refresh data - optimistic updates handle this
      } catch (error) {
        console.error('Failed to move channel to orphan channels:', error);
        // The store will automatically rollback on error
      }
    };

    const onChannelRemovedFromCategory = () => {
      // This is handled by the add events, just logging for debugging
      console.log('Channel removed from category');
    };

    // Channel filtering and organization
    const getVisibleChannelsForCategory = (category: Category): Channel[] => {
      const categoryChannels = props.categoryChannels?.[category.id] || [];
      const channelsInCategory = props.channels.filter(channel => 
        categoryChannels.some(catChannel => catChannel.id === channel.id)
      );
      
      // If category is collapsed, only show selected channel and channels with notifications
      if (collapsedCategories.value.has(category.id)) {
        return channelsInCategory.filter(channel => 
          channel.id === props.currentChannelId || hasNotifications(channel)
        );
      }
      
      // If expanded, show all channels
      return channelsInCategory;
    };

    // Channel icon mapping
    const getChannelIcon = (channelType: number): string => {
      // Updated to handle numeric channel types
      const iconMap: Record<number, string> = {
        0: 'HashTagIcon', // text channel
        1: 'SpeakerIcon', // voice channel
        2: 'mdi-video', // video channel
        3: 'mdi-bullhorn', // announcement channel
        4: 'mdi-forum' // forum channel
      };
      return iconMap[channelType] || 'HashTagIcon';
    };

    // Enhanced notification checking
    const hasNotifications = (channel: Channel): boolean => {
      // TODO: Implement actual notification checking logic
      // For now, return false, but this should check for:
      // - Unread messages  
      // - Mentions
      // - Important announcements
      console.log('Checking notifications for channel:', channel.id);
      return false;
    };

    // Updated helper to determine if category content should be shown
    const shouldShowCategoryContent = (category: Category): boolean => {
      const categoryChannels = props.categoryChannels?.[category.id] || [];
      const channelsInCategory = props.channels.filter(channel => 
        categoryChannels.some(catChannel => catChannel.id === channel.id)
      );
      
      // Always show if category is expanded
      if (!collapsedCategories.value.has(category.id)) {
        return channelsInCategory.length > 0;
      }
      
      // If collapsed, show if there are important channels (selected or with notifications)
      const hasImportantChannels = channelsInCategory.some(channel => 
        channel.id === props.currentChannelId || hasNotifications(channel)
      );
      
      return hasImportantChannels;
    };

    // Category collapse toggle with persistence
    const toggleCategory = async (categoryId: string) => {
      const wasCollapsed = collapsedCategories.value.has(categoryId)
      
      if (wasCollapsed) {
        collapsedCategories.value.delete(categoryId)
      } else {
        collapsedCategories.value.add(categoryId)
      }
      
      // Persist the new state
      if (props.currentServer?.id) {
        try {
          await statePersistence.setCategoryCollapseState(
            props.currentServer.id, 
            categoryId, 
            !wasCollapsed
          )
        } catch (error) {
          console.warn('⚠️ Failed to persist category collapse state:', error)
        }
      }
      
      console.log('📂 Category toggled:', { categoryId, collapsed: !wasCollapsed })
    }

    // Helper functions for Discord-like behavior
    const toggleDropdown = () => {
      isDropdownOpen.value = !isDropdownOpen.value;
    };

    const selectChannel = (channelId: string) => {
      router.push({ name: 'Chat', params: { serverId: props.currentServer.id, channelId } });
    };

    const emitCreateChannel = (categoryId?: string) => {
      emit('createChannel', categoryId);
    };

    const showCategoryCreator = () => {
      isCategoryCreatorOpen.value = !isCategoryCreatorOpen.value;
    };

    const openInviteModal = () => {
      showInviteModal.value = true;
    };

    const closeInviteModal = () => {
      showInviteModal.value = false;
    };

    // Current server data for invite modal
    const currentServerData = computed(() => {
      // Get member count from the users store since it's more accurate
      const memberCount = Object.keys(serverUsersStore.userProfiles).length || props.currentServer.member_count || 0;
      
      return {
        id: props.currentServer.id,
        name: props.currentServer.name,
        icon_url: props.currentServer.icon_url,
        member_count: memberCount
      };
    });

    const createCategory = async (categoryName: string) => {
      try {
        const category = await serverChannelStore.createCategory(categoryName, props.currentServer.id);
        if (category) {
          // Refresh categories and channels to show the new category
          await serverChannelStore.fetchCategoriesAndChannels(props.currentServer.id);
          console.log('Category created successfully:', category);
        }
      } catch (error) {
        console.error('Failed to create category:', error);
      } finally {
        isCategoryCreatorOpen.value = false;
      }
    };

    const handleChannelCreated = (channel: Channel) => {
      console.log('Channel created:', channel);
      selectChannel(channel.id);
      serverChannelStore.fetchChannels(props.currentServer.id);
    };

    // Voice channel methods
    const serverUsersStore = useServerUsersStore();
    const voiceChannelStore = useUnifiedVoiceChannelStore();
    const themeStore = useThemeStore();
    
    // Voice connection audio and state

    const isUserInVoiceChannel = (channelId: string): boolean => {
      if (!userId.value) return false;
      // Check if we're connected to this specific voice channel via the voice store
      return voiceChannelStore.isConnected && voiceChannelStore.currentChannelId === channelId;
    };

    const getUsersInVoiceChannel = (channelId: string): string[] => {
      return serverUsersStore.getUsersInVoiceChannel(channelId);
    };

    const joinVoiceChannel = async (channelId: string) => {
      if (!userId.value || !props.currentServer?.id) return;
      
      try {
        console.log(`🎯 Joining voice channel ${channelId} directly`);
        
        // Join voice channel directly without navigating away from current text channel
        const success = await voiceChannelStore.joinVoiceChannel(channelId, props.currentServer.id);
        
        if (success) {
          console.log(`✅ Successfully joined voice channel ${channelId}`);
          themeStore.testAudio('voice_connect');
        } else {
          console.error('❌ Failed to join voice channel');
        }
      } catch (error) {
        console.error('❌ Error joining voice channel:', error);
      }
    };

    const leaveVoiceChannel = async (channelId: string) => {
      if (!userId.value || !props.currentServer?.id) return;
      
      try {
        // Use the voice channel store which handles both WebRTC disconnection and server presence
        const success = await voiceChannelStore.leaveVoiceChannel();
        
        if (success) {
          console.log(`Successfully left voice channel ${channelId}`);
          themeStore.testAudio('voice_disconnect');
        }
      } catch (error) {
        console.error('Failed to leave voice channel:', error);
      }
    };

    // Context menu handlers
    const openChannelContextMenu = (event: MouseEvent, channel: Channel) => {
      event.preventDefault();
      event.stopPropagation();
      
      selectedChannel.value = channel;
      contextMenuPosition.value = { x: event.clientX, y: event.clientY };
      showChannelContextMenu.value = true;
      
      // Close category context menu if open
      showCategoryContextMenu.value = false;
    };

    const openCategoryContextMenu = (event: MouseEvent, category: Category) => {
      event.preventDefault();
      event.stopPropagation();
      
      selectedCategory.value = category;
      contextMenuPosition.value = { x: event.clientX, y: event.clientY };
      showCategoryContextMenu.value = true;
      
      // Close channel context menu if open
      showChannelContextMenu.value = false;
    };

    const closeContextMenus = () => {
      showChannelContextMenu.value = false;
      showCategoryContextMenu.value = false;
      selectedChannel.value = null;
      selectedCategory.value = null;
    };

    // Context menu action handlers
    const handleInviteUsers = () => {
      openInviteModal();
    };

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
            console.log('Channel deleted successfully:', channel.name);
            showConfirmationModal.value = false;
          } catch (error) {
            console.error('Failed to delete channel:', error);
            // TODO: Show error notification
            showConfirmationModal.value = false;
          }
        }
      };
      showConfirmationModal.value = true;
    };

    const handleCreateChannelInCategory = (category: Category) => {
      emit('createChannel', category.id);
    };

    const handleEditCategory = (category: Category) => {
      selectedCategory.value = category;
      showCategoryEditModal.value = true;
    };

    const handleDeleteCategory = (category: Category) => {
      selectedCategory.value = category;
      const channelCount = (props.categoryChannels[category.id] || []).length;
      const channelText = channelCount === 1 ? 'channel' : 'channels';
      
      confirmationConfig.value = {
        title: 'Delete Category',
        message: `Are you sure you want to delete "${category.name}"?`,
        secondaryMessage: channelCount > 0 
          ? `This category contains ${channelCount} ${channelText}. All channels will be moved to the top of the channel list.`
          : 'This action cannot be undone.',
        confirmButtonText: 'Delete Category',
        requireConfirmation: true,
        confirmationText: category.name,
        onConfirm: async () => {
          try {
            await serverChannelStore.deleteCategory(category.id);
            console.log('Category deleted successfully:', category.name);
            showConfirmationModal.value = false;
          } catch (error) {
            console.error('Failed to delete category:', error);
            // TODO: Show error notification
            showConfirmationModal.value = false;
          }
        }
      };
      showConfirmationModal.value = true;
    };

    // Modal handlers
    const closeChannelEditModal = () => {
      showChannelEditModal.value = false;
      selectedChannel.value = null;
    };

    const closeCategoryEditModal = () => {
      showCategoryEditModal.value = false;
      selectedCategory.value = null;
    };

    const closeConfirmationModal = () => {
      showConfirmationModal.value = false;
    };

    const handleChannelUpdated = (updatedChannel: Channel) => {
      // The store handles updating the local state
      console.log('Channel updated:', updatedChannel.name);
    };

    const handleCategoryUpdated = (updatedCategory: Category) => {
      // The store handles updating the local state
      console.log('Category updated:', updatedCategory.name);
    };

    // Close context menus when clicking outside
    const handleGlobalClick = () => {
      closeContextMenus();
    };

    // Add global click listener
    onMounted(() => {
      document.addEventListener('click', handleGlobalClick);
    });

    onUnmounted(() => {
      document.removeEventListener('click', handleGlobalClick);
    });

    return { 
      isDropdownOpen, 
      toggleDropdown,
      selectChannel,
      serverChannelStore,
      emitCreateChannel,
      handleChannelCreated,
      toggleCategory,
      collapsedCategories,
      isCategoryCreatorOpen,
      showCategoryCreator,
      createCategory,
      combinedCategories,
      reorderableCategories,
      orphanChannels,
      categoriesKey, // Add this to expose it to the template
      showInviteModal,
      openInviteModal,
      closeInviteModal,
      currentServerData,
      
      // Channel filtering functions
      getVisibleChannelsForCategory,
      getChannelIcon,
      hasNotifications,
      shouldShowCategoryContent,
      getCachedCategoryChannels,
      
      // Drag & Drop
      dragState,
      dragGroup,
      onDragStart,
      onDragEnd,
      onChannelAddedToCategory,
      onChannelAddedToOrphans,
      onChannelRemovedFromCategory,
      
      // Permissions
      canDragAndDrop,
      canCreateChannels,
      getDragCursor,
      
      // Voice channel methods
      isUserInVoiceChannel,
      getUsersInVoiceChannel,
      joinVoiceChannel,
      leaveVoiceChannel,
      handleVoiceChannelTouch,
      isMobile,

      // Context menu state
      showChannelContextMenu,
      showCategoryContextMenu,
      contextMenuPosition,
      selectedChannel,
      selectedCategory,
      openChannelContextMenu,
      openCategoryContextMenu,
      closeContextMenus,
      handleInviteUsers,
      handleEditChannel,
      handleDeleteChannel,
      handleCreateChannelInCategory,
      handleEditCategory,
      handleDeleteCategory,
      
      // Modal state
      showChannelEditModal,
      showCategoryEditModal,
      showConfirmationModal,
      confirmationConfig,
      
      // Modal handlers
      closeChannelEditModal,
      closeCategoryEditModal,
      closeConfirmationModal,
      handleChannelUpdated,
      handleCategoryUpdated,
    };
  }
});
</script>

<style scoped>
.channel-sidebar {
  width: 240px;
  min-width: 240px;
  background-color: var(--h-sidebar);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.server-header {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
}

.server-name {
  padding: 10px;
  font-size: 1.2rem;
  font-weight: 500;
  background: var(--vt-c-divider-light-2);
  position: relative;
  z-index: 1;
  box-shadow: 0 1px 5px 0px rgba(0,0,0,0.25);
  text-align: center;
  cursor: pointer;
  transition: 0.2s ease-in-out;
}

.server-name:hover {
  background: rgba(0,0,0,0.1);
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

.channel-item.mobile-disabled {
  opacity: 0.8;
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  position: relative;
  background: linear-gradient(135deg, rgba(250, 166, 26, 0.1), rgba(250, 166, 26, 0.05));
  border: 1px solid rgba(250, 166, 26, 0.2);
}

.channel-item.mobile-disabled::after {
  content: 'Join Voice';
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  color: #faa61a;
  background: rgba(250, 166, 26, 0.2);
  padding: 4px 8px;
  border-radius: 6px;
  white-space: nowrap;
  border: 1px solid rgba(250, 166, 26, 0.3);
  font-weight: 500;
}

.channel-item.mobile-disabled .voice-controls {
  /* Ensure voice controls are easily tappable on mobile */
  z-index: 10;
  position: relative;
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
  width: 6px;
  height: 6px;
  background-color: #f23f42;
  border-radius: 50%;
  margin-left: auto;
  margin-right: 8px;
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

.voice-btn {
  background: none;
  border: none;
  padding: 4px 6px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
}

.voice-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
  transform: scale(1.1);
}

.join-btn {
  color: #57f287;
}

.join-btn:hover {
  background-color: rgba(87, 242, 135, 0.2);
  color: #57f287;
}

.leave-btn {
  color: #ed4245;
}

.leave-btn:hover {
  background-color: rgba(237, 66, 69, 0.2);
  color: #ed4245;
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
