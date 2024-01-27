<template>
  <div class="chat-container" 
      @dragenter.prevent="showDragDropArea = true"
      @dragover.prevent="showDragDropArea = true"
      @drop.prevent="triggerFileDrop">
    <div v-if="showDragDropArea" 
      class="drag-drop-area"
      @dragleave.prevent="showDragDropArea = false">
      <div v-if="uploading" style="color:rgb(18, 143, 18);">Uploading...</div>
      <div v-else>Drop files here.</div>
    </div>

    <MessageDisplay 
      :messages="messages" 
      :currentUserId="currentUserId"
      @loadMoreMessages="$emit('loadMoreMessages')"
      @toggleEmojiList="toggleEmojiList"
      @sendReaction="toggleReaction"
      @replyingTo="replyingTo"
    />
    <MessageInput 
      v-model:messageContent="messageContent"
      :giphyOpen="giphyOpen"
      :emojiListOpen="emojiListOpen"
      :reply-message-id="replyToMessageId"
      :reply-user-display-name="replyToUserDisplayName"
      @toggleGiphy="toggleGiphy"
      @toggleEmojiList="toggleEmojiList"
      @sendMessage="handleSendMessage"
      @update:messageContent="messageContent = $event"
      @update:replyMessageId="handleDontReply"
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

<script lang="ts">
  import { defineComponent, ref, onMounted, computed, watch } from 'vue';
  import type { PropType } from 'vue';
  import MessageDisplay from './MessageDisplay.vue';
  import MessageInput from './MessageInput.vue';
  import { useAuthStore } from '@/stores/auth'; 
  import { useChatStore } from '@/stores/useChat';
  import { useServerChannelStore } from '@/stores/useServerChannel'; 
  import { useServerUsersStore } from '@/stores/useServerUsers'; 
  import type { Message, Gif, Emoji, MessagePart } from '@/types';
  import { handleFileDrop } from '@/services/fileService';
  import { listen } from '@tauri-apps/api/event';
  import { readBinaryFile } from '@tauri-apps/api/fs';
  // import type { UnlistenFn } from '@tauri-apps/api/event';
  import GifComponent from '@/components/GifComponent.vue';
  import EmojiPopup from '@/components/EmojiPopup.vue';
  // FIXME: probably breaking the __TAURI__ implementation if we declare it here
  declare const __TAURI__: any;
  
  export default defineComponent({
    components: {
      MessageDisplay,
      MessageInput,
      GifComponent,
      EmojiPopup,
    },
    props:{
      messages: {
        type: Array as () => Message[],
        required: true
      },
      loadMoreMessages: Function as PropType<() => void>
    },
    setup() {
      const chatStore = useChatStore();
      const authStore = useAuthStore();
      const serverChannelStore = useServerChannelStore();
      const serverUsersStore = useServerUsersStore();
      const showDragDropArea = ref(false);
      const uploading = ref(false);
      const emojiListOpen = ref(false);
      const isPopupForReaction = ref(false);
      const selectedMessageId = ref('');
      const replyToMessageId = ref('');
      const replyToUserDisplayName = ref('');
      const giphyOpen = ref(false);
      const messageContent = ref('');
      const resolvedEmojiList = computed(() => serverChannelStore.resolvedEmojiList);
      const reactionSound2 = ref(new Audio('/assets/sounds/bubble1.mp3'));
      const currentUserId = computed(() => authStore.session?.user?.id);
      // let unlisten: UnlistenFn | null = null;
      // Computed property to check if running in Tauri
      const isTauri = computed(() => {
        return typeof __TAURI__ !== 'undefined';
      });
      const gifIconClicked = ref(false);
      const emojiIconClicked = ref(false);

      const replyingTo = (messageId: string, replyingTo: string) => {
        if (messageId) {
          replyToMessageId.value = messageId;
          replyToUserDisplayName.value = replyingTo;
        }
      };

      // TODO: we're emitting from messageReply->messageInput->chatComponent ... dont do that!
      const handleDontReply = () => {
        replyToMessageId.value = '';
        replyToUserDisplayName.value = '';
      };

      const toggleReaction = (messageId: string, emoji: Emoji) => {
        // TODO: i dont like putting "selectedMessage" out in the eather this is bad design, revise it to make the emoji popup completely modular and free of logic
        selectedMessageId.value = messageId;
        isPopupForReaction.value = true;
        handleSendEmoji(emoji);
      };

      const toggleEmojiList = (isReaction: boolean, message: Message) => {
        // TODO: i dont like putting "selectedMessage" out in the eather this is bad design, revise it to make the emoji popup completely modular and free of logic
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

      const triggerFileDrop = async (event:any) => {
        console.log("File dropped:", event);
        uploading.value = true;
        const files = event.dataTransfer.files;
        if (files.length && serverChannelStore.currentChannelId && authStore.session?.user?.id) {
            const file = files[0];
            const fileUrl = await handleFileDrop(authStore.session?.user?.id, file);

            console.log("File uploaded to:", fileUrl);
            if (fileUrl) {
                // Send a message with the file URL
                // TODO: We should probably send the file name and size as well
                // bad practice to use empty string as content, but we don't want to send the file as content
                // we should use typed data for this, but we'll keep it simple for now
                chatStore.sendMessage(
                    serverChannelStore.currentChannelId, 
                    authStore.session.user.id, 
                    [{type: "file", url: fileUrl, fileType: "image"}],
                    replyToMessageId.value
                );
                uploading.value = false;
                handleDontReply();
            }
        }
        showDragDropArea.value = false;
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

            // Create a custom DataTransfer-like object
            const customDataTransfer = {
              files: {
                0: file,
                length: 1,
                item: () => file
              }
            };

            // Trigger the file drop handler
            triggerFileDrop({ dataTransfer: customDataTransfer });
          } catch (error) {
            console.error('Error processing file drop:', error);
          }
        });
      });
      // onUnmounted(() => {
      //   if (unlisten) {
      //     unlisten();
      //   }
      // });

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
          const emoji = server.emojis.find(e => e.name === name);
          if (emoji) {
            return emoji;
          }
        }
        return undefined;
      };

      const handleSendMessage = (content: string) => {
        if (authStore.session?.user && serverChannelStore.currentChannelId) {
          const parsedMessage = parseMessageInput(content);
          console.log("replyToMessageId.value:", replyToMessageId.value);
          chatStore.sendMessage(serverChannelStore.currentChannelId, authStore.session.user.id, parsedMessage, replyToMessageId.value);
          messageContent.value = ''; // Reset the message input field after sending
          handleDontReply();
        }
      };

      const handleSendGif = (gif: Gif ) => {
        const gifUrl = gif.media_formats.gif.url;
        closeGiphy();
        if (serverChannelStore.currentChannelId && authStore.session?.user) {
          chatStore.sendMessage(serverChannelStore.currentChannelId, authStore.session.user.id, [{type: "file", url: gifUrl, fileType: "image"}], replyToMessageId.value);
          handleDontReply();
        }
      };

      const handleSendEmoji = async (emoji: Emoji) => {
        closeEmojiList();

        if (isPopupForReaction.value) {
          if (authStore.session?.user) {
            reactionSound2.value.volume = 0.5;
            reactionSound2.value.play();
            await chatStore.addReaction(selectedMessageId.value, emoji.id, authStore.session.user.id);

          }
        }
        else {
          // Append emoji name to the existing message content
          messageContent.value += `:${emoji.name}:`;
          console.log("Emoji added in Parent:", messageContent.value);
        }
      };

      return { 
        handleSendMessage,
        triggerFileDrop,
        showDragDropArea,
        isTauri,
        uploading,
        handleSendGif,
        giphyOpen,
        toggleGiphy,
        closeGiphy,
        gifIconClicked,
        toggleEmojiList,
        closeEmojiList,
        emojiListOpen,
        emojiIconClicked,
        handleSendEmoji,
        messageContent,
        resolvedEmojiList,
        isPopupForReaction,
        selectedMessageId,
        replyingTo,
        replyToMessageId,
        replyToUserDisplayName,
        toggleReaction,
        currentUserId,
        handleDontReply
      };
    }
  });
</script>

<style scoped>
  .chat-container {
    display: flex;
    flex-direction: column;
    height: 100%;
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
    position:absolute;
    z-index:50;
    display: flex;
    height: 90%;
    width: 63%;
    border: 2px dashed #ccc;
    padding: 20px;
    text-align: center;
    margin: 20px;
    background: var(--vt-c-black);
    opacity:0.8;
    align-items: center;
    justify-content: center;
    transition: 0.2s ease-in-out;
    font-size:48px; 
    font-weight:bold;
    /* pointer-events: none; */
  }
</style>
