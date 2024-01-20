<template>
  <div v-if="editableMessageId !== message.id" class="message-content">
      <template v-for="(part, partIndex) in message.content" :key="partIndex">
          <a v-if="typeof part === 'object' && part.url" :href="part.url" target="_blank">{{ part.url }}</a>
          <span v-else-if="typeof part === 'object' && part.mention" class="mention">{{ part.mention }}</span>
          <img v-else-if="typeof part === 'object' && part.emoji"
              class="emoji-icon"
              :class="{ 'single': isSingleEmojiMessage }"
              :src="part.emoji.url"
              :alt="part.emoji.name"
              :title="`:${part.emoji.name}:`" />
          <span v-else>{{ part }}</span>
      </template>
  </div>
  <input v-else type="text" v-model="localEditableContent" @keyup.esc="cancelEdit" @keyup.enter="saveEdit" class="edit-input" />
</template>

<script lang="ts">
import { defineComponent, watch, ref } from 'vue';
import type { ParsedMessage, Emoji } from '@/types';
import type { PropType } from 'vue';

export default defineComponent({
  name: 'MessageContent',
  props: {
      message: {
          type: Object as PropType<ParsedMessage>,
          required: true
      },
      editableMessageId: {
          type: String as PropType<string | null>,
          default: null
      },
      isSingleEmojiMessage: Boolean,
      editableMessageContent: {
          type: String,
          default: ''
      },
      saveEdit: Function,
      cancelEdit: Function,
      showUserProfile: Function
  },
  emits: ['update:message', 'update:content', 'cancel-edit'],
  setup(props, { emit }) {
    const localEditableContent = ref(props.editableMessageContent);

    watch(() => props.editableMessageContent, (newVal) => {
      localEditableContent.value = newVal;
    });

    const handleInput = (event: Event) => {
      emit('update:content', (event.target as HTMLInputElement).value);
    };

    const saveEdit = () => {
      emit('update:message', props.message.id, localEditableContent.value); // Use localEditableContent here
    };


    const cancelEdit = () => {
      emit('cancel-edit');
    };

    return { 
      localEditableContent,
      handleInput,
      saveEdit, 
      cancelEdit
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
</style>
