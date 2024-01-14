<template>
  <div class="message-display" v-scroll-bottom>
    <div v-if="messages.length == 0">
      There are no messages here, type something!
    </div>
    <div v-else v-for="(message, index) in messages" :key="message.id" class="message-wrapper">
      <div v-if="index === 0 || messages[index - 1].user_id !== message.user_id" class="message-header">
        <img :src="getUserAvatar(message.user_id)" class="user-avatar"/>
        <div>
          <strong :style="getUserColor(message.user_id)">
            {{ getUserDisplayName(message.user_id) }} <span class="timestamp">{{ formatTimestamp(message.created_at) }}</span>
          </strong>
          <div>{{ message.content }}</div>
        </div>
      </div>
      <template v-else>
        <div class="message-content">{{ message.content }}</div>
        <div v-if="message.file_url" class="file-container">
          <div v-if="!imageLoaded[index]" class="image-skeleton"></div>
          <img 
            :src="message.file_url" 
            @load="imageLoaded[index] = true"
            v-show="imageLoaded[index]" 
            @click="openLightbox(imageUrls.indexOf(message.file_url))" 
            alt="Uploaded file" 
          />
        </div>
      </template>
    </div>
  </div>
  <vue-easy-lightbox
    class="lightbox"
    :visible="isLightboxOpen"
    :imgs="lightboxImages"
    :index="indexRef"
    @hide="closeLightbox"
  />
</template>


<script lang="ts">
import { defineComponent, computed, ref } from 'vue';
import type { PropType } from 'vue';
import type { Message } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { format } from 'date-fns';

export default defineComponent({
  props: {
    messages: {
      type: Array as PropType<Message[]>,
      required: true
    }
  },
  setup(props) {
    const serverUsersStore = useServerUsersStore();

    const getUserDisplayName = (userId:string) => {
      return serverUsersStore.userProfiles[userId]?.display_name || 'Unknown User';
    };
    const getUserColor = (userId:string) => {
      return `color: ${serverUsersStore.userProfiles[userId]?.color || '#dddddd'}`;
    };
    const getUserAvatar = (userId:string) => {
      return serverUsersStore.userProfiles[userId]?.avatar_url;
    };
    const formatTimestamp = (timestamp:Date) => {
      return format(new Date(timestamp), 'p'); // Formats to the user's locale time
    };


    const imageUrls = computed(() => props.messages
      .filter(message => message.file_url)
      .map(message => message.file_url));
    const lightboxImages = ref([]);
    const isLightboxOpen = ref(false);
    const indexRef = ref(0);

    const imageLoaded = {};

    const openLightbox = (index: number) => {
      lightboxImages.value = imageUrls.value;
      indexRef.value = index;
      isLightboxOpen.value = true;
    };

    const closeLightbox = () => {
      isLightboxOpen.value = false;
    };
    return { 
      getUserDisplayName, 
      getUserColor, 
      getUserAvatar, 
      formatTimestamp, 
      openLightbox, 
      closeLightbox,
      imageUrls,
      lightboxImages, 
      isLightboxOpen,
      indexRef,
      imageLoaded
    };
  }
  
});
</script>
<style scoped>
.message-display {
  flex-grow: 1;
  overflow-y: auto;
  padding: 10px;
}

.message-wrapper {
  display: flex;
  align-items: flex-start;
}

.user-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  margin-right: 10px;
}

.message-header {
  display: flex;
  margin-top: 12px;
}

.message-content {
  margin-left: 50px; /* Same as avatar width + margin-right */
}

.timestamp {
  color: #626262;
  margin-left: 8px;
  font-size: 0.8em;
}
.file-container {
  margin-top: 5px;
}

.file-container > img {
  height: 100px;
  width: auto;
  border-radius: 5px;
  cursor: pointer;
  transition: transform 0.2s ease-in-out;
}

.file-container img:hover {
  transform: scale(1.05);
}

.lightbox {
  z-index: 1000;
}

.image-skeleton {
  width: 100px;
  height: 100px;
  background-color: #cccccc3d;
  border-radius: 6px;
  transition: 0.2s ease-in-out;
}
</style>

