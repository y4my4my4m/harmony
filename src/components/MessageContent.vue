<template>
    <div v-if="editableMessageId !== message.id" class="message-content">
        <template v-for="(part, partIndex) in message.content" :key="partIndex">
        <a v-if="typeof part === 'object' && part.url" :href="part.url" target="_blank">{{ part.url }}</a>
        <span v-else-if="typeof part === 'object' && part.mention" class="mention" @click="showUserProfile(part.userId, $event)">{{ part.mention }}</span>
        <img v-else-if="typeof part === 'object' && part.emoji"
            class="emoji-icon"
            :class="{ 'single': isSingleEmojiMessage }"
            :src="part.emoji.url"
            :alt="part.emoji.name"
            :title="`:${part.emoji.name}:`" />
        <span v-else>{{ part }}</span>
        </template>
    </div>
    <input v-else type="text" v-model="editableMessageContent" @keyup.esc="cancelEdit" @keyup.enter="saveEdit(message.id)" class="edit-input" />
</template>
  
<script lang="ts">
  import { defineComponent } from 'vue';
  import type { PropType } from 'vue';
  import type { ParsedMessage } from '@/types'; // Adjust this import based on your actual types
  
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
      editableMessageContent: String,
      saveEdit: Function,
      cancelEdit: Function,
      showUserProfile: Function
    }
  });
  </script>
  
  <style scoped>
  /* Add your styles for message content here */
  </style>
  