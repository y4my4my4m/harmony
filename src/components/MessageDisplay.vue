<template>
  <div class="message-display" ref="messageDisplayContainer" @scroll="handleScroll">
    <div class="no-messages" v-if="messages.length == 0">
      There are no messages here, type something!
    </div>
    <div v-else v-for="(message, index) in messages" :key="message.id" class="message-wrapper" @mouseover="hoveredMessageId = message.id" @mouseleave="hoveredMessageId = null">
      <div v-if="index === 0 || messages[index - 1].user_id !== message.user_id" class="message-header">
        <img :src="getUserAvatar(message.user_id)" class="user-avatar" @click="showUserProfile(message.user_id, $event)"/>
        <div>
          <span>
            <strong class="user-display-name" :style="getUserColor(message.user_id)" @click="showUserProfile(message.user_id, $event)">
            {{ getUserDisplayName(message.user_id) }}
            </strong>
            <span class="timestamp">{{ formatTimestamp(message.created_at) }}</span>
          </span>
          <MessageContent 
            :content="message.content"
            :message-id="message.id"
            :editableMessageId="editableMessageId"
            :editableMessageContent="editableMessageContent"
            :isSingleEmojiMessage="isSingleEmojiMessage[index]"
            :image-loaded="imageLoaded"
            @image-loaded="handleImageLoaded"
            @open-lightbox="handleOpenLightbox"
            @update:message="saveEdit"
            @update:content="editableMessageContent = $event"
            @cancel-edit="cancelEdit"
            @show-user-profile="showUserProfile"
          />
        </div>
      </div>
      <MessageContent 
        v-else
        :content="message.content"
        :message-id="message.id"
        :editableMessageId="editableMessageId"
        :editableMessageContent="editableMessageContent"
        :isSingleEmojiMessage="isSingleEmojiMessage[index]"
        :image-loaded="imageLoaded"
        @image-loaded="handleImageLoaded"
        @open-lightbox="handleOpenLightbox"
        @update:message="saveEdit"
        @update:content="editableMessageContent = $event"
        @cancel-edit="cancelEdit"
        @show-user-profile="showUserProfile"
      />
      <div class="message-actions" v-if="hoveredMessageId === message.id">
        <div class="btn" @click="openEmojiReactor(message)"><ReactionIcon/></div>
        <div class="btn" @click="startEdit(message)"><EditIcon/></div>
        <div class="btn" @click="deleteMessage(message.id)"><DeleteIcon/></div>
      </div>
      <div class="reactions" v-if="message.reactions" >
        <!-- Display existing reactions -->
        <div
          v-for="reaction in message.reactions"
          :key="reaction.id"
          class="reaction"
          @click="toggleReaction(message.id, reaction.emoji)"
          >
          <img 
            :src="reaction.emoji.url" 
            :alt="reaction.emoji.name"
          />
          <span>{{ reaction.count }}</span>
          <!-- <span class="reaction-count">1</span> -->
        </div>
        <!-- Additional UI for adding new reactions -->
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
import type { PropType, Ref } from 'vue';
import type { Message, User, Emoji } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useChatStore } from '@/stores/useChat';
import { format } from 'date-fns';
import UserPreviewComponent from '@/components/UserPreviewComponent.vue';
import MessageContent from '@/components/MessageContent.vue';
import ReactionIcon from '@/components/icons/Reaction.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';

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
    ReactionIcon,
    DeleteIcon,
    MessageContent
  },
  setup(props, { emit }) {
    const messageDisplayContainer = ref<HTMLDivElement | null>(null);
    const serverUsersStore = useServerUsersStore();
    const chat = useChatStore();
    // const parsedMessages = computed(() => {
    //   return props.messages.map((message) => {
    //     // Assuming the content of each message is a JSON string
    //     try {
    //       const content = JSON.parse(message.content);
    //       return { ...message, content };
    //     } catch (e) {
    //       // Fallback to plain text if parsing fails
    //       console.error('Error parsing message content:', e);
    //       return { ...message, content: [{ text: message.content }] };
    //     }
    //   });
    // });

    const isSingleEmojiMessage = computed(() => {
      return props.messages.map(message => {
        // Check if the message content has only one part and that part is an emoji
        return message.content.length === 1 && Object.prototype.hasOwnProperty.call(message.content[0], 'emoji');
      });
    });

    const editableMessageId = ref<string | null>(null);
    const editableMessageContent = ref('');
    const hoveredMessageId = ref<string | null>(null);
    
    const openEmojiReactor = (message: Message) => {
      // set true if not an emoji for the input but a reaction
      emit('toggleEmojiList', true, message);
    }

    const toggleReaction = (messageId: string, emoji: Emoji) => {
      emit('sendReaction', messageId, emoji);
    }

    const startEdit = (message: Message) => {
      // editableMessageId.value = message.id;
      // // Convert message content to string
      // editableMessageContent.value = message.content.map(part => {
      //   if (typeof part === 'string') {
      //     return part;
      //   } else if (part.mention) {
      //     return part.mention;
      //   } else if (part.url) {
      //     return part.url;
      //   } else if (part.emoji) {
      //     return `:${part.emoji.id}:`;
      //   }
      // }).join('')
    };

    const saveEdit = async (messageId: string, newContent?: string) => {
      const content = newContent ?? editableMessageContent.value;
      await chat.editMessage(messageId, content); // Replace with your actual update logic
      editableMessageId.value = null;
    };

    const cancelEdit = () => {
      editableMessageId.value = null;
    };

    const deleteMessage = (messageId: string) => {
      chat.deleteMessage(messageId);
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

    const lightboxImages = computed(() => {
      let urls:Array<string> = [];
      props.messages.forEach(message => {
        message.content.forEach(part => {
          if (part.type === 'file' && part.fileType === 'image') {
            urls.push(part.url);
          }
        });
      });
      return urls;
    });

    const isLightboxOpen = ref(false);
    const indexRef = ref(0);

    const imageLoaded: Ref<Record<string, boolean>> = ref({});

    const handleImageLoaded = (url: string) => {
      imageLoaded.value[url] = true;
    };
    
    const imageUrls = computed(() => {
      let urls:Array<string> = [];
      props.messages.forEach(message => {
        message.content.forEach(part => {
          if (part.type === 'file' && part.fileType === 'image') {
            urls.push(part.url);
          }
        });
      });
      return urls;
    });

    const handleOpenLightbox = (url: string) => {
      const index = lightboxImages.value.indexOf(url);
      if (index !== -1) {
        indexRef.value = index;
        isLightboxOpen.value = true;
      }
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
    

    // Watch for changes in messages for parsing
    watch(() => props.messages, (newMessages) => {
      const oldScrollHeight = messageDisplayContainer.value ? messageDisplayContainer.value.scrollHeight : 0;

      newMessages.forEach(message => {
        message.content.forEach(part => {
          // initialize image "loading" state
          if (part.type === 'file' && part.fileType === 'image' && !(part.url in imageLoaded.value)) {
            imageLoaded.value[part.url] = false;
          }
        });
      });

      if (newMessages && newMessages.length > 0) {
        // Recalculate scroll height
        nextTick(() => {
          if (messageDisplayContainer.value) {
            const newScrollHeight = messageDisplayContainer.value.scrollHeight;
            const scrollOffset = newScrollHeight - oldScrollHeight;
            messageDisplayContainer.value.scrollTop += scrollOffset;
          }
          // FIXME: manually call to scroll down to bottom, although we probably dont want if we've scrolled up
          handleScroll();
        });
      }
    }, { immediate: true, deep: true });


    return { 
      getUserDisplayName, 
      getUserColor, 
      getUserAvatar, 
      formatTimestamp,
      closeLightbox,
      imageUrls,
      lightboxImages, 
      isLightboxOpen,
      indexRef,
      imageLoaded,
      handleImageLoaded,
      handleOpenLightbox,
      messageDisplayContainer,
      handleScroll,
      hoveredMessageId,
      deleteMessage,
      toggleReaction,
      startEdit,
      saveEdit,
      cancelEdit,
      editableMessageId,
      editableMessageContent,
      showUserProfile,
      selectedUser,
      profileCardStyle, 
      closeProfile,
      isSingleEmojiMessage,
      openEmojiReactor
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
  flex-direction: column;
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
  cursor: pointer;
}
.user-display-name {
  cursor: pointer;
}
.user-display-name:hover {
  text-decoration: solid underline;
}
.message-header {
  display: flex;
  align-items: flex-start;
}

.message-wrapper:has(> .message-header) {
  margin-top: 12px;
  flex-direction: column;
}
.message-content {
  padding-left: 46px; /* Same as avatar width + margin-right */
  /* line-height:24px; */
}

.message-header .message-content {
  padding-left: 0;
}
.timestamp {
  color: #626262;
  margin-left: 10px;
  font-size: 0.8em;
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
  width: calc(64vw);
  padding: 2px 6px;
  border-radius: 4px;
  background: rgb(0 0 0 / 9%);
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  line-height: inherit;
  outline: none;
  resize: none;
  border-style: solid;
  border-width: 1px;
  border-color: rgba(0,0,0,0.15);
}
.message-header .edit-input {
  margin-left:42px;
  width: calc(64vw - 42px);
}
.message-content .emoji-icon  {
  width: auto;
  max-width : 120px;
  height: 24px; 
  /* height: 48px; */
  /* margin: 0 2px; */
  vertical-align: middle;
}
.emoji-icon.single {
  height: 64px;
}
.reactions {
  display: flex;
  flex-wrap: wrap;
  padding-left: 46px;
  padding-bottom: 12px;
  gap: 4px;
  justify-content: space-between;
}
.reactions .reaction {
  display: flex;
  align-items: center;
  border-radius: 4px;
  background: rgb(0 0 0 / 15%);
  cursor: pointer;
  transition: 0.2s ease-in-out;
  padding: 6px;
  justify-content: center;
  flex-direction: row;
  flex-wrap: nowrap;
  gap: 10px;
  border:1px solid transparent;
}
.reactions .reaction img {
  height: 24px;
}
.reactions .reaction:hover {
  background: rgb(0 0 0 / 25%);
  border:1px solid rgba(255,255,255,0.25);
}
.reactions .reaction .reaction-count {
  margin-left: 4px;
  margin-top: 5px;
  font-size: 0.8em;
  color: #848484;
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
@media (max-width: 768px) {
  .message-wrapper {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .message-header {
    width: 100%;
  }
  .message-content {
    width: 100%;
  }
  .message-content {
    max-width: 100%; 
    white-space: normal;
    word-wrap:break-word;
    overflow-wrap:break-word;
  }
  .file-container > img {
    max-width: 100%;
    padding-left: 46px;
  }

}

</style>

