<template>
  <div class="message-display" ref="messageDisplayContainer" @scroll="handleScroll">
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
          <div class="message-content">
            <template v-for="(part, partIndex) in parseMessage(message.content)" :key="partIndex">
              <a v-if="typeof part === 'object'" :href="part.url" target="_blank">{{ part.url }}</a>
              <span v-else>{{ part }}</span>
            </template>
          </div>
        </div>
      </div>
      <template v-else>
        <div class="message-content">
          <template v-for="(part, partIndex) in parseMessage(message.content)" :key="partIndex">
            <a v-if="typeof part === 'object'" :href="part.url" target="_blank">{{ part.url }}</a>
            <span v-else>{{ part }}</span>
          </template>
        </div>
        <div v-if="message.file_url" class="file-container">
          <div v-if="!imageLoaded[message.id]" class="image-skeleton"></div>
          <img
          :src="message.file_url"
          @load="imageLoaded[message.id] = true"
          v-show="imageLoaded[message.id]"
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
import { defineComponent, computed, ref, watch, nextTick } from 'vue';
import type { PropType } from 'vue';
import type { Message } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { format } from 'date-fns';

export default defineComponent({
  props: {
    messages: {
      type: Array as PropType<Message[]>,
      required: true
    },
    loadMoreMessages: Function as PropType<() => void>,
    isAtBottom: Boolean
  },
  setup(props, { emit }) {
    const messageDisplayContainer = ref<HTMLDivElement | null>(null);
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

    const imageLoaded = ref({});

    const openLightbox = (index: number) => {
      lightboxImages.value = imageUrls.value;
      indexRef.value = index;
      isLightboxOpen.value = true;
    };

    const closeLightbox = () => {
      isLightboxOpen.value = false;
    };


    const handleScroll = () => {
      if (messageDisplayContainer.value) {
        const { scrollTop } = messageDisplayContainer.value;
        if (scrollTop === 0) {
          // console.log('fetchMore!');
          emit('loadMoreMessages');
        }

        // Emit event instead of mutating the prop
        emit('update:isAtBottom', false);
      }
    };
    
    const parseMessage = (message: string): Array<string | { url: string }> => {
      const urlRegex = /(\bhttps?:\/\/\S+)/gi;
      const parts = message.split(urlRegex);
      return parts.map(part => part.match(urlRegex) ? { url: part } : part);
    };

    watch(() => props.messages, async (newMessages, oldMessages) => {
      const oldScrollHeight = messageDisplayContainer.value ? messageDisplayContainer.value.scrollHeight : 0;
      // Initialize or update 'imageLoaded' for each message
      newMessages.forEach(message => {
        if (message.file_url && !(message.id in imageLoaded.value)) {
          imageLoaded.value[message.id] = false;
        }
      });

      await nextTick();

      if (messageDisplayContainer.value) {
        const newScrollHeight = messageDisplayContainer.value.scrollHeight;
        const scrollOffset = newScrollHeight - oldScrollHeight;
        messageDisplayContainer.value.scrollTop += scrollOffset;
      }
    }, { immediate: true, deep: true });



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
      imageLoaded,
      messageDisplayContainer,
      handleScroll,
      parseMessage,
    };
  }
  
});
</script>
<style scoped>
.message-display {
  flex-grow: 1;
  overflow-y: auto;
  /* scroll-behavior: smooth; */
  margin-right:4px;
}

.message-wrapper {
  display: flex;
  align-items: flex-start;
  padding: 4px;
}

.message-wrapper:hover {
  background: rgba(0,0,0,0.1)
}

.user-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  margin-right: 10px;
  position: relative;
  top: 4.5px;
}

.message-header {
  display: flex;
  align-items: flex-start;
}

.message-content {
  padding-left: 47.5px; /* Same as avatar width + margin-right */
}

.message-header .message-content {
  padding-left: 0;
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

@keyframes shimmer {
  0% {
    background-position: 0 150%;
  }
  100% {
    background-position: 0 -150%;
  }
}

.image-skeleton {
  width: 100px;
  height: 100px;
  border-radius: 6px;
  background: linear-gradient(
    to top,
    #888 0%, 
    #999 25%, 
    #888 50%
  );
  background-size: 100% 200%;
  animation: shimmer 1.5s infinite alternate;
}

.scroll-bottom {
  scroll-behavior: smooth;
}

</style>

