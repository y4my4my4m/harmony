<template>
  <div class="channel-sidebar">
    <div class="server-name" @click="toggleDropdown">
      {{ currentServer.name }}
    </div>
    <ServerDropdown :serverId="currentServer.id" v-show="showDropdown" />
    <template v-if="categories && categories.length !== 0">
      <div class="category" v-for="category in categories" :key="category.id" :class="{'expanded' : category.expanded }">
        <div class="category-name">
          <div class="category-name-holder" @click="toggleCategory(category.id)">
            <ArrowDownIcon /> 
            {{ category.name }}
          </div>
         <div class="create-channel" @click="emitCreateChannel(category.id)">+</div>
        </div>
        <div class="category-items" >
          <div v-for="channel in categoryChannels[category.id]" :key="channel.id" :class="['channel-item', { 'selected': channel.id === currentChannelId }]" @click="selectChannel(channel.id)">
            <HashTagIcon v-if="channel.type==0"/><SpeakerIcon v-else /> {{ channel.name }}
          </div>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="create-channel" @click="emitCreateChannel(null)">Create channel +</div>
      <div v-for="channel in channels" :key="channel.id" :class="['channel-item', { 'selected': channel.id === currentChannelId }]" @click="selectChannel(channel.id)">
        <HashTagIcon v-if="channel.type==0"/><SpeakerIcon v-else /> {{ channel.name }}
      </div>
    </template>
    <UserProfileComponent />
  </div>
</template>
<script lang="ts">
import { defineComponent, ref } from 'vue';
import type { PropType } from 'vue';
import type { Channel, Category } from '@/types';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useRouter } from 'vue-router';
import ArrowDownIcon from '@/components/icons/ArrowDown.vue';
import HashTagIcon from '@/components/icons/HashTag.vue';
import SpeakerIcon from '@/components/icons/Speaker.vue';

import UserProfileComponent from './UserProfileComponent.vue';
import ServerDropdown from './ServerDropdown.vue';

export default defineComponent({
  name: 'ChannelSidebar',
  components: {
    UserProfileComponent,
    ServerDropdown,
    ArrowDownIcon,
    HashTagIcon,
    SpeakerIcon
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
    const showDropdown = ref(false);
    // TODO: were using the store but maybe it should just be passed as a prop from ChatView?
    const serverChannelStore = useServerChannelStore();
    const router = useRouter();
    interface CategoryOpenState {
      [key: string]: boolean;
    }
    const categoryOpenState = ref<CategoryOpenState>({});
    

    const selectChannel = (channelId: string) => {
      router.push({ name: 'Chat', params: { serverId: props.currentServer.id, channelId: channelId } });
    };

    const emitCreateChannel = (categoryId: string | null) => {
      emit('createChannel', categoryId);
    }

    // const toggleCategory = (categoryId: string) => {
    //   categoryOpenState.value[categoryId] = !categoryOpenState.value[categoryId];
    // };
    const toggleCategory = (categoryId: string) => {
      const category = serverChannelStore.categories.find(c => c.id === categoryId);
      if (category) {
        category.expanded = !category.expanded;
      }
    };

    const isCategoryOpen = (categoryId: string) => {
      return categoryOpenState.value[categoryId] || false;
    };

    const toggleDropdown = () => {
      showDropdown.value = !showDropdown.value;
    };

    const handleChannelCreated = (channel: Channel) => {
      console.log('Channel created:', channel);
      selectChannel(channel.id);
      serverChannelStore.fetchChannels(props.currentServer.id);
    };

    return { selectChannel, serverChannelStore, showDropdown, emitCreateChannel, handleChannelCreated, toggleDropdown, toggleCategory, isCategoryOpen  };
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
