<template>
  <div class="chat-container" 
       @dragover.prevent="showDragDropArea = true"
       @dragleave.prevent="showDragDropArea = false"
       @drop.prevent="triggerFileDrop">
    <div v-if="showDragDropArea" class="drag-drop-area">
      <div v-if="uploading" style="color:rgb(18, 143, 18);">Uploading...</div>
      <div v-else>Drop files here.</div>
    </div>

    <MessageDisplay 
      :messages="messages" 
      @loadMoreMessages="$emit('loadMoreMessages')" />

    <MessageInput 
      v-model="messageContent"
      :giphyOpen="giphyOpen"
      @toggleGiphy="toggleGiphy"
      :emojiListOpen="emojiListOpen"
      @toggleEmojiList="toggleEmojiList"
      @sendMessage="handleSendMessage"
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
  import type { Message, Gif, Emoji } from '@/types';
  import { handleFileDrop } from '@/services/fileService';
  import { listen } from '@tauri-apps/api/event';
  import { readBinaryFile } from '@tauri-apps/api/fs';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import GifComponent from '@/components/GifComponent.vue';
  import EmojiPopup from '@/components/EmojiPopup.vue';
  // FIXME: probably breaking the __TAURI__ implementation if we declare it here
  declare const __TAURI__: any;
  
  export default defineComponent({
    components: {
      MessageDisplay,
      MessageInput,
      GifComponent,
      EmojiPopup
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
      const showDragDropArea = ref(false);
      const uploading = ref(false);
      const emojiListOpen = ref(false);
      const giphyOpen = ref(false);
      const messageContent = ref('');

      // let unlisten: UnlistenFn | null = null;
      // Computed property to check if running in Tauri
      const isTauri = computed(() => {
        return typeof __TAURI__ !== 'undefined';
      });
      const gifIconClicked = ref(false);
      const emojiIconClicked = ref(false);

      const toggleEmojiList = () => {
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
                    "", // No additional content, just the file
                    fileUrl // URL of the uploaded file
                );
                uploading.value = false;
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
      const handleSendMessage = (content: string) => {
        if (authStore.session?.user && serverChannelStore.currentChannelId) {
          chatStore.sendMessage(serverChannelStore.currentChannelId, authStore.session.user.id, content);
        }
        messageContent.value = ''; 
      };
      // watch(() => props.messages, (newMessages) => {
      //   console.log("Received messages:", newMessages);
      // }, { deep: true });
      const handleSendGif = (gif: Gif ) => {
        const gifUrl = gif.media_formats.gif.url;
        closeGiphy();
        // console.log("Sending GIF URL:", gifUrl);
        if (serverChannelStore.currentChannelId && authStore.session?.user) {
          chatStore.sendMessage(serverChannelStore.currentChannelId, authStore.session.user.id, "", gifUrl);
        }
      };
      const handleSendEmoji = (emoji: Emoji) => {
        closeEmojiList();
        // Append emoji id to the existing message content
        messageContent.value += `:${emoji.id}:`;
        console.log("Emoji added in Parent:", messageContent.value);
      };
      const updateMessageContent = (newContent: string) => {
        messageContent.value = newContent;
      };

      // watch(messageContent, (newValue) => {
      //   console.log("messageContent updated in Parent:", newValue);
      // });

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
        updateMessageContent,
      };
    }
  });
</script>

<style scoped>
  .chat-container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
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
    opacity:0.25;
    align-items: center;
    justify-content: center;
    transition: 0.2s ease-in-out;
    font-size:48px; 
    font-weight:bold
  }
  .drag-drop-area:hover {
    opacity:0.8;
  }
</style>
