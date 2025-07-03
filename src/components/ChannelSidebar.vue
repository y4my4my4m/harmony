<template>
  <div class="channel-sidebar">
    <CategoryCreator
      v-if="isCategoryCreatorOpen"
      @showCategoryCreator="showCategoryCreator"
      @createCategory="createCategory"
    />
    <div class="server-name" @click="toggleDropdown">
      {{ currentServer.name }}
    </div>
    <ServerDropdown
      :serverId="currentServer.id"
      :isVisible="isDropdownOpen"
      @toggle="toggleDropdown"
      @showCategoryCreator="showCategoryCreator"
      @createChannel="emitCreateChannel"
    />
    
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
              'dragging': dragState.isDragging && dragState.draggedItem?.id === element.id
            }]" 
            @click="selectChannel(element.id)"
            :style="{ cursor: getDragCursor('channel') }"
            :data-channel-id="element.id"
            :data-category-id="null"
          >
            <div class="channel-content">
              <HashTagIcon v-if="element.type === 0" />
              <SpeakerIcon v-else /> 
              {{ element.name }}
            </div>
            <!-- Voice channel controls -->
            <div v-if="element.type === 1" class="voice-controls">
              <button
                v-if="!isUserInVoiceChannel(element.id)"
                @click.stop="joinVoiceChannel(element.id)"
                class="voice-btn join-btn"
                title="Join voice channel"
              >
                🎤
              </button>
              <button
                v-else
                @click.stop="leaveVoiceChannel(element.id)"
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

    <!-- Categories with their channels -->
    <template v-if="categories && categories.length > 0">
      <template v-for="category in combinedCategories" :key="category.id">
        <div class="category" :class="{ 'expanded': category.expanded }">
          <div class="category-name">
            <div class="category-name-holder" @click="toggleCategory(category.id)">
              <ArrowDownIcon /> 
              {{ category.name }}
            </div>
            <div 
              v-if="canCreateChannels" 
              class="create-channel" 
              @click="emitCreateChannel(category.id)"
            >
              +
            </div>
          </div>
          
          <!-- Category drop zone -->
          <draggable
            v-model="category.channels"
            :group="dragGroup"
            :disabled="!canDragAndDrop"
            @start="onDragStart"
            @end="onDragEnd"
            @add="(evt) => onChannelAddedToCategory(evt, category.id)"
            @remove="onChannelRemovedFromCategory"
            item-key="id"
            :class="{ 
              'category-items': true, 
              'drag-disabled': !canDragAndDrop,
              'drag-over': dragState.isOver && dragState.targetCategoryId === category.id
            }"
            tag="div"
          >
            <template #item="{ element }">
              <div 
                :key="element.id" 
                :class="['channel-item', 'category-channel', { 
                  'selected': element.id === currentChannelId,
                  'dragging': dragState.isDragging && dragState.draggedItem?.id === element.id
                }]" 
                @click="selectChannel(element.id)"
                :style="{ cursor: getDragCursor('channel') }"
                :data-channel-id="element.id"
                :data-category-id="category.id"
              >
                <div class="channel-content">
                  <HashTagIcon v-if="element.type === 0" />
                  <SpeakerIcon v-else /> 
                  {{ element.name }}
                </div>
                <!-- Voice channel controls -->
                <div v-if="element.type === 1" class="voice-controls">
                  <button
                    v-if="!isUserInVoiceChannel(element.id)"
                    @click.stop="joinVoiceChannel(element.id)"
                    class="voice-btn join-btn"
                    title="Join voice channel"
                  >
                    🎤
                  </button>
                  <button
                    v-else
                    @click.stop="leaveVoiceChannel(element.id)"
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
      </template>
    </template>
    
    <UserProfileComponent />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, watch } from 'vue';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import { useChannelPermissions } from '@/composables/useChannelPermissions';

import type { PropType } from 'vue';
import type { Channel, Category } from '@/types';

import ArrowDownIcon from '@/components/icons/ArrowDown.vue';
import HashTagIcon from '@/components/icons/HashTag.vue';
import SpeakerIcon from '@/components/icons/Speaker.vue';
import UserProfileComponent from './UserProfileComponent.vue';
import ServerDropdown from './ServerDropdown.vue';
import CategoryCreator from './CategoryCreator.vue';

import draggable from "vuedraggable";

interface DragState {
  isDragging: boolean;
  draggedItem: Channel | null;
  sourceCategoryId: string | null;
  targetCategoryId: string | null;
  isOver: boolean;
}

interface CategoryOpenState {
  [key: string]: boolean;
}

export default defineComponent({
  name: 'ChannelSidebar',
  components: {
    UserProfileComponent,
    ServerDropdown,
    CategoryCreator,
    ArrowDownIcon,
    HashTagIcon,
    SpeakerIcon,
    draggable,
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
    const isCategoryCreatorOpen = ref(false);
    const serverChannelStore = useServerChannelStore();
    const authStore = useAuthStore();
    const router = useRouter();
    
    // Use the channel permissions composable
    const {
      canDragAndDrop,
      canCreateChannels,
      canMoveChannelsBetweenCategories,
      getDragCursor,
      validateDragAndDrop,
    } = useChannelPermissions();

    const categoryOpenState = ref<CategoryOpenState>({});

    // Drag state management
    const dragState = ref<DragState>({
      isDragging: false,
      draggedItem: null,
      sourceCategoryId: null,
      targetCategoryId: null,
      isOver: false,
    });

    // Drag group configuration
    const dragGroup = computed(() => ({
      name: 'channels',
      put: canDragAndDrop.value,
      pull: canDragAndDrop.value,
    }));

    const userId = computed(() => {
      return authStore.session?.user?.id || '';
    });

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
        
        return props.channels.filter(channel => !categoryChannelIds.has(channel.id));
      },
      set: (newChannels) => {
        // Handle reordering of orphan channels
        serverChannelStore.updateChannelOrder(newChannels, null);
      }
    });

    const combinedCategories = computed(() => {
      if (!Array.isArray(props.categories)) {
        return [];
      }
      return props.categories.map(category => {
        const savedState = localStorage.getItem(`category-${category.id}-expanded`);
        const isExpanded = savedState !== null ? savedState === 'true' : true;
        
        return {
          ...category,
          expanded: isExpanded,
          channels: props.categoryChannels[category.id] || [],
        };
      });
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

    const onChannelAddedToCategory = async (evt: any, categoryId: string) => {
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
        
        // Refresh data to ensure consistency
        await serverChannelStore.fetchChannels(props.currentServer.id);
      } catch (error) {
        console.error('Failed to move channel to category:', error);
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
        
        // Refresh data to ensure consistency
        await serverChannelStore.fetchChannels(props.currentServer.id);
      } catch (error) {
        console.error('Failed to move channel to orphan channels:', error);
      }
    };

    const onChannelRemovedFromCategory = (evt: any) => {
      // This is handled by the add events, just logging for debugging
      console.log('Channel removed from category');
    };

    // Other methods
    const toggleDropdown = () => {
      isDropdownOpen.value = !isDropdownOpen.value;
    };

    const selectChannel = (channelId: string) => {
      router.push({ name: 'Chat', params: { serverId: props.currentServer.id, channelId } });
    };

    const emitCreateChannel = (categoryId?: string) => {
      emit('createChannel', categoryId);
    };

    const toggleCategory = (categoryId: string) => {
      const newState = !categoryOpenState.value[categoryId];
      categoryOpenState.value[categoryId] = newState;
      localStorage.setItem(`category-${categoryId}-expanded`, newState.toString());
    };

    const isCategoryOpen = (categoryId: string) => {
      return categoryOpenState.value[categoryId] !== false;
    };

    const showCategoryCreator = () => {
      isCategoryCreatorOpen.value = !isCategoryCreatorOpen.value;
    };

    const createCategory = (categoryName: string) => {
      emit('createCategory', categoryName);
      isCategoryCreatorOpen.value = false;
    };

    const handleChannelCreated = (channel: Channel) => {
      console.log('Channel created:', channel);
      selectChannel(channel.id);
      serverChannelStore.fetchChannels(props.currentServer.id);
    };

    // Voice channel methods
    const serverUsersStore = useServerUsersStore();

    const isUserInVoiceChannel = (channelId: string): boolean => {
      if (!userId.value) return false;
      return serverUsersStore.isUserInVoiceChannel(userId.value, channelId);
    };

    const getUsersInVoiceChannel = (channelId: string): string[] => {
      return serverUsersStore.getUsersInVoiceChannel(channelId);
    };

    const joinVoiceChannel = async (channelId: string) => {
      if (!userId.value || !props.currentServer?.id) return;
      
      try {
        // Leave any other voice channels first (user can only be in one at a time)
        await serverUsersStore.leaveAllVoiceChannels(props.currentServer.id, userId.value);
        
        // Join the new voice channel
        const success = await serverUsersStore.joinVoiceChannel(
          props.currentServer.id, 
          channelId, 
          userId.value
        );
        
        if (success) {
          console.log(`Successfully joined voice channel ${channelId}`);
        }
      } catch (error) {
        console.error('Failed to join voice channel:', error);
      }
    };

    const leaveVoiceChannel = async (channelId: string) => {
      if (!userId.value || !props.currentServer?.id) return;
      
      try {
        const success = await serverUsersStore.leaveVoiceChannel(
          props.currentServer.id, 
          channelId, 
          userId.value
        );
        
        if (success) {
          console.log(`Successfully left voice channel ${channelId}`);
        }
      } catch (error) {
        console.error('Failed to leave voice channel:', error);
      }
    };

    return { 
      isDropdownOpen, 
      toggleDropdown,
      selectChannel,
      serverChannelStore,
      emitCreateChannel,
      handleChannelCreated,
      toggleCategory,
      isCategoryOpen,
      isCategoryCreatorOpen,
      showCategoryCreator,
      createCategory,
      combinedCategories,
      orphanChannels,
      
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
  display: inline-flex;
  width: 100%;
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

.channel-item.dragging {
  opacity: 0.6;
  transform: scale(1.02) rotate(2deg);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
  z-index: 1000;
  background-color: rgba(88, 101, 242, 0.2);
  border: 1px solid #5865f2;
}

.channel-item > svg {
  margin-right: 10px;
  width: 16px;
  height: 16px;
  position: relative;
  top: 3px;
}

.category .channel-item {
  padding-left: 20px;
}

.category {
  margin-bottom: 2px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.category-name {
  cursor: pointer;
  padding: 8px 6px;
  margin-top: 6px;
  vertical-align: middle;
  display: flex;
  font-size: 16px;
  align-items: center;
  justify-content: space-between;
  transition: all 0.15s ease;
  border-radius: 4px;
  margin: 2px 4px;
}

.category-name:hover {
  background-color: rgba(255, 255, 255, 0.05);
}

.category-name .category-name-holder {
  flex-grow: 1;
}

.category-name svg {
  margin-right: 5px;
  width: 16px;
  height: 16px;
  top: 2px;
  position: relative;
  transition: 0.2s ease-in-out;
  transform: rotate(-90deg);
}

.category.expanded .category-name svg {
  transform: rotate(0deg);
}

.category .category-items {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              background-color 0.2s ease,
              border 0.2s ease,
              min-height 0.2s ease;
}

.category.expanded .category-items {
  max-height: 100vh;
}

.create-channel {
  cursor: pointer;
  padding: 0 10px;
  transition: all 0.15s ease;
  border-radius: 4px;
  font-size: 16px;
  font-weight: 500;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}

.create-channel:hover {
  opacity: 1;
  background-color: rgba(255, 255, 255, 0.1);
  transform: scale(1.1);
}

/* Enhanced Drag & Drop Styles */
.channel-item {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  border-radius: 4px;
  margin: 1px 4px;
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

/* Global drag feedback */
:global(.dragging-channel) {
  cursor: grabbing !important;
}

:global(.dragging-channel *) {
  cursor: grabbing !important;
}

/* Drop zone feedback */
.category-items {
  min-height: 20px;
  transition: all 0.2s ease;
  border-radius: 4px;
  position: relative;
}

.category-items:empty::after {
  content: '';
  display: block;
  height: 20px;
  background: transparent;
}

.category-items.drag-over {
  background-color: rgba(88, 101, 242, 0.1);
  border: 2px dashed #5865f2;
  min-height: 40px;
}

.category-items.drag-over::before {
  content: 'Drop channel here';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #5865f2;
  font-size: 12px;
  font-weight: 500;
  pointer-events: none;
  opacity: 0.8;
}

/* Orphan channels drop zone */
.orphan-channels {
  min-height: 20px;
  transition: all 0.2s ease;
  border-radius: 4px;
  position: relative;
  margin-bottom: 12px;
  padding: 4px;
}

.orphan-channels.drag-over {
  background-color: rgba(87, 242, 135, 0.1);
  border: 2px dashed #57f287;
  min-height: 40px;
}

.orphan-channels.drag-over::before {
  content: 'Drop to remove from category';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #57f287;
  font-size: 12px;
  font-weight: 500;
  pointer-events: none;
  opacity: 0.8;
}

/* Disable drag styles */
.drag-disabled {
  cursor: not-allowed !important;
}

.drag-disabled .channel-item {
  cursor: not-allowed !important;
}

.drag-disabled .channel-item:hover {
  transform: none !important;
}

/* Permission feedback */
.channel-item.no-permission {
  opacity: 0.6;
  position: relative;
}

.channel-item.no-permission::after {
  content: '🔒';
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  opacity: 0.7;
}

/* Smooth animations */
/* Hover effects */
.channel-item:hover {
  transform: translateX(2px);
  background-color: var(--h-sidebar-light);
}

.channel-item.selected:hover {
  transform: translateX(2px);
}

/* Focus improvements */
.channel-item:focus-visible {
  outline: 2px solid #5865f2;
  outline-offset: 2px;
  border-radius: 4px;
}

/* Loading states for drag operations */
.channel-item.moving {
  opacity: 0.5;
  pointer-events: none;
}

.channel-item.moving::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  border: 2px solid #5865f2;
  border-top: 2px solid transparent;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: translateY(-50%) rotate(0deg); }
  100% { transform: translateY(-50%) rotate(360deg); }
}

/* Category expansion improvements */
.category-name {
  transition: all 0.15s ease;
  border-radius: 4px;
  margin: 2px 4px;
}

/* Create channel button improvements */
.create-channel {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  opacity: 0.7;
  transition: all 0.15s ease;
}

.create-channel:hover {
  opacity: 1;
  background-color: rgba(255, 255, 255, 0.1);
  transform: scale(1.1);
}

/* Mobile improvements */
@media (max-width: 768px) {
  .channel-item {
    padding: 12px 16px;
    margin: 2px 0;
  }
  
  .channel-item:hover {
    transform: none;
  }
  
  .category-items.drag-over::before,
  .orphan-channels.drag-over::before {
    font-size: 14px;
  }
}

/* Accessibility improvements */
@media (prefers-reduced-motion: reduce) {
  .channel-item,
  .category,
  .category-items,
  .category-name,
  .create-channel {
    transition: none;
  }
  
  .channel-item.dragging {
    transform: none;
  }
  
  .channel-item:hover {
    transform: none;
  }
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .category-items.drag-over {
    border-color: #ffffff;
    background-color: rgba(255, 255, 255, 0.1);
  }
  
  .orphan-channels.drag-over {
    border-color: #ffffff;
    background-color: rgba(255, 255, 255, 0.1);
  }
}

/* Voice channel controls */
.channel-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.channel-content {
  display: flex;
  align-items: center;
  flex: 1;
}

.channel-content > svg {
  margin-right: 10px;
  width: 16px;
  height: 16px;
}

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

/* Voice channel active state */
.channel-item.voice-active {
  background-color: rgba(87, 242, 135, 0.1);
  border-left: 3px solid #57f287;
}

.channel-item.voice-active .voice-controls {
  opacity: 1;
}
</style>
