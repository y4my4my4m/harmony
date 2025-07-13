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
      ref="messageInputRef"
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
      :position="'above'"
      :triggerElement="gifTriggerElement || undefined"
      @resetGifIconClicked="gifIconClicked = false"
    />

    <EmojiPopup
      v-if="emojiListOpen==true"
      @click.stop
      @sendEmoji="handleSendEmoji"
      :closeEmojiList="closeEmojiList"
      :emojiIconClicked="emojiIconClicked"
      :position="isPopupForReaction ? 'left' : 'above'"
      :triggerElement="(isPopupForReaction ? reactionTriggerElement : emojiTriggerElement) || undefined"
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
  import { userDataService } from '@/services/userDataService'; 
  import { useDMStore } from '@/stores/useDM';
  import { useThemeStore } from '@/stores/useTheme';
  import { useEmojiCacheStore } from '@/stores/useEmojiCache';
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
  // Remove serverUsersStore as we now use userDataService
  const dmStore = useDMStore();
  const themeStore = useThemeStore();
  const emojiCacheStore = useEmojiCacheStore();
  
  const showDragDropArea = ref(false);
  const uploading = ref(false);
  const emojiListOpen = ref(false);
  const isPopupForReaction = ref(false);
  const selectedMessageId = ref('');
  const replyToMessageId = ref('');
  const replyToUserDisplayName = ref('');
  const giphyOpen = ref(false);
  const messageContent = ref('');
  
  // Component refs
  const messageInputRef = ref<InstanceType<typeof MessageInput> | null>(null);
  
  // Trigger element references for positioning
  const reactionTriggerElement = ref<HTMLElement | null>(null);
  
  // Computed trigger refs from MessageInput
  const gifTriggerElement = computed(() => messageInputRef.value?.gifTriggerRef || null);
  const emojiTriggerElement = computed(() => messageInputRef.value?.emojiTriggerRef || null);
  
  // Dynamic emoji list based on context (DM vs Server)
  const resolvedEmojiList = computed(() => {
    if (props.isDM) {
      // For DMs, we might want to show emojis from all servers the user is in
      // For now, return server emojis or a default set
      return emojiCacheStore.resolvedEmojis;
    }
    return emojiCacheStore.resolvedEmojis;
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

      const toggleEmojiList = (isReaction: boolean, message?: Message, triggerElement?: HTMLElement) => {
        console.log('toggleEmojiList called:', { isReaction, message, triggerElement });
        if(message) selectedMessageId.value = message.id;
        if(triggerElement) reactionTriggerElement.value = triggerElement;
        isPopupForReaction.value = isReaction;
        emojiListOpen.value = !emojiListOpen.value;
        console.log('emojiListOpen is now:', emojiListOpen.value);
        if (emojiListOpen.value) {
          emojiIconClicked.value = true;
        }
      };

      watch(emojiListOpen, () => {
          if (!emojiListOpen.value) {
            emojiIconClicked.value = false;
            reactionTriggerElement.value = null;
          }
      });

      const closeEmojiList = () => {
        emojiListOpen.value = false;
        reactionTriggerElement.value = null;
      };

      const toggleGiphy = () => {
          console.log('toggleGiphy called');
          giphyOpen.value = !giphyOpen.value;
          console.log('giphyOpen is now:', giphyOpen.value);
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
        console.log('🔧 parseMessageInput called with:', input);
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
        console.log('🔧 Processing remaining text for mentions/URLs:', remainingText);
        const textParts = parseTextForURLsAndMentions(remainingText);
        result.push(...textParts);
        
        console.log('🔧 Final parsed message parts:', result);
        return result;
      };

      const urlRegex = /(\bhttps?:\/\/\S+)/gi;
      // Updated mention regex to match both @username/@username@domain and @uuid@domain (UUIDs contain hyphens)
      const mentionRegex = /@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g;
      const parseTextForURLsAndMentions = (text: string): MessagePart[] => {
        console.log('🔧 parseTextForURLsAndMentions called with:', text);
        const parts: MessagePart[] = [];
        let lastIndex = 0;

        // Process URLs and mentions separately to avoid capture group issues
        const matches: Array<{match: RegExpExecArray, type: 'url' | 'mention'}> = [];
        
        // Find all URL matches
        let urlMatch;
        urlRegex.lastIndex = 0; // Reset regex
        while ((urlMatch = urlRegex.exec(text)) !== null) {
          matches.push({match: urlMatch, type: 'url'});
        }
        
        // Find all mention matches
        let mentionMatch;
        mentionRegex.lastIndex = 0; // Reset regex
        while ((mentionMatch = mentionRegex.exec(text)) !== null) {
          matches.push({match: mentionMatch, type: 'mention'});
        }
        
        // Sort matches by position
        matches.sort((a, b) => a.match.index! - b.match.index!);
        
        // Process matches in order
        for (const {match, type} of matches) {
          console.log('🔧 Found match in ChatComponent:', match, 'type:', type);
          
          if (match.index! > lastIndex) {
            parts.push({ type: 'text', text: text.slice(lastIndex, match.index) });
          }

          if (type === 'url') {
            parts.push({ type: 'url', url: match[0], preview: true });
          } else if (type === 'mention') {
            // Handle mention parsing - support both formats
            const fullMatch = match[0]; // Full mention like @username or @uuid@domain
            const firstPart = match[1]; // First capture group: username or uuid
            const domain = match[2]; // Second capture group: domain (optional)
            
            // Check if this is already in @uuid@domain format (UUID pattern - flexible hex)
            const isUuidFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(firstPart);
            
            if (isUuidFormat && domain) {
              // Already in storage format @uuid@domain, use as-is
              console.log('🔧 Found UUID format mention:', fullMatch);
              
              // Get user profile for additional data
              const userProfile = userDataService.getUserProfile(firstPart);
              if (userProfile) {
                console.log('🔧 UserProfile for UUID mention:', userProfile);
                parts.push({ 
                  type: 'mention', 
                  userId: firstPart,
                  username: userProfile.username,
                  domain: userProfile.domain || domain,
                  isLocal: userProfile.isLocal === true || (userProfile.domain || domain) === 'har.mony.lol',
                  displayName: userProfile.displayName
                });
              } else {
                // Fallback if user not found
                parts.push({ type: 'text', text: fullMatch });
              }
            } else {
              // Display format @username or @username@domain, convert to storage format
              console.log('🔧 Found display format mention, looking up user:', firstPart, domain);
              const userId = userDataService.findUserIdByUsername(firstPart, domain);
              
              if (userId) {
                // Get user profile for complete data
                const userProfile = userDataService.getUserProfile(userId);
                if (userProfile) {
                  const userDomain = userProfile.domain || 'har.mony.lol';
                  
                  console.log('🔧 UserProfile for display mention:', userProfile);
                  console.log('🔧 Full isLocal debug:', {
                    username: userProfile.username,
                    domain: userProfile.domain,
                    isLocal_raw: userProfile.isLocal,
                    isLocal_type: typeof userProfile.isLocal,
                    isLocal_boolean: Boolean(userProfile.isLocal),
                    comparison_with_har_mony_lol: userProfile.domain === 'har.mony.lol',
                    expected_isLocal: userProfile.domain === 'har.mony.lol' || userProfile.isLocal === true
                  });
                  console.log('🔧 Created structured mention object for:', userProfile.username);
                  
                  const mentionObject = { 
                    type: 'mention' as const, 
                    userId,
                    username: userProfile.username,
                    domain: userDomain,
                    isLocal: userProfile.isLocal === true || userDomain === 'har.mony.lol',
                    displayName: userProfile.displayName
                  };
                  
                  console.log('🔧 Final mention object:', mentionObject);
                  parts.push(mentionObject);
                } else {
                  console.log('🔧 User profile not found, storing as text:', fullMatch);
                  parts.push({ type: 'text', text: fullMatch });
                }
              } else {
                // If user not found, store as plain text
                console.log('🔧 User not found, storing as text:', fullMatch);
                parts.push({ type: 'text', text: fullMatch });
              }
            }
          }

          lastIndex = match.index! + match[0].length;
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
      const handleSendMessage = async (content: string, files: FilePreviewData[] = [], replyMessageId?: string) => {
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
              // Use the replyMessageId parameter passed from MessageInput
              emit('sendMessage', messageParts, replyMessageId || undefined);
            } else {
              // Handle server channel messages directly
              if (serverChannelStore.currentServerId && serverChannelStore.currentChannelId) {
                await chatStore.sendMessage(
                  serverChannelStore.currentServerId,
                  serverChannelStore.currentChannelId,
                  authStore.session.user.id,
                  messageParts,
                  replyMessageId || ''
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
