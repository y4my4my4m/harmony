<template>
  <div class="message-display" ref="messageDisplayContainer" @scroll="handleScroll">
    <!-- Loading skeleton when switching channels -->
    <div v-if="isLoading" class="loading-skeleton">
      <div v-for="i in 8" :key="i" class="skeleton-message">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-content">
          <div class="skeleton-header">
            <div class="skeleton-username"></div>
            <div class="skeleton-timestamp"></div>
          </div>
          <div class="skeleton-text"></div>
          <div class="skeleton-text short"></div>
        </div>
      </div>
    </div>
    
    <!-- Normal message display -->
    <template v-else>
      <div class="no-messages" v-if="messages.length == 0">
        There are no messages here, type something!
      </div>
      <div v-else v-for="(message, index) in messages" :key="message.id" :id="`#${message.id}`" class="message-wrapper" @mouseover="hoveredMessageId = message.id" @mouseleave="hoveredMessageId = null">
        <template v-if="(index === 0 || messages[index - 1].user_id !== message.user_id) || message.reply_to">
          <div v-if="message.reply_to" @click="highlightMessage(message.reply_to)" class="repliedMessage">
            <!-- TODO: dont make "gets" for everything -->
            <div class="replyContainer">
              <img draggable="false" :src="getUserAvatar(getUserIdFromMessage(message.reply_to)) ?? '/default_avatar.png'" class="replyAvatar">
              <div class="replyUsername" aria-expanded="false" role="button" tabindex="0" :style="{ color: getUserColor(getUserIdFromMessage(message.reply_to)) }">{{ getUserDisplayName(getUserIdFromMessage(message.reply_to)) ?? '' }}</div>
              <div class="repliedTextPreview" role="button" tabindex="0">
                <div id="message-content" class="repliedTextContent">
                  <!-- TODO: need to fetch if message is too far back -->
                  <span>
                    <MessageContent 
                      :content=" messages.find(msg => msg.id === message.reply_to)?.content || []"
                      :message-id="message.reply_to || 'TODO: FETCH IF NOT FOUND'"
                      :isSingleEmojiMessage="isSingleEmojiMessage[index]"
                      :image-loaded="imageLoaded"
                      :reply="true"
                      @image-loaded="handleImageLoaded"
                      @open-lightbox="handleOpenLightbox"
                      @update:message="saveEdit"
                      @update:content="editableMessageContent = $event"
                      @cancel-edit="cancelEdit"
                      @show-user-profile="showUserProfile"
                    />
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div class="message-header">
            <img draggable="false" :src="getUserAvatar(message.user_id)" class="user-avatar" @click="showUserProfile(message.user_id, $event)"/>
            <div>
              <span>
                <strong class="user-display-name" :style="{color: getUserColor(message.user_id)}" @click="showUserProfile(message.user_id, $event)">
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
                :reply="false"
                @image-loaded="handleImageLoaded"
                @open-lightbox="handleOpenLightbox"
                @update:message="saveEdit"
                @update:content="editableMessageContent = $event"
                @cancel-edit="cancelEdit"
                @show-user-profile="showUserProfile"
              />
            </div>
          </div>
        </template>
        <MessageContent 
          v-else
          :content="message.content"
          :message-id="message.id"
          :editableMessageId="editableMessageId"
          :editableMessageContent="editableMessageContent"
          :isSingleEmojiMessage="isSingleEmojiMessage[index]"
          :image-loaded="imageLoaded"
          :reply="false"
          @image-loaded="handleImageLoaded"
          @open-lightbox="handleOpenLightbox"
          @update:message="saveEdit"
          @update:content="editableMessageContent = $event"
          @cancel-edit="cancelEdit"
          @show-user-profile="showUserProfile"
        />
        <div class="message-actions" v-if="hoveredMessageId === message.id">
          <div class="btn" @click="openEmojiReactor(message)"><ReactionIcon/></div>
          <div class="btn" @click="replyTo(message)"><ReplyIcon/></div>
          <div class="btn" @click="startEdit(message)"><EditIcon/></div>
          <div class="btn" @click="deleteMessage(message.id)"><DeleteIcon/></div>
          <div class="btn"><MoreIcon/></div>
        </div>
        <div class="reactions" v-if="message.reactions" >
          <!-- Display existing reactions -->
          <div
            v-for="reaction in message.reactions"
            :key="reaction.id"
            class="reaction"
            @click="toggleReaction(message.id, reaction.emoji)"
            @mouseenter="showTooltip($event, reaction)"
            @mouseleave="hideTooltip"
            :class="{'reacted': reaction.reactions.some(r => r.user_id === currentUserId)}"
            >
            <img 
              :src="reaction.emoji.url" 
              :alt="reaction.emoji.name"      />
            <span>{{ reaction.count }}</span>
          </div>
          <!-- Additional UI for adding new reactions -->
        </div>
      </div>
    </template>
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

  <div 
    v-show="tooltip.visible" 
    class="tooltip" 
    :style="{ top: tooltip.y + 'px', left: tooltip.x + 'px' }"
  >
    <div class="tooltip-emoji"><img :src="tooltip.emoji?.url" />:{{ tooltip.emoji?.name }}:</div>
    <div style="color:#777; font-size:12px;">Reactions:</div>
    <div v-for="(user) in tooltip.content" :key="user.id">
      <span :style="{color: user.userColor}">
        <img class="tooltip-avatar" :src="user.avatarUrl" alt="" style="width: 20px; height: 20px; border-radius: 50%;">
        {{ user.displayName }}
      </span>
    </div>
  </div>


</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, nextTick } from 'vue';
import type { PropType, Ref } from 'vue';
import type { Message, User, Emoji, Reaction } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useChatStore } from '@/stores/useChat';
import { format } from 'date-fns';
import UserPreviewComponent from '@/components/UserPreviewComponent.vue';
import MessageContent from '@/components/MessageContent.vue';
import ReactionIcon from '@/components/icons/Reaction.vue';
import ReplyIcon from '@/components/icons/Reply.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';
import MoreIcon from '@/components/icons/More.vue';

export default defineComponent({
  props: {
    messages: {
      type: Array as PropType<Message[]>,
      required: true
    },
    isLoading: {
      type: Boolean,
      default: false
    },
    loadMoreMessages: Function as PropType<() => void>,
    isAtBottom: Boolean,
    currentUserId: String,
  },
  emits: ['loadMoreMessages', 'toggleEmojiList', 'sendReaction', 'replyingTo', 'update:isAtBottom'],
  components: { 
    UserPreviewComponent,
    ReplyIcon,
    EditIcon,
    ReactionIcon,
    DeleteIcon,
    MoreIcon,
    MessageContent
  },
  setup(props, { emit }) {
    const messageDisplayContainer = ref<HTMLDivElement | null>(null);
    const serverUsersStore = useServerUsersStore();
    const useChat = useChatStore();
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
    
    const tooltip = ref({
      visible: false,
      content: [] as { id: string; displayName: string; avatarUrl: string; userColor: string; }[],
      x: 0,
      y: 0,
      emoji: null as Emoji | null,
    });
    const tooltipTimer: Ref<NodeJS.Timeout | null> = ref(null);


    const showTooltip = (event: MouseEvent, reaction: Reaction) => {
      // Cancel any existing timer to prevent unwanted tooltip behavior
      if (tooltipTimer.value) {
        clearTimeout(tooltipTimer.value);
      }
      const usersDetails = reaction.reactions.map(r => ({
        id: r.user_id,
        displayName: getUserDisplayName(r.user_id),
        avatarUrl: getUserAvatar(r.user_id),
        userColor: getUserColor(r.user_id),
      }));
      
      // Set a timer to delay showing the tooltip
      tooltipTimer.value = setTimeout(() => {
        tooltip.value = {
          visible: true,
          content: usersDetails,
          x: event.clientX,
          y: event.clientY,
          emoji: reaction.emoji
        };
      }, 500); // 2000 milliseconds delay
    };

    const hideTooltip = () => {
      if (tooltipTimer.value) {
        clearTimeout(tooltipTimer.value);
      }
      tooltip.value.visible = false;
    };

    const lightboxImages = computed(() => {
      let urls: Array<string> = [];
      if (!props.messages || !Array.isArray(props.messages)) {
        return urls;
      }
      
      props.messages.forEach(message => {
        if (!message?.content || !Array.isArray(message.content)) {
          return;
        }
        
        message.content.forEach(part => {
          if (!part || typeof part !== 'object') {
            return;
          }
          
          if (part.type === 'file' && part.fileType === 'image' && part.url) {
            urls.push(part.url);
          }
          else if (part.type === 'url' && part.url && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp'))) {
            urls.push(part.url);
          }
        });
      });
      return urls;
    });

    // Watch for changes in messages for parsing
    watch(() => props.messages, (newMessages) => {
      if (!newMessages || !Array.isArray(newMessages)) {
        return;
      }

      const oldScrollHeight = messageDisplayContainer.value ? messageDisplayContainer.value.scrollHeight : 0;

      newMessages.forEach(message => {
        if (!message?.content || !Array.isArray(message.content)) {
          return;
        }
        
        message.content.forEach(part => {
          if (!part || typeof part !== 'object') {
            return;
          }
          
          // initialize image "loading" state
          if (part.type === 'file' && part.fileType === 'image' && part.url && !(part.url in imageLoaded.value)) {
            imageLoaded.value[part.url] = false;
          }
          else if (part.type === 'url' && part.url && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp')) && !(part.url in imageLoaded.value)) {
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

    const isSingleEmojiMessage = computed(() => {
      if (!props.messages || !Array.isArray(props.messages)) {
        return [];
      }
      
      return props.messages.map(message => {
        if (!message?.content || !Array.isArray(message.content)) {
          return false;
        }
        // Check if the message content has only one part and that part is an emoji
        return message.content.length === 1 && 
               message.content[0] && 
               typeof message.content[0] === 'object' && 
               Object.prototype.hasOwnProperty.call(message.content[0], 'emoji');
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

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

    const highlightMessage = (messageId: string) => {
      // scroll up to message id
      const messageElement = document.getElementById(`#${messageId}`);
      if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        messageElement.classList.add('highlighted');
      }
    }

    const replyTo = (message: Message) => {
      emit('replyingTo', message.id, getUserDisplayName(message.user_id));
    }

    const saveEdit = async (messageId: string, newContent?: string) => {
      const content = newContent ?? editableMessageContent.value;
      await useChat.editMessage(messageId, content); // Replace with your actual update logic
      editableMessageId.value = null;
    };

    const cancelEdit = () => {
      editableMessageId.value = null;
    };

    const deleteMessage = (messageId: string) => {
      useChat.deleteMessage(messageId);
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

    const getUserIdFromMessage = (messageId:string) => {
      return useChat.messages.find(message => message.id === messageId)?.user_id || 'Unknown Message Id';
    };
    const getUserDisplayName = (userId:string) => {
      return serverUsersStore.userProfiles[userId]?.display_name || 'Unknown User';
    };
    const getUserColor = (userId:string) => {
      return `${serverUsersStore.userProfiles[userId]?.color || '#dddddd'}`;
    };
    const getUserAvatar = (userId:string) => {
      return serverUsersStore.userProfiles[userId]?.avatar_url || '/default_avatar.png';
    };
    const formatTimestamp = (timestamp:Date) => {
      return format(new Date(timestamp), 'p'); // Formats to the user's locale time
    };

    const isLightboxOpen = ref(false);
    const indexRef = ref(0);

    const imageLoaded: Ref<Record<string, boolean>> = ref({});

    const handleImageLoaded = (url: string) => {
      imageLoaded.value[url] = true;
    };

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

    return { 
      getUserDisplayName, 
      getUserColor, 
      getUserAvatar,
      getUserIdFromMessage,
      formatTimestamp,
      closeLightbox,
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
      openEmojiReactor,
      replyTo,
      highlightMessage,
      tooltip,
      showTooltip,
      hideTooltip,
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

.message-wrapper .repliedMessage {
  display: flex;
  align-items: center;
  font-size: .875rem;
  position: relative;
  white-space: pre;
  user-select: none;
  gap: 4px;
}
.message-wrapper .repliedMessage:before {
    content: "";
    display: block;
    position: absolute;
    box-sizing: border-box;
    top: 16px;
    bottom: -4px;
    width: 26px;
    left: 16px;
    margin-right: var(--reply-spacing);
    /* margin-top: -1px; */
    margin-top: calc(-.5*var(--spine-width));
    /* margin-left: -1px; */
    margin-left: calc(-.5*var(--spine-width));
    margin-bottom: calc(-4px + var(0.125rem));
    border-color: var(--interactive-muted);
    /* border-width: 2px 0 0 2px; */
    border-width: var(--spine-width)0 0 var(--spine-width);
    border-style: solid;
    border-top-left-radius: 6px;
}
.message-wrapper .repliedMessage .replyContainer {
    display: flex;
    font-size: .875rem;
    position: relative;
    white-space: pre;
    user-select: none;
    gap: 4px;
    margin-left:46px;
    margin-bottom:10px; 
}
.message-wrapper .repliedMessage .replyAvatar {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    -webkit-user-select: none;
    -moz-user-select: none;
    user-select: none;
    margin-right: var(0.25rem);
    position: relative;
    top:8.5px;
    cursor:pointer;
}
.message-wrapper .repliedMessage .replyUsername {
    font-weight: 500;
    color: var(--interactive-normal);
    position: relative;
    top:6px;
    opacity:.65;
    display: inline-block;
    cursor:pointer;
}
.message-wrapper .repliedMessage .repliedTextPreview {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    position: relative;
    top: 6px;
    opacity:.65;
    cursor:pointer;
}
.message-wrapper .repliedMessage .replyUsername:hover {
  opacity: 1;
  text-decoration: underline;
}
.message-wrapper .repliedMessage .repliedTextPreview:hover {
  opacity: 1;
}
.message-wrapper .repliedMessage .message-content {
  padding-left:0;
}
.repliedMessage .file-container {
  max-height:48px;
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
  top:-16px;
  padding: 0 14px 0 32px;
  background:var(--h-chat);
  box-shadow: 0 0 5px rgba(0,0,0,0.3);
  border-radius: 5px;
  padding:0px;
  display: grid;
  grid-auto-flow: column;
  box-sizing: border-box;
  height: 32px;
  border-radius: 4px;
  align-items: center;
  justify-content: flex-start;
  transition: box-shadow.1s ease-out;
}
.message-actions .btn {

  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  padding: 4px;
  min-width: 24px;
  flex: 0 0 auto;
  color: var(--interactive-normal);
  cursor: pointer;
  position: relative;
  /* background:transparent; */
  transition: 0.2s ease-in-out;
  font-size: 12px;
}
.message-actions .btn:hover {
  background: rgba(255,255,255,0.35);
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
.highlighted {
  background:#59554766;
  border-left:2px solid #d79315;
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
  border: 0.0625rem solid transparent;
  border-radius: 0.5rem;
  background: hsl( 220 calc( 1 * 6.5%) 18% / 1);
  cursor: pointer;
  transition: 0.2s ease-in-out;
  justify-content: center;
  flex-direction: row;
  flex-wrap: nowrap;
  gap: .25rem;
  padding: 0.125rem 0.375rem;
}
.reactions .reaction img {
  /* height: 24px; */
  /* width: 1rem; */
  height: 1rem;
  margin: 0.125rem 0;
  min-width: auto;
  min-height: auto;
  max-width: 120px;
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
.reactions .reaction.reacted {
  background: hsl( 235 calc( 1 * 85.6%) 64.7% / 0.15);
  border:1px solid hsl( 235 calc( 1 * 85.6%) 64.7% / 1);
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

.tooltip {
  position: fixed;
  padding: 8px;
  background-color: rgba(05,05,05,0.95);
  color: white;
  border-radius: 4px;
  z-index: 15; /* Ensure it's above other elements */
  pointer-events: none; /* Ignore pointer events */
  transform: translate(-50%, -100%); /* Adjust based on actual tooltip size */
  white-space: nowrap;
  box-shadow: 0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23);
  transition: all 0.3s cubic-bezier(.25,.8,.25,1);
}
.tooltip .tooltip-emoji {
  display:flex;
  align-items:center;
  margin-bottom:10px;
}
.tooltip .tooltip-emoji img {
  width: 48px;
  height: 48px;
  margin-right: 4px;
  border-radius: 4px
}
.tooltip .tooltip-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  margin-right: 4px;
  position: relative;
  top: 4px
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

}

/* Loading skeleton styles */
.loading-skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px;
  opacity: 0.6;
}

.skeleton-message {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 2px 0;
}

.skeleton-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(90deg, #2f3136 25%, #303135 50%, #2f3136 75%);
  background-size: 200% 100%;
  animation: shimmer 2.5s infinite;
}

.skeleton-content {
  flex-grow: 1;
  padding-top: 2px;
}

.skeleton-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.skeleton-username {
  height: 16px;
  width: 80px;
  border-radius: 3px;
  background: linear-gradient(90deg, #2f3136 25%, #36393f 50%, #2f3136 75%);
  background-size: 200% 100%;
  animation: shimmer 2.5s infinite;
}

.skeleton-timestamp {
  height: 12px;
  width: 40px;
  border-radius: 3px;
  background: linear-gradient(90deg, #2f3136 25%, #36393f 50%, #2f3136 75%);
  background-size: 200% 100%;
  animation: shimmer 2.5s infinite;
}

.skeleton-text {
  height: 16px;
  margin-bottom: 4px;
  border-radius: 3px;
  background: linear-gradient(90deg, #2f3136 25%, #36393f 50%, #2f3136 75%);
  background-size: 200% 100%;
  animation: shimmer 2.5s infinite;
}

.skeleton-text:first-of-type {
  width: 85%;
}

.skeleton-text.short {
  width: 45%;
}

@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}
</style>