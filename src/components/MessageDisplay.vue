<template>
  <div class="message-display" ref="messageDisplayContainer" @scroll="handleScroll">
    <div class="no-messages" v-if="messages.length == 0">
      There are no messages here, type something!
    </div>
    <div v-else v-for="(message, index) in messages" :key="message.id" class="message-wrapper" @mouseover="hoveredMessageId = message.id" @mouseleave="hoveredMessageId = null">
      <div v-if="index === 0 || messages[index - 1].user_id !== message.user_id" class="message-header">
        <img :src="getUserAvatar(message.user_id)" class="user-avatar"/>
        <div>
          <strong :style="getUserColor(message.user_id)">
            {{ getUserDisplayName(message.user_id) }} <span class="timestamp">{{ formatTimestamp(message.created_at) }}</span>
          </strong>
          <div v-if="editableMessageId !== message.id" class="message-content">
            <template v-for="(part, partIndex) in parseMessage(message.content)" :key="partIndex">
              <a v-if="typeof part === 'object' && part.url" :href="part.url" target="_blank">{{ part.url }}</a>
              <span v-else-if="typeof part === 'object' && part.mention" class="mention"  @click="showUserProfile(part.userId, $event)">{{ part.mention }}</span>
              <span v-else>{{ part }}</span>
            </template>
          </div>
          <input v-else type="text" v-model="editableMessageContent" @keyup.esc="cancelEdit" @keyup.enter="saveEdit(message.id)" class="edit-input" />
        </div>
      </div>
      <template v-else>
        <div v-if="editableMessageId !== message.id" class="message-content">
          <template v-for="(part, partIndex) in parseMessage(message.content)" :key="partIndex">
            <a v-if="typeof part === 'object' && part.url" :href="part.url" target="_blank">{{ part.url }}</a>
            <span v-else-if="typeof part === 'object' && part.mention" class="mention"  @click="showUserProfile(part.userId, $event)">{{ part.mention }}</span>
            <span v-else>{{ part }}</span>
          </template>
        </div>
        <input v-else type="text" v-model="editableMessageContent" @keyup.esc="cancelEdit" @keyup.enter="saveEdit(message.id)" class="edit-input" />
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
      <div class="message-actions" v-if="hoveredMessageId === message.id">
        <div class="btn" @click="startEdit(message)"><EditIcon/></div>
        <div class="btn" @click="deleteMessage(message.id)"><DeleteIcon/></div>
      </div>
    </div>
  </div>
  <vue-easy-lightbox
    class="lightbox"
    :visible="isLightboxOpen"
    :imgs="lightboxImages"
    :index="indexRef"
    @hide="closeLightbox"
  />
    <!-- FIXME: User profile card (class should be inside, reusable component!) -->
  <div v-if="selectedUser" :class="['user-profile-card', { 'selected': selectedUser }]" :style="profileCardStyle" @click.stop>
    <UserPreviewComponent :user="selectedUser" :closeProfile="closeProfile" />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, nextTick } from 'vue';
import type { PropType } from 'vue';
import type { Message, User } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useChatStore } from '@/stores/useChat';
import { format } from 'date-fns';
import UserPreviewComponent from '@/components/UserPreviewComponent.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';

// interface Part {
//   url?: string;
//   mention?: string;
//   userId?: string;
// }

export default defineComponent({
  props: {
    messages: {
      type: Array as PropType<Message[]>,
      required: true
    },
    loadMoreMessages: Function as PropType<() => void>,
    isAtBottom: Boolean
  },
  components: { 
    UserPreviewComponent,
    EditIcon,
    DeleteIcon
  },
  setup(props, { emit }) {
    const messageDisplayContainer = ref<HTMLDivElement | null>(null);
    const serverUsersStore = useServerUsersStore();
    const chat = useChatStore();
  
    const usernameToUserIdMap = computed(() => {
      const map: Record<string, string> = {};
      // Assuming userProfiles include the full '@username@domain' format
      for (const userId in serverUsersStore.userProfiles) {
        const profile = serverUsersStore.userProfiles[userId];
        if (profile && profile.username) {
          map[profile.username.toLowerCase()] = userId; // profile.username includes '@domain'
        }
      }
      return map;
    });

    const hoveredMessageId = ref<string | null>(null);
    const editableMessageId = ref<string | null>(null);
    const editableMessageContent = ref('');

    const startEdit = (message: Message) => {
      editableMessageId.value = message.id;
      editableMessageContent.value = message.content;
    };

    const saveEdit = async (messageId: string) => {
      await chat.editMessage(messageId, editableMessageContent.value);
      editableMessageId.value = null;
    };

    const cancelEdit = () => {
      editableMessageId.value = null;
    };

    const deleteMessage = (messageId: string) => {
      chat.deleteMessage(messageId);
    };
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
    
    const profileCardStyle = ref({ top: '0px', left: '0px'});
    const selectedUser = ref<User | null>(null);
    const showUserProfile = (userId: string, event: MouseEvent) => {
      const user = serverUsersStore.userProfiles[userId];
      if (!user) {
        console.error("User not found for ID:", userId);
        return;
      }

      const userMention = (event.currentTarget as HTMLElement);
      if (userMention) {
        const userMentionRect = userMention.getBoundingClientRect();
        console.log(userMentionRect);
        profileCardStyle.value = {
          left: `calc(10px + ${userMentionRect.width}px + ${userMentionRect.x}px)`,
          top: `calc(${userMentionRect.y}px - 400px)`,
        };
      }

      selectedUser.value = user;
      event.stopPropagation();
    };

    const closeProfile = () => {
      selectedUser.value = null;
    };

    const parseMessage = (message: string): Array<string | { url: string, userId: string, mention: string }> => {
      const urlRegex = /(\bhttps?:\/\/\S+)/gi;
      // Updated regex to include '@username@domain' format
      const mentionRegex = /(@\w+@\w+\S+)/g;
      let parts = [];
      let lastIndex = 0;

      // Extract URLs
      message.replace(urlRegex, (match, _, urlIndex) => {
        if (urlIndex > lastIndex) {
          parts.push(message.substring(lastIndex, urlIndex));
        }
        parts.push({ url: match });
        lastIndex = urlIndex + match.length;
        return match;
      });

      // Process remaining text for mentions
      if (lastIndex < message.length) {
        let remainingText = message.substring(lastIndex);

        remainingText.replace(mentionRegex, (match, usernameWithDomain, mentionIndex) => {
          if (mentionIndex > 0) {
            parts.push(remainingText.substring(0, mentionIndex));
          }
          const userId = usernameToUserIdMap.value[usernameWithDomain.toLowerCase()];
          if (userId) {
            parts.push({ mention: match, userId });
          } else {
            parts.push(match); // If no user found, keep the text as is
          }
          remainingText = remainingText.substring(mentionIndex + match.length);
          return match;
        });

        if (remainingText) {
          parts.push(remainingText);
        }
      }

      return parts;
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
      hoveredMessageId,
      deleteMessage,
      startEdit,
      saveEdit,
      cancelEdit,
      editableMessageId,
      editableMessageContent,
      showUserProfile,
      selectedUser,
      profileCardStyle, 
      closeProfile,
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
  padding: 0px 12px;
  position:relative;
}

.message-wrapper:hover {
  background: rgba(0,0,0,0.1)
}

.no-messages {
  text-align: center;
  color: #626262;
  margin:auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: 100%;

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

.message-wrapper:has(> .message-header) {
  margin-top: 12px;
}
.message-content {
  padding-left: 46px; /* Same as avatar width + margin-right */
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
.message-actions {
  display:flex;
  justify-content: flex-end;
  flex-grow:1;
  position:absolute;
  right:4px;
  top:-14px;
  background:var(--h-chat);
  box-shadow: 0 0 5px rgba(0,0,0,0.3);
  border-radius: 5px;
  padding:0px;
}
.message-actions .btn {
  width: 24px;
  height: 24px;
  margin-left: 5px;
  padding: 2px 4px;
  border: none;
  cursor: pointer;
  /* background:transparent; */
  transition: 0.2s ease-in-out;
  font-size: 12px;
}
.message-actions .btn:hover {
  /* background: rgba(0,0,0,0.1); */
  filter: saturate(1);
}
.scroll-bottom {
  scroll-behavior: smooth;
}
.edit-input {
  display: flex;
  align-items: flex-start;
  padding: 4px;
  width: 100%;
  padding: 2px 6px;
  border-radius: 4px;
  /* remove default html styling of input */
  background: rgba(0,0,0,0.1);
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  line-height: inherit;
  outline: none;
  resize: none;
  border-style: solid;
  border-width: 1px;
  border-color: rgba(0,0,0,0.3);
}
.mention {
  background-color: #3c4270;
  border-radius: 3px;
  padding: 0 2px;
  font-weight: 500;
  cursor: pointer;
  color: #c9c9ee;
  display: inline-block;
  transition: 0.2s;
  font-weight:500;
}
.mention:hover {
  background-color: #5865f2;
  color:rgba(255,255,255,0.9);
}

/* FIXME: this should all be inside the userProfileComponent */
.user-profile-card {
  position: absolute;
  /* left: -332px; */
  left: 0px;
  top: 0px;
  width: 320px; 
  height: 400px;
  border-radius: 12px;
  background-color: #2f3339; 
  z-index: 1000;
  padding: 10px;
  opacity: 0;
  transition: 0.2s ease-in-out;
  box-shadow: 0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23);
  transition: all 0.3s cubic-bezier(.25,.8,.25,1);
}
.user-profile-card:hover {
  box-shadow: 0 10px 20px rgba(0,0,0,0.19), 0 6px 6px rgba(0,0,0,0.23);
}
.user-profile-card.selected {
  opacity: 1
}
</style>

