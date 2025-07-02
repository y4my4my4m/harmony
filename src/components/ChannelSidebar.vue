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
    <div>
      <draggable
        class="category-items"
        v-model="orphanChannels"
        group="channels"
        :data-category-index="null"
        @end="onEndDrag"
        delay="250"
        delay-on-touch-only
      >
        <template #item="{ element }">
          <div :key="element.id" :class="['channel-item', { 'selected': element.id === currentChannelId }]" @click="selectChannel(element.id)">
            <HashTagIcon v-if="element.type==0"/><SpeakerIcon v-else /> {{ element.name }}
          </div>
        </template>
      </draggable>
    </div>
    <template v-if="categories && categories.length !== 0">
      <template v-for="(category, index) in combinedCategories" :key="category.id">
        <div class="category" :class="{'expanded' : category.expanded }">
          <div class="category-name">
            <div class="category-name-holder" @click="toggleCategory(category.id)">
              <ArrowDownIcon /> 
              {{ category.name }}
            </div>
            <div class="create-channel" @click="emitCreateChannel(category.id)">+</div>
          </div>
          <draggable
            class="category-items"
            v-model="category.channels"
            group="channels"
            :data-category-index="index"
            @start="onStartDrag"
            @end="onEndDrag"
            delay="250"
            delay-on-touch-only
          >
            <template #item="{ element }">
              <div :key="element.id" :class="['channel-item', { 'selected': element.id === currentChannelId }]" @click="selectChannel(element.id)">
                <HashTagIcon v-if="element.type==0"/><SpeakerIcon v-else /> {{ element.name }}
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
import { defineComponent, ref, computed } from 'vue';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';

import type { PropType } from 'vue';
import type { Channel, Category } from '@/types';

import ArrowDownIcon from '@/components/icons/ArrowDown.vue';
import HashTagIcon from '@/components/icons/HashTag.vue';
import SpeakerIcon from '@/components/icons/Speaker.vue';
import UserProfileComponent from './UserProfileComponent.vue';
import ServerDropdown from './ServerDropdown.vue';
import CategoryCreator from './CategoryCreator.vue';

import draggable from "vuedraggable";

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
    // TODO: were using the store but maybe it should just be passed as a prop from ChatView?
    const serverChannelStore = useServerChannelStore();
    const serverUsers = useServerUsersStore();
    const authStore = useAuthStore();
    const router = useRouter();
    interface CategoryOpenState {
      [key: string]: boolean;
    }
    const categoryOpenState = ref<CategoryOpenState>({});
    const voiceConnected = ref('');
    const voiceOnSound = ref(new Audio('/assets/sounds/voice_connect.mp3'));
    const voiceOffSound = ref(new Audio('/assets/sounds/voice_disconnect.mp3'));
    const userId = computed(() => {
      return authStore.session?.user?.id || '';
      // return localStorage.getItem('userId') || '';
    });

    const combinedCategories = computed(() => {
      if (!Array.isArray(props.categories)) {
        return [];
      }
      return props.categories.map(category => ({
        ...category,
        channels: props.categoryChannels[category.id] || [],
      }));
    });

    const orphanChannels = computed(() => {
      return props.channels.filter(channel => !channel.category);
    });
  
    const draggedChannel = ref<Channel | null>(null);

    const onStartDrag = (event: any) => {
      // Store the dragged channel reference more reliably
      const element = event.item
      const channelId = element.getAttribute('data-channel-id') || element.querySelector('.channel-item')?.getAttribute('data-channel-id')
      
      if (channelId) {
        draggedChannel.value = props.channels.find(ch => ch.id === channelId) || null
      } else {
        // Fallback to the old method
        const originalCategoryIndex = event.from.dataset.categoryIndex ? Number(event.from.dataset.categoryIndex) : null
        
        if (originalCategoryIndex !== null && combinedCategories.value[originalCategoryIndex]) {
          const originalCategory = combinedCategories.value[originalCategoryIndex]
          if (event.oldIndex >= 0 && event.oldIndex < originalCategory.channels.length) {
            draggedChannel.value = originalCategory.channels[event.oldIndex]
          }
        } else {
          // Handle orphan channels
          if (event.oldIndex >= 0 && event.oldIndex < orphanChannels.value.length) {
            draggedChannel.value = orphanChannels.value[event.oldIndex]
          }
        }
      }
    }

    const onEndDrag = (event: any) => {
      // Use the stored dragged channel reference
      if (!draggedChannel.value) {
        console.error("Dragged channel not found - drag operation cancelled")
        return
      }

      // Determine the new category index
      const newCategoryIndex = event.to.dataset.categoryIndex ? Number(event.to.dataset.categoryIndex) : null
      
      let newCategory = null
      if (newCategoryIndex !== null && combinedCategories.value[newCategoryIndex]) {
        newCategory = combinedCategories.value[newCategoryIndex]
      }

      // Determine the new category ID or set it to null if it's an orphan channel now
      const newCategoryId = newCategory ? newCategory.id : null

      // Only proceed if the category actually changed
      const currentCategoryId = draggedChannel.value.category || null
      if (currentCategoryId !== newCategoryId) {
        // Move the channel to the new category or to the orphan list
        serverChannelStore.moveChannelToCategory(draggedChannel.value.id, newCategoryId)
      }

      // Reset the dragged channel reference
      draggedChannel.value = null
    };

    // const onEndDrag = (event: any) => {
    //   const originalCategoryIndex = event.from.dataset.categoryIndex ? Number(event.from.dataset.categoryIndex) : null;
    //   const newCategoryIndex = event.to.dataset.categoryIndex ? Number(event.to.dataset.categoryIndex) : null;

    //   console.log(`Dragging from ${originalCategoryIndex} to ${newCategoryIndex}`);

    //   if (originalCategoryIndex !== null && newCategoryIndex !== null) {
    //     const originalCategory = combinedCategories.value[originalCategoryIndex];
    //     const newCategory = combinedCategories.value[newCategoryIndex];
    //     const draggedChannel = originalCategory.channels[event.oldIndex];

    //     if (draggedChannel) {
    //       // Move the channel in the backend
    //       serverChannelStore.moveChannelToCategory(draggedChannel.id, newCategory.id).then(() => {
    //         // Update local state upon successful backend update
    //         originalCategory.channels.splice(event.oldIndex, 1); // Remove from old category
    //         newCategory.channels.push(draggedChannel); // Add to new category
    //       }).catch(console.error);
    //     } else {
    //       console.error("Dragged channel not found");
    //     }
    //   } else {
    //     console.error("Invalid category indices");
    //   }
    // };



    const toggleDropdown = (event?: MouseEvent) => {
      if (event) {
        event.stopPropagation();
      }
      isDropdownOpen.value = !isDropdownOpen.value;
    };

    const showCategoryCreator = (show: boolean) => {
      isCategoryCreatorOpen.value = show;
    }

    const createCategory = (category: string) => {
      serverChannelStore.createCategory(category, props.currentServer.id);
    }

    const selectChannel = (channelId: string) => {
      // Find the channel by channelId
      const channel = props.channels.find(ch => ch.id === channelId);

      if (channel) {
        if (voiceConnected.value !== channelId && channel.type === 1) {
          voiceOnSound.value.volume = 0.5;
          voiceOnSound.value.play();
          voiceConnected.value = channelId;
          serverUsers.broadcastVoiceChannelEvent(props.currentServer.id, channelId, 'user-joined', userId.value);
        } else if (voiceConnected.value == channelId && channel.type === 1) {
          voiceOffSound.value.volume = 0.5;
          voiceOffSound.value.play();
          voiceConnected.value = '';
        }
      }
      router.push({ name: 'Chat', params: { serverId: props.currentServer.id, channelId: channelId } });
      // if voice channel, join it
    };

    const emitCreateChannel = (categoryId: string | null) => {
      emit('createChannel', categoryId);
    }

    const toggleCategory = (categoryId: string) => {
      const category = serverChannelStore.categories.find(c => c.id === categoryId);
      if (category) {
        category.expanded = !category.expanded;
      }
    };

    const isCategoryOpen = (categoryId: string) => {
      return categoryOpenState.value[categoryId] || false;
    };

    const handleChannelCreated = (channel: Channel) => {
      console.log('Channel created:', channel);
      selectChannel(channel.id);
      serverChannelStore.fetchChannels(props.currentServer.id);
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
      draggedChannel,
      onStartDrag,
      onEndDrag,
      orphanChannels,
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
  position:relative;
  z-index:1;
  box-shadow: 0 1px 5px 0px rgba(0,0,0,0.25);
  margin-bottom:2px;
  cursor:pointer;
}

.category-name {
  cursor: pointer;
  padding:8px 6px;
  margin-top: 6px;
  vertical-align: middle;
  display: flex;
  font-size: 16px;
  align-items: center;
  justify-content: space-between;
}
.category-name .category-name-holder {
  flex-grow:1;
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
  transition: 0.3s ease-in-out;
}

.category.expanded .category-items {
  max-height: 100vh; /* or some other value large enough */
  /* overflow: auto; */
}

.server-name:hover {
  background: rgba(0,0,0,0.1);
}
.channel-item {
  padding: 6px 10px;
  cursor: pointer;
  transition: 0.2s ease-in-out;
  display: inline-flex;
  width:100%;
  font-size:14px;
  font-weight:500;
  &:hover {
    background-color: var(--h-sidebar-light);
  }
  color: rgb(173, 173, 173);
}
.channel-item:hover {
  color: rgb(173, 173, 173);
}
.channel-item.selected {
  /* padding-left:25px; */
  position: relative;
  background-color: var(--h-sidebar-light);
  color:#FFF;
}
.channel-item > svg {
  margin-right: 10px;
  width: 16px;
  height: 16px;
  position: relative;
  top: 3px;
}
.category .channel-item {
  padding-left:20px;
}

.create-channel {
  cursor:pointer;
  padding: 0 10px;
  transition: 0.2s ease-in-out;
  font-size: 16px;
  font-weight:500;
  /* background: var(--vt-c-divider-dark-2); */
}
.create-channel:hover {
  background: var(--vt-c-divider-dark-1);
}
/* .channel-item::before {
  opacity:0;
  content: "";
  transition: 0.3s ease-in-out;
  left:0;
}
.channel-item.selected::before {
  content: "";
  position: absolute;
  left:8px;
  top:17px;
  opacity:1;
  border-radius: 50%;
  width: 8px;
  height: 8px;
  background-color: var(--vt-c-divider-dark-1);
} */
</style>
