<template>
  <div class="chat-container" 
      @dragenter.prevent="handleDragEnter"
      @dragover.prevent="handleDragOver"
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="triggerFileDrop">
    <div v-if="showDragDropArea" 
      class="drag-drop-area"
      @dragleave.prevent="handleDragLeave">
      <div v-if="uploading" style="color:rgb(18, 143, 18);">Uploading...</div>
      <div v-else>Drop files here.</div>
    </div>

    <MessageDisplay 
      :messages="messages" 
      :isLoading="isLoading"
      :currentUserId="currentUserId"
      @loadMoreMessages="$emit('loadMoreMessages')"
      @toggleEmojiList="toggleEmojiList"
      @sendReaction="toggleReaction"
      @replyingTo="replyingTo"
    />
    <MessageInput 
      v-model="messageContent"
      :giphyOpen="giphyOpen"
      :emojiListOpen="emojiListOpen"
      :reply-message-id="replyToMessageId"
      :reply-user-display-name="replyToUserDisplayName"
      @toggleGiphy="toggleGiphy"
      @toggleEmojiList="toggleEmojiList"
      @sendMessage="handleSendMessage"
      @update:replyMessageId="handleDontReply"
      @upload-status-changed="handleUploadStatusChanged"
    />

    <GifComponent
      v-if="giphyOpen==true"
      @click.stop
      @sendGif="handleSendGif"
      :closeGiphy="closeGiphy"
      :gifIconClicked="gifIconClicked"
      @resetGifIconClicked="gifIconClicked = false"
    />

    <EmojiPopup
      v-if="emojiListOpen==true"
      @click.stop
      @sendEmoji="handleSendEmoji"
      :closeEmojiList="closeEmojiList"
      :emojiIconClicked="emojiIconClicked"
      @resetEmojiIconClicked="emojiIconClicked = false"
    />
  </div>
</template>

<script setup lang="ts">
  import { ref, onMounted, computed, watch, onUnmounted } from 'vue';
  import MessageDisplay from './MessageDisplay.vue';
  import MessageInput from './MessageInput.vue';
  import { useAuthStore } from '@/stores/auth'; 
  import { useChatStore } from '@/stores/useChat';
  import { useServerChannelStore } from '@/stores/useServerChannel'; 
  import { useServerUsersStore } from '@/stores/useServerUsers'; 
  import { useDMStore } from '@/stores/useDM';
  import { useThemeStore } from '@/stores/useTheme';
  import type { Message, Gif, Emoji, MessagePart } from '@/types';
  import { recordEmojiUsage } from '@/services/emojiService';
  import { listen } from '@tauri-apps/api/event';
  import { readBinaryFile } from '@tauri-apps/api/fs';
  import GifComponent from '@/components/GifComponent.vue';
  import EmojiPopup from '@/components/EmojiPopup.vue';
  import type { FilePreviewData } from '@/components/FilePreview.vue';

  // FIXME: probably breaking the __TAURI__ implementation if we declare it here
  declare const __TAURI__: any;

  interface Props {
    messages: Message[];
    isLoading?: boolean;
    loadMoreMessages?: () => void;
    isDM?: boolean;
  }

  const props = withDefaults(defineProps<Props>(), {
    isLoading: false,
    isDM: false,
  });

  interface Emits {
    (e: 'sendMessage', content: MessagePart[], replyTo?: string): void;
    (e: 'loadMoreMessages'): void;
  }

  const emit = defineEmits<Emits>();

  const chatStore = useChatStore();
  const authStore = useAuthStore();
  const serverChannelStore = useServerChannelStore();
  const serverUsersStore = useServerUsersStore();
  const dmStore = useDMStore();
  const themeStore = useThemeStore();
      const showDragDropArea = ref(false);
      const uploading = ref(false);
      const emojiListOpen = ref(false);
      const isPopupForReaction = ref(false);
      const selectedMessageId = ref('');
      const replyToMessageId = ref('');
      const replyToUserDisplayName = ref('');
      const giphyOpen = ref(false);
      const messageContent = ref('');
      
      // Dynamic emoji list based on context (DM vs Server)
      const resolvedEmojiList = computed(() => {
        if (props.isDM) {
          // For DMs, we might want to show emojis from all servers the user is in
          // For now, return server emojis or a default set
          return serverChannelStore.resolvedEmojiList;
        }
        return serverChannelStore.resolvedEmojiList;
      });
      
      const currentUserId = computed(() => authStore.session?.user?.id);
      const hasActiveUploads = ref(false);
      
      // Computed property to check if running in Tauri
      const isTauri = computed(() => {
        return typeof __TAURI__ !== 'undefined';
      });
      const gifIconClicked = ref(false);
      const emojiIconClicked = ref(false);

      // Page leave protection
      const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        if (hasActiveUploads.value) {
          event.preventDefault();
          event.returnValue = 'You have files uploading. Are you sure you want to leave?';
          return 'You have files uploading. Are you sure you want to leave?';
        }
      };

      const handleUploadStatusChanged = (uploading: boolean) => {
        hasActiveUploads.value = uploading;
      };

      onMounted(() => {
        window.addEventListener('beforeunload', handleBeforeUnload);
      });

      onUnmounted(() => {
        window.removeEventListener('beforeunload', handleBeforeUnload);
      });

      const replyingTo = (messageId: string, replyingTo: string) => {
        if (messageId) {
          replyToMessageId.value = messageId;
          replyToUserDisplayName.value = replyingTo;
        }
      };

      const handleDontReply = () => {
        replyToMessageId.value = '';
        replyToUserDisplayName.value = '';
      };

      const toggleReaction = (messageId: string, emoji: Emoji) => {
        selectedMessageId.value = messageId;
        isPopupForReaction.value = true;
        handleSendEmoji(emoji);
      };

      const toggleEmojiList = (isReaction: boolean, message: Message) => {
        if(message) selectedMessageId.value = message.id;
        isPopupForReaction.value = isReaction;
        emojiListOpen.value = !emojiListOpen.value;
        if (emojiListOpen.value) {
          emojiIconClicked.value = true;
        }
      };

      watch(emojiListOpen, () => {
          if (!emojiListOpen.value) {
            emojiIconClicked.value = false;
          }
      });

      const closeEmojiList = () => {
        emojiListOpen.value = false;
      };

      const toggleGiphy = () => {
          giphyOpen.value = !giphyOpen.value;
          if (giphyOpen.value) {
              gifIconClicked.value = true;
          }
      };

      watch(giphyOpen, () => {
          if (!giphyOpen.value) {
              gifIconClicked.value = false;
          }
      });

      const closeGiphy = () => {
        giphyOpen.value = false;
      };

      // New drag and drop handler for the chat container (fallback)
      const triggerFileDrop = async (event: any) => {
        console.log("triggerFileDrop called - File dropped on chat container:", event);
        showDragDropArea.value = false;
        
        const files = event.dataTransfer.files;
        if (files.length > 0) {
          console.log("ChatComponent forwarding", files.length, "files to MessageInput");
          const fileArray = Array.from(files);
          // This will be handled by MessageInput's drag and drop
          // We'll emit an event to trigger file selection in MessageInput
          const messageInputEvent = new CustomEvent('external-file-drop', {
            detail: { files: fileArray }
          });
          document.dispatchEvent(messageInputEvent);
        }
      };

      onMounted(async () => {
        if (!isTauri.value) return;
        await listen('tauri://file-drop', async (event: any) => {
          const filePath = event.payload[0];
          try {
            // Read the file as a binary blob
            const fileBlob = await readBinaryFile(filePath);

            // Create a File object
            const file = new File([fileBlob], filePath.split('/').pop(), {
              type: "mime/type", // Replace with the actual mime type if known
            });

            // Forward to MessageInput
            const messageInputEvent = new CustomEvent('external-file-drop', {
              detail: { files: [file] }
            });
            document.dispatchEvent(messageInputEvent);
          } catch (error) {
            console.error('Error processing file drop:', error);
          }
        });
      });

      const parseMessageInput = (input: string): MessagePart[] => {
        const emojiRegex = /:([\w\d_+-]+):/g;
        let lastIndex = 0;
        const result: MessagePart[] = [];

        let match;
        while ((match = emojiRegex.exec(input)) !== null) {
          // Add text before emoji
          if (match.index > lastIndex) {
            result.push({ type: 'text', text: input.slice(lastIndex, match.index) });
          }

          // Add emoji
          const emojiName = match[1];
          const emoji = findEmojiByName(emojiName);
          if (emoji) {
            result.push({ type: 'emoji', emoji });
          } else {
            // If emoji not found, add the text as is
            result.push({ type: 'text', text: match[0] });
          }

          lastIndex = match.index + match[0].length;
        }

        // Process remaining text
        const remainingText = input.slice(lastIndex);
        result.push(...parseTextForURLsAndMentions(remainingText));

        return result;
      };

      const urlRegex = /(\bhttps?:\/\/\S+)/gi;
      const mentionRegex = /(@\w+@\w+\S+)/g;
      const parseTextForURLsAndMentions = (text: string): MessagePart[] => {
        const parts: MessagePart[] = [];
        let lastIndex = 0;

        const combinedRegex = new RegExp(`${urlRegex.source}|${mentionRegex.source}`, 'gi');
        let textMatch;
        while ((textMatch = combinedRegex.exec(text)) !== null) {
          if (textMatch.index > lastIndex) {
            parts.push({ type: 'text', text: text.slice(lastIndex, textMatch.index) });
          }

          if (textMatch[0].startsWith('http')) {
            parts.push({ type: 'url', url: textMatch[0], preview: true });
          } else {
            const mention = textMatch[0];
            const userId = serverUsersStore.usernameToUserIdMap[mention.toLowerCase()];
            parts.push({ type: 'mention', mention: mention, userId });
          }

          lastIndex = textMatch.index + textMatch[0].length;
        }

        if (lastIndex < text.length) {
          parts.push({ type: 'text', text: text.slice(lastIndex) });
        }

        return parts;
      };

      const findEmojiByName = (name: string): Emoji | undefined => {
        for (const serverId in resolvedEmojiList.value) {
          const server = resolvedEmojiList.value[serverId];
          const emoji = server.emojis.find((e: any) => e.name === name);
          if (emoji) {
            return emoji;
          }
        }
        return undefined;
      };

      // Updated handleSendMessage to support both DMs and server channels
      const handleSendMessage = async (content: string, files: FilePreviewData[] = []) => {
        if (!authStore.session?.user) {
          return;
        }

        // For DMs: check if we have a conversation ID
        // For server channels: check if we have channel and server IDs
        if (props.isDM) {
          if (!dmStore.currentConversationId) {
            console.warn('Cannot send DM: no conversation selected');
            return;
          }
        } else {
          if (!serverChannelStore.currentChannelId || !serverChannelStore.currentServerId) {
            console.warn('Cannot send message: no channel or server selected');
            return;
          }
        }

        // Check if all files are uploaded
        const hasUploadingFiles = files.some(file => file.uploadStatus === 'uploading');
        const hasFailedFiles = files.some(file => file.uploadStatus === 'error');

        if (hasUploadingFiles) {
          console.warn('Cannot send message while files are still uploading');
          return;
        }

        if (hasFailedFiles) {
          console.warn('Cannot send message with failed uploads');
          return;
        }

        try {
          const messageParts: MessagePart[] = [];
          
          // Add text content if present
          if (content.trim()) {
            const parsedMessage = parseMessageInput(content);
            messageParts.push(...parsedMessage);
          }

          // Use already uploaded files
          for (const fileData of files) {
            if (fileData.uploadStatus === 'completed' && fileData.uploadedUrl) {
              const fileType = fileData.type.startsWith('image/') ? 'image' : 
                             fileData.type.startsWith('video/') ? 'video' : 'file';
              messageParts.push({
                type: "file",
                url: fileData.uploadedUrl,
                fileType
              });
            }
          }

          // Send the message with all parts
          if (messageParts.length > 0) {
            if (props.isDM) {
              // Emit event for DM messages to be handled by parent component
              emit('sendMessage', messageParts, replyToMessageId.value || undefined);
            } else {
              // Handle server channel messages directly
              if (serverChannelStore.currentServerId && serverChannelStore.currentChannelId) {
                await chatStore.sendMessage(
                  serverChannelStore.currentServerId,
                  serverChannelStore.currentChannelId,
                  authStore.session.user.id,
                  messageParts,
                  replyToMessageId.value || ''
                );
              }
            }
            
            messageContent.value = '';
            handleDontReply();
          }
        } catch (error) {
          console.error('Error sending message:', error);
        }
      };

      const handleSendGif = (gif: Gif) => {
        const gifUrl = gif.media_formats.gif.url;
        closeGiphy();
        
        if (props.isDM && dmStore.currentConversationId && authStore.session?.user) {
          // Emit for DM
          emit('sendMessage', [{type: "file", url: gifUrl, fileType: "image"}], replyToMessageId.value);
          handleDontReply();
        } else if (!props.isDM && serverChannelStore.currentChannelId && serverChannelStore.currentServerId && authStore.session?.user) {
          // Handle server channel directly
          chatStore.sendMessage(
            serverChannelStore.currentServerId, 
            serverChannelStore.currentChannelId, 
            authStore.session.user.id, 
            [{type: "file", url: gifUrl, fileType: "image"}], 
            replyToMessageId.value
          );
          handleDontReply();
        }
      };

      const handleSendEmoji = async (emoji: Emoji) => {
        closeEmojiList();
        
        if (isPopupForReaction.value) {
          if (authStore.session?.user) {
            // Play reaction sound using the new theme system
            themeStore.testAudio('reaction');
            
            // Track emoji usage when used as reaction
            if (!props.isDM && serverChannelStore.currentServerId) {
              await recordEmojiUsage(
                emoji.id,
                authStore.session.user.id,
                serverChannelStore.currentServerId,
                'reaction',
                selectedMessageId.value
              );
            }
            
            // Add reaction - works for both DMs and server messages
            await chatStore.addReaction(selectedMessageId.value, emoji.id, authStore.session.user.id);
          }
        } else {
          // Track emoji usage when used in message content
          if (authStore.session?.user && !props.isDM && serverChannelStore.currentServerId) {
            await recordEmojiUsage(
              emoji.id,
              authStore.session.user.id,
              serverChannelStore.currentServerId,
              'message'
            );
          }
          
          // Append emoji name to the existing message content
          messageContent.value += `:${emoji.name}:`;
          console.log("Emoji added in Parent:", messageContent.value);
        }
      };

      // Drag and drop handlers for chat container
      const handleDragEnter = (event: DragEvent) => {
        event.preventDefault();
        if (event.dataTransfer?.types.includes('Files')) {
          showDragDropArea.value = true;
        }
      };

      const handleDragOver = (event: DragEvent) => {
        event.preventDefault();
      };

      const handleDragLeave = (event: DragEvent) => {
        event.preventDefault();
        // Only hide if we're leaving the chat container entirely
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const x = event.clientX;
        const y = event.clientY;
        
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
          showDragDropArea.value = false;
        }
      };

</script>

<style scoped>
  .chat-container {
    display: flex;
    flex-direction: column;
    /* custom wallpapers/styling for users */
    /* background:#000; */
    /* background-image: url('https://wallpaperswide.com/download/counter_strike_cs_go-wallpaper-1920x1080.jpg'); */
    /* background-image: url('https://example.invalid/background.jpg'); */
    /* background-size:cover; */
  }
  /* .chat-container::before {
    position:absolute;
    top:0;
    left:0;
    content: '';
    width: 100%;
    height:100%;
    background: linear-gradient(90deg, black 20%, transparent 100%);
    opacity: 1;
  } */
  .drag-drop-area {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    display: flex;
    border: 2px dashed #ccc;
    padding: 20px;
    text-align: center;
    background: rgba(0, 0, 0, 0.8);
    align-items: center;
    justify-content: center;
    transition: 0.2s ease-in-out;
    font-size: 48px; 
    font-weight: bold;
    color: white;
  }
</style>
