<template>
  <div v-if="editableMessageId !== messageId" class="message-content">
    <template v-for="(part, partIndex) in content" :key="partIndex">
      <span v-if="part.type === 'text'">{{ part.text }}</span>
      <a v-else-if="part.type === 'url'" :href="part.url" target="_blank">{{ part.url }}</a>
      <span v-else-if="part.type === 'mention'" class="mention">{{ part.mention }}</span>
      <img v-else-if="part.type === 'emoji'"
           class="emoji-icon"
           :class="{ 'single': isSingleEmojiMessage }"
           :src="part.emoji.url"
           :alt="part.emoji.name"
           :title="`:${part.emoji.name}:`" />
      <div v-else-if="part.type === 'file' && part.fileType === 'image'" class="file-container">
        <div v-if="!imageLoaded[part.url]" class="image-skeleton"></div>
        <img
          :src="part.url"
          @load="$emit('image-loaded', part.url)"
          @click="$emit('open-lightbox', part.url)"
          v-show="imageLoaded[part.url]" />
      </div>
    </template>
  </div>
  <input v-else type="text" v-model="localEditableContent" @keyup.esc="handleCancelEdit" @keyup.enter="handleSaveEdit" class="edit-input" />
</template>

<script lang="ts">
import { defineComponent, watch, ref } from 'vue';
import type { PropType } from 'vue';
import type { MessagePart } from '@/types';

export default defineComponent({
  name: 'MessageContent',
  props: {
    content: {
      type: Array as PropType<MessagePart[]>,
      required: true
    },
    editableMessageId: {
      type: String as PropType<string | null>,
      default: null
    },
    messageId: {
      type: String,
      required: true
    },
    imageLoaded: Object as PropType<Record<string, boolean>>,
    isSingleEmojiMessage: Boolean,
    editableMessageContent: {
      type: String,
      default: ''
    },
    saveEdit: Function,
    cancelEdit: Function,
    showUserProfile: Function
  },
  emits: ['update:message', 'update:content', 'cancel-edit', 'image-loaded', 'open-lightbox'],
  setup(props, { emit }) {
    const localEditableContent = ref(props.editableMessageContent);

    watch(() => props.editableMessageContent, (newVal) => {
      localEditableContent.value = newVal;
    });

    const handleSaveEdit = () => {
      try {
        const editedContent = JSON.stringify(props.content); // Updated to use props.content
        emit('update:message', props.messageId, editedContent);
      } catch (e) {
        console.error('Error in handleSaveEdit:', e);
      }
    };

    const handleCancelEdit = () => {
      emit('cancel-edit');
    };

    return { 
      localEditableContent,
      handleSaveEdit, 
      handleCancelEdit
    };
  }
});
</script>


<style scoped>
.emoji-icon  {
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
.file-container {
  margin-top: 5px;
}

.message-header + .file-container{
  padding-left: 46px
}
.file-container > img {
  height: 100%;
  width: auto;
  max-height: 256px;
  border-radius: 5px;
  cursor: pointer;
  transition: transform 0.2s ease-in-out;
}

.file-container img:hover {
  transform: scale(1.05);
}

</style>
