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

// Basic content formatting
const formattedContent = computed(() => {
  let formatted = props.content;
  
  // Convert newlines to <br> tags
  formatted = formatted.replace(/\n/g, '<br>');
  
  // Convert mentions (@username@domain or @username)
  formatted = formatted.replace(
    /@([a-zA-Z0-9_.-]+)(?:@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))?/g,
    '<a href="/u/@$1$2" class="mention">@$1$2</a>'
  );
  
  // Convert hashtags
  formatted = formatted.replace(
    /#([a-zA-Z0-9_-]+)/g,
    '<a href="/tags/$1" class="hashtag">#$1</a>'
  );
  
  // Convert URLs
  formatted = formatted.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="link">$1</a>'
  );
  
  return formatted;
});
</script>

<style scoped>
.mony-content {
  line-height: 1.5;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.mony-content :deep(.mention) {
  color: var(--h-brand, #5865f2);
  text-decoration: none;
  font-weight: 500;
}

.mony-content :deep(.mention:hover) {
  text-decoration: underline;
}

.mony-content :deep(.hashtag) {
  color: #1d9bf0;
  text-decoration: none;
  font-weight: 500;
}

.mony-content :deep(.hashtag:hover) {
  text-decoration: underline;
}

.mony-content :deep(.link) {
  color: #00b4d8;
  text-decoration: none;
}

.mony-content :deep(.link:hover) {
  text-decoration: underline;
}

.mony-content :deep(br) {
  margin: 0.25rem 0;
}
</style>
