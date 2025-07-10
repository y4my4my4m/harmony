<!-- MonyContent - Render ActivityPub post content with rich formatting -->
<template>
  <div class="mony-content" v-html="formattedContent"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  content: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'user-mention-click': [handle: string];
  'hashtag-click': [tag: string];
}>();

const formattedContent = computed(() => {
  let formatted = props.content;
  
  // Format hashtags
  formatted = formatted.replace(/#(\w+)/g, '<span class="hashtag" data-tag="$1">#$1</span>');
  
  // Format mentions
  formatted = formatted.replace(/@(\w+)(?:@([^\s]+))?/g, '<span class="mention" data-handle="@$1$2">@$1$2</span>');
  
  // Format line breaks
  formatted = formatted.replace(/\n/g, '<br>');
  
  // Format URLs
  formatted = formatted.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="url-link">$1</a>');
  
  return formatted;
});
</script>

<style scoped>
.mony-content {
  line-height: 1.6;
  word-wrap: break-word;
}

.mony-content :deep(.hashtag) {
  color: #3b82f6;
  font-weight: 500;
  cursor: pointer;
}

.mony-content :deep(.hashtag:hover) {
  text-decoration: underline;
}

.mony-content :deep(.mention) {
  color: #10b981;
  font-weight: 500;
  cursor: pointer;
}

.mony-content :deep(.mention:hover) {
  text-decoration: underline;
}

.mony-content :deep(.url-link) {
  color: #3b82f6;
  text-decoration: underline;
}

.mony-content :deep(.url-link:hover) {
  color: #2563eb;
}
</style>
